from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class Component:
    id: str
    name: str
    category: str
    power_w: float = 0.0
    notes: str = ""


@dataclass
class Host(Component):
    cpu: str = ""
    ram_gb: float = 0.0
    storage: str = ""
    os: str = "Linux"
    ports: List[str] = field(default_factory=list)
    weight_kg: float = 0.0


@dataclass
class Radio(Component):
    band: str = ""
    radio_type: str = ""
    modulation: str = ""
    max_power_dbm: float = 20.0
    antenna_gain_db: float = 0.0
    supports_csi: bool = False


@dataclass
class Antenna(Component):
    gain_db: float = 0.0
    pattern: str = "omni"
    polarization: str = ""


@dataclass
class Battery(Component):
    capacity_wh: float = 0.0
    chemistry: str = ""
    output_voltage: float = 12.0
    mass_kg: float = 0.0


@dataclass
class Sensor(Component):
    sensor_type: str = ""
    interface: str = ""


@dataclass
class NodeBuild:
    host: Host
    radio: Radio
    antenna: Antenna
    battery: Battery
    sensors: List[Sensor] = field(default_factory=list)

    def as_dict(self) -> Dict[str, str]:
        return {
            "host": self.host.name,
            "radio": self.radio.name,
            "antenna": self.antenna.name,
            "battery": self.battery.name,
            "sensors": ", ".join(sensor.name for sensor in self.sensors) or "None",
        }


@dataclass
class EstimateResult:
    total_power_w: float
    runtime_hours: float
    range_km: float
    capabilities: List[str]
    recommended_role: str
    notes: Optional[str] = None

    def as_dict(self) -> Dict[str, str]:
        return {
            "total_power_w": f"{self.total_power_w:.2f}",
            "runtime_hours": f"{self.runtime_hours:.2f}",
            "range_km": f"{self.range_km:.2f}",
            "capabilities": ", ".join(self.capabilities),
            "recommended_role": self.recommended_role,
            "notes": self.notes or "",
        }
