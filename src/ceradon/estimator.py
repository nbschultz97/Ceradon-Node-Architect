from __future__ import annotations

import math
from typing import List, Tuple

from .models import Antenna, Battery, EstimateResult, Host, NodeBuild, Radio, Sensor

RANGE_BASELINE_KM = {
    "wifi": 0.25,
    "lora": 5.0,
    "analog_fpv": 1.0,
    "sdr": 2.0,
}


def estimate_power(host: Host, radio: Radio, sensors: List[Sensor]) -> float:
    sensor_draw = sum(sensor.power_w for sensor in sensors)
    total_power = host.power_w + radio.power_w + sensor_draw
    return round(total_power, 2)


def estimate_runtime_hours(battery: Battery, load_w: float) -> float:
    if load_w <= 0:
        return float("inf")
    hours = battery.capacity_wh / load_w
    return round(hours, 2)


def _antenna_gain_km_modifier(antenna: Antenna, radio: Radio) -> float:
    # coarse mapping from gain to range multiplier; directional antennas amplify more
    gain = antenna.gain_db + radio.antenna_gain_db
    if antenna.pattern != "omni":
        gain += 2.0
    if gain <= 2:
        return 1.0
    if gain <= 6:
        return 1.5
    if gain <= 10:
        return 2.5
    return 4.0


def estimate_range_km(radio: Radio, antenna: Antenna) -> float:
    baseline = RANGE_BASELINE_KM.get(radio.radio_type.lower(), 0.5)
    multiplier = _antenna_gain_km_modifier(antenna, radio)
    range_km = baseline * multiplier
    return round(range_km, 2)


def derive_capabilities(host: Host, radio: Radio, sensors: List[Sensor]) -> Tuple[List[str], List[str]]:
    capabilities: List[str] = []
    notes: List[str] = []

    radio_type = radio.radio_type.lower()

    if radio_type == "wifi":
        capabilities.append("WiFi recon & AP survey")
        if radio.supports_csi:
            capabilities.append("CSI collection (pose-ready)")
        if any(sensor.sensor_type == "camera" for sensor in sensors):
            capabilities.append("Video streaming / FPV relay")
    elif radio_type == "lora":
        capabilities.append("LoRa telemetry & low-rate control")
    elif radio_type == "analog_fpv":
        capabilities.append("Analog FPV downlink/relay")
    elif radio_type == "sdr":
        capabilities.append("Wideband SDR sensing")
    else:
        capabilities.append(f"{radio.radio_type} link")

    if any(sensor.sensor_type == "gps" for sensor in sensors):
        capabilities.append("GPS time/location stamping")
    if any(sensor.sensor_type == "imu" for sensor in sensors):
        capabilities.append("Orientation / motion logging")

    if host.cpu.lower().startswith("intel") and radio.supports_csi:
        notes.append("Host strong enough for CSI pose models like WiPose")
    elif radio.supports_csi:
        notes.append("CSI available; keep models lightweight (Jetson/RPi)")

    return capabilities, notes


def recommended_role(capabilities: List[str], runtime_hours: float, range_km: float) -> str:
    if any("CSI" in cap for cap in capabilities):
        return "CSI-enabled pose / through-wall situational awareness"
    if any("LoRa" in cap for cap in capabilities):
        return "Long-haul telemetry / sensor beacon"
    if any("SDR" in cap for cap in capabilities):
        return "Spectrum scout / RF surveyor"
    if runtime_hours > 12 and range_km >= 2:
        return "Endurance ISR node"
    if runtime_hours < 4:
        return "Burst recon / short-mission scout"
    return "Balanced multi-role field node"


def estimate_node(build: NodeBuild) -> EstimateResult:
    total_power = estimate_power(build.host, build.radio, build.sensors)
    runtime_hours = estimate_runtime_hours(build.battery, total_power)
    range_km = estimate_range_km(build.radio, build.antenna)
    capabilities, notes = derive_capabilities(build.host, build.radio, build.sensors)
    role = recommended_role(capabilities, runtime_hours, range_km)

    note_text = "; ".join(notes) if notes else None

    return EstimateResult(
        total_power_w=total_power,
        runtime_hours=runtime_hours,
        range_km=range_km,
        capabilities=capabilities,
        recommended_role=role,
        notes=note_text,
    )


def format_report(build: NodeBuild, estimate: EstimateResult) -> str:
    lines = ["Ceradon Node Architect Report", "==============================", ""]
    lines.append("Selected stack:")
    for key, value in build.as_dict().items():
        lines.append(f"- {key.capitalize()}: {value}")
    lines.append("")
    lines.append("Estimates:")
    lines.append(f"- Total power draw: {estimate.total_power_w:.2f} W")
    lines.append(f"- Runtime (est.): {estimate.runtime_hours:.2f} hours")
    lines.append(f"- Link range (est.): {estimate.range_km:.2f} km")
    lines.append("- Capabilities:")
    for cap in estimate.capabilities:
        lines.append(f"  - {cap}")
    lines.append(f"- Recommended role: {estimate.recommended_role}")
    if estimate.notes:
        lines.append(f"- Notes: {estimate.notes}")
    return "\n".join(lines)
