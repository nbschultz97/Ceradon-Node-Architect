from __future__ import annotations

import json
import pathlib
from typing import Dict, List

from .models import Antenna, Battery, Host, Radio, Sensor

DEFAULT_DATA_PATH = pathlib.Path(__file__).resolve().parents[2] / "data" / "default_components.json"


def _load_json(path: pathlib.Path) -> Dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_components(path: pathlib.Path = DEFAULT_DATA_PATH) -> Dict[str, List]:
    data = _load_json(path)

    hosts = [Host(**item, category="host") for item in data.get("hosts", [])]
    radios = [Radio(**item, category="radio") for item in data.get("radios", [])]
    antennas = [Antenna(**item, category="antenna") for item in data.get("antennas", [])]
    batteries = [Battery(**item, category="battery") for item in data.get("batteries", [])]
    sensors = [Sensor(**item, category="sensor") for item in data.get("sensors", [])]

    return {
        "hosts": hosts,
        "radios": radios,
        "antennas": antennas,
        "batteries": batteries,
        "sensors": sensors,
    }


def find_by_id(items, identifier: str):
    for item in items:
        if item.id == identifier:
            return item
    raise ValueError(f"No component with id '{identifier}' found")
