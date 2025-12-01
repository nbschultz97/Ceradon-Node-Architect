from __future__ import annotations

from typing import List, Tuple

from .models import Antenna, Battery, EstimateResult, Host, NodeBuild, Radio, Sensor

# Environment multipliers keep the math lightweight but make intent explicit
ENVIRONMENT_MULTIPLIERS = {
    "lab": 0.8,
    "urban_indoor": 0.3,
    "urban_outdoor": 0.6,
    "rural_open": 1.0,
    "subterranean": 0.2,
}

BASELINE_RANGE_KM = {
    "wifi_2_4": 0.15,  # ~150 m open
    "wifi_5": 0.08,  # ~80 m open
    "wifi_6": 0.08,
    "lora_0_9": 2.0,  # 2 km open
    "analog_fpv_5_8": 1.0,
    "sdr_generic": 0.5,
}


def _average_host_power(host: Host) -> float:
    if host.power_w_idle and host.power_w_load:
        return (host.power_w_idle + host.power_w_load) / 2
    return host.power_w or 0.0


def _average_radio_power(radio: Radio) -> float:
    if radio.power_w_tx and radio.power_w_rx:
        return (radio.power_w_tx + radio.power_w_rx) / 2
    return radio.power_w or 0.0


def estimate_power(host: Host, radio: Radio, sensors: List[Sensor], environment_factor: float = 1.0) -> float:
    """Approximate draw using average host and radio power plus sensor budget."""

    sensor_draw = sum(sensor.power_w for sensor in sensors)
    host_draw = _average_host_power(host)
    radio_draw = _average_radio_power(radio)

    total_power = (host_draw + radio_draw + sensor_draw) * environment_factor
    return round(total_power, 2)


def estimate_runtime_hours(battery: Battery, load_w: float) -> float:
    if load_w <= 0:
        return float("inf")
    hours = battery.capacity_wh / load_w
    return round(hours, 2)


def _antenna_gain_km_modifier(antenna: Antenna, radio: Radio) -> float:
    """Bucketed gain mapping to keep results deterministic and readable."""

    gain = antenna.gain_dbi + radio.antenna_gain_db
    if antenna.pattern not in {"omni", "whip"}:
        gain += 2.0  # directional boost without full link budget math

    if gain <= 2:
        return 1.0
    if gain <= 5:
        return 1.2
    if gain <= 9:
        return 1.5
    if gain <= 14:
        return 2.5
    return 3.5


def _environment_multiplier(environment: str) -> float:
    return ENVIRONMENT_MULTIPLIERS.get(environment, 1.0)


def _primary_band(radio: Radio) -> str:
    if radio.bands:
        return radio.bands[0].lower()
    return radio.band.lower()


def estimate_range_km(radio: Radio, antenna: Antenna, environment: str) -> Tuple[float, str]:
    radio_type = radio.radio_type.lower()
    band = _primary_band(radio)
    env_factor = _environment_multiplier(environment)

    # Baseline selection by radio type and band
    if radio_type == "wifi":
        if "2.4" in band:
            baseline = BASELINE_RANGE_KM["wifi_2_4"]
        else:
            baseline = BASELINE_RANGE_KM["wifi_5"]
    elif radio_type == "lora":
        baseline = BASELINE_RANGE_KM["lora_0_9"]
    elif radio_type == "analog_fpv":
        baseline = BASELINE_RANGE_KM["analog_fpv_5_8"]
    elif radio_type == "sdr":
        baseline = BASELINE_RANGE_KM["sdr_generic"]
    elif radio_type == "cellular":
        text = "Backhaul via 4G/5G network – local RF range depends on client WiFi/USB tether"
        return None, text
    else:
        baseline = 0.3

    multiplier = _antenna_gain_km_modifier(antenna, radio) * env_factor
    range_km = round(baseline * multiplier, 3)
    return range_km, f"Approx. {range_km:.2f} km in {environment.replace('_', ' ')}"


def derive_capabilities(host: Host, radio: Radio, sensors: List[Sensor]) -> Tuple[List[str], List[str]]:
    capabilities: List[str] = []
    notes: List[str] = []

    radio_type = radio.radio_type.lower()

    if radio_type == "wifi":
        if radio.supports_monitor:
            capabilities.append("WiFi recon / monitor mode scanning")
        else:
            capabilities.append("WiFi client/backhaul")
        if radio.supports_csi:
            capabilities.append("Potential WiFi CSI / channel analysis (driver support required)")
    elif radio_type == "lora":
        capabilities.append("LoRa telemetry / low-rate sensor network")
    elif radio_type == "analog_fpv":
        capabilities.append("Analog FPV video link")
    elif radio_type == "sdr":
        capabilities.append("SDR-based RF capture / analysis")
    elif radio_type == "cellular":
        capabilities.append("Cellular backhaul for remote deployment")
    else:
        capabilities.append(f"{radio.radio_type} link")

    sensor_types = [sensor.sensor_type.lower() for sensor in sensors]
    if "camera" in sensor_types:
        capabilities.append("Video capture")
    if "gps" in sensor_types:
        capabilities.append("GPS time/position reference")
    if "imu" in sensor_types:
        capabilities.append("IMU / motion sensing")
    if "environment" in sensor_types or "environmental" in sensor_types:
        capabilities.append("Environmental sensing (temp/humidity)")

    if host.cpu_score >= 8 and radio.supports_csi:
        notes.append("Host strong enough for CSI pose models like WiPose")
    elif radio.supports_csi:
        notes.append("CSI available; keep models lightweight (Jetson/RPi)")

    if radio_type == "cellular":
        notes.append("Assumes LTE/5G coverage for backhaul")

    return capabilities, notes


def recommended_role(capabilities: List[str], runtime_hours: float, radio: Radio, host: Host, sensors: List[Sensor]) -> str:
    """Simple, documented heuristics for fielding guidance."""

    radio_type = radio.radio_type.lower()
    has_camera = any(sensor.sensor_type.lower() == "camera" for sensor in sensors)
    has_wifi_monitor = radio_type == "wifi" and radio.supports_monitor
    has_wifi_csi = radio_type == "wifi" and radio.supports_csi
    has_decent_cpu = host.cpu_score >= 6
    has_high_cpu = host.cpu_score >= 8

    # WiFi + CSI + compute → experimental CSI / channel analysis
    if has_wifi_csi and has_high_cpu and runtime_hours >= 2:
        return "Experimental WiFi CSI / channel analysis node"

    # WiFi + monitor + decent CPU → recon mapping
    if has_wifi_monitor and has_decent_cpu and runtime_hours >= 2:
        return "Recon / RF mapping node"

    # LoRa + long runtime → perimeter/telemetry
    if radio_type == "lora" and runtime_hours >= 12:
        return "Low-power perimeter/telemetry node"

    # Analog FPV + camera → FPV payload
    if radio_type == "analog_fpv" and has_camera:
        return "FPV video relay / payload node"

    # SDR + compute → RF capture
    if radio_type == "sdr" and has_decent_cpu:
        return "RF capture / lab or field survey node"

    if radio_type == "cellular":
        return "Backhaul via LTE/5G; pair with WiFi/USB tether for clients"

    # Fallback based on endurance
    if runtime_hours > 12:
        return "Endurance ISR node"
    if runtime_hours < 4:
        return "Burst recon / short-mission scout"
    return "Balanced multi-role field node"


def estimate_node(build: NodeBuild) -> EstimateResult:
    env_factor = _environment_multiplier(build.environment)
    total_power = estimate_power(build.host, build.radio, build.sensors, env_factor)
    runtime_hours = estimate_runtime_hours(build.battery, total_power)
    range_km, range_text = estimate_range_km(build.radio, build.antenna, build.environment)
    capabilities, notes = derive_capabilities(build.host, build.radio, build.sensors)
    role = recommended_role(capabilities, runtime_hours, build.radio, build.host, build.sensors)

    note_text = "; ".join(notes) if notes else None

    return EstimateResult(
        total_power_w=total_power,
        runtime_hours=runtime_hours,
        range_km=range_km,
        range_text=range_text,
        capabilities=capabilities,
        recommended_role=role,
        notes=note_text,
    )


def format_report(build: NodeBuild, estimate: EstimateResult) -> str:
    lines = ["Ceradon Node Architect Report", "==============================", ""]
    lines.append("Selected stack:")
    for key, value in build.as_dict().items():
        lines.append(f"- {key.capitalize()}: {value}")
    lines.append(f"- Environment: {build.environment.replace('_', ' ')}")
    lines.append("")
    lines.append("Estimates:")
    lines.append(f"- Total power draw: {estimate.total_power_w:.2f} W")
    lines.append(f"- Runtime (est.): {estimate.runtime_hours:.2f} hours")
    if estimate.range_km is not None:
        lines.append(f"- Link range (est.): {estimate.range_km:.2f} km ({estimate.range_text})")
    else:
        lines.append(f"- Link capability: {estimate.range_text}")
    lines.append("- Capabilities:")
    for cap in estimate.capabilities:
        lines.append(f"  - {cap}")
    lines.append(f"- Recommended role: {estimate.recommended_role}")
    if estimate.notes:
        lines.append(f"- Notes: {estimate.notes}")
    return "\n".join(lines)
