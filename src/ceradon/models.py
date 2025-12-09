from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class Component:
    id: str
    name: str
    category: str
    power_w: float = 0.0
    tags: List[str] = field(default_factory=list)
    notes: str = ""


@dataclass
class Host(Component):
    cpu: str = ""
    ram_gb: float = 0.0
    storage: str = ""
    os: str = "Linux"
    ports: List[str] = field(default_factory=list)
    weight_kg: float = 0.0
    cpu_score: float = 0.0  # coarse performance indicator 1-10
    power_w_idle: float = 0.0
    power_w_load: float = 0.0
    os_options: List[str] = field(default_factory=list)
    max_rf_chains: int = 2

    def __post_init__(self):
        if self.power_w == 0.0 and self.power_w_idle and self.power_w_load:
            self.power_w = (self.power_w_idle + self.power_w_load) / 2
        if not self.os_options and self.os:
            self.os_options = [self.os]


@dataclass
class Radio(Component):
    band: str = ""
    bands: List[str] = field(default_factory=list)
    type: str = ""  # optional alias for radio_type
    radio_type: str = ""
    modulation: str = ""
    max_power_dbm: float = 20.0
    antenna_gain_db: float = 0.0
    supports_csi: bool = False
    supports_monitor: bool = False
    power_w_tx: float = 0.0
    power_w_rx: float = 0.0
    typ_tx_power_dbm: float = 0.0

    def __post_init__(self):
        if not self.radio_type and self.type:
            self.radio_type = self.type
        if not self.band and self.bands:
            self.band = ",".join(self.bands)
        if not self.bands and self.band:
            self.bands = [b.strip() for b in self.band.split("/") if b]
        if self.power_w == 0.0 and self.power_w_tx and self.power_w_rx:
            self.power_w = (self.power_w_tx + self.power_w_rx) / 2


@dataclass
class Antenna(Component):
    gain_db: float = 0.0
    gain_dbi: float = 0.0
    pattern: str = "omni"
    polarization: str = ""
    bands_supported: List[str] = field(default_factory=list)

    def __post_init__(self):
        if self.gain_db == 0.0 and self.gain_dbi:
            self.gain_db = self.gain_dbi
        if self.gain_dbi == 0.0 and self.gain_db:
            self.gain_dbi = self.gain_db


@dataclass
class Battery(Component):
    capacity_wh: float = 0.0
    chemistry: str = ""
    output_voltage: float = 12.0
    mass_kg: float = 0.0


@dataclass
class Sensor(Component):
    sensor_type: str = ""
    type: str = ""
    interface: str = ""

    def __post_init__(self):
        if not self.sensor_type and self.type:
            self.sensor_type = self.type


@dataclass
class NodeBuild:
    host: Host
    radio: Radio
    antenna: Antenna
    battery: Battery
    sensors: List[Sensor] = field(default_factory=list)
    environment: str = "rural_open"

    def as_dict(self) -> Dict[str, str]:
        return {
            "host": self.host.name,
            "radio": self.radio.name,
            "antenna": self.antenna.name,
            "battery": self.battery.name,
            "sensors": ", ".join(sensor.name for sensor in self.sensors) or "None",
            "environment": self.environment,
        }


@dataclass
class EstimateResult:
    total_power_w: float
    runtime_hours: float
    range_km: Optional[float]
    range_text: Optional[str]
    capabilities: List[str]
    recommended_role: str
    notes: Optional[str] = None

    def as_dict(self) -> Dict[str, str]:
        return {
            "total_power_w": f"{self.total_power_w:.2f}",
            "runtime_hours": f"{self.runtime_hours:.2f}",
            "range_km": "" if self.range_km is None else f"{self.range_km:.2f}",
            "range_text": self.range_text or "",
            "capabilities": ", ".join(self.capabilities),
            "recommended_role": self.recommended_role,
            "notes": self.notes or "",
        }
