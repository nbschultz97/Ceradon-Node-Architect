from __future__ import annotations

import copy
import json
import pathlib
from typing import Dict, Iterable, List, Optional, Tuple

from .data_loader import find_by_id
from .models import Host, NodeBuild, Radio, Sensor

SCHEMA_VERSION = "mission_project_v1"


def _derive_rf_bands(radio: Radio) -> List[str]:
    if radio.bands:
        return [band.lower().replace("/", "_") for band in radio.bands]
    if radio.band:
        return [radio.band.lower().replace("/", "_")]
    return []


def _build_platform(host: Host) -> Dict:
    return {
        "id": f"platform-{host.id}",
        "name": host.name,
        "role": "compute",
        "origin_tool": "node",
        "specs": {
            "cpu": host.cpu,
            "ram_gb": host.ram_gb,
            "storage": host.storage,
            "power_idle_w": host.power_w_idle,
            "power_load_w": host.power_w_load,
            "weight_kg": host.weight_kg,
        },
    }


def _build_node(
    node_id: str,
    name: str,
    build: NodeBuild,
    estimate,
    roles: List[str],
    notes: str,
    altitude_band: str,
    temperature_band: str,
    location: Optional[Dict[str, float]] = None,
    origin_tool: str = "node",
) -> Dict:
    rf_bands = _derive_rf_bands(build.radio)
    node_entry = {
        "id": node_id,
        "name": name,
        "origin_tool": origin_tool,
        "platform_id": f"platform-{build.host.id}",
        "roles": roles,
        "rf_bands": rf_bands,
        "power_profile": {
            "estimated_draw_w": estimate.total_power_w,
            "ideal_runtime_h": estimate.runtime_hours,
            "adjusted_runtime_h": estimate.runtime_hours,
            "capacity_factor": 1.0,
        },
        "battery": {
            "id": build.battery.id,
            "capacity_wh": build.battery.capacity_wh,
            "chemistry": build.battery.chemistry,
        },
        "environment": {
            "propagation": build.environment,
            "altitude_band": altitude_band,
            "temperature_band": temperature_band,
        },
        "capabilities": estimate.capabilities,
        "recommended_role": estimate.recommended_role,
        "parts": {
            "host_id": build.host.id,
            "battery_id": build.battery.id,
            "rf_chains": [
                {
                    "radio_id": build.radio.id,
                    "antenna_id": build.antenna.id,
                }
            ],
            "sensor_ids": [sensor.id for sensor in build.sensors],
        },
        "notes": notes,
    }
    if location:
        node_entry["location"] = location
    if estimate.range_km is not None:
        node_entry.setdefault("mesh_hints", []).append(
            {
                "band": rf_bands[0] if rf_bands else build.radio.radio_type,
                "estimated_range_km": estimate.range_km,
            }
        )
    return node_entry


def assemble_project(
    builds: Iterable[Tuple[str, NodeBuild, object, List[str], str, Dict[str, float]]],
    mission: Optional[Dict] = None,
    environment: Optional[Dict] = None,
    constraints: Optional[List[Dict]] = None,
    kits: Optional[List[Dict]] = None,
    mesh_links: Optional[List[Dict]] = None,
) -> Dict:
    platforms: Dict[str, Dict] = {}
    nodes: List[Dict] = []

    for node_id, build, estimate, roles, label, location in builds:
        platform_entry = _build_platform(build.host)
        platforms[platform_entry["id"]] = platform_entry
        nodes.append(
            _build_node(
                node_id=node_id,
                name=label or node_id,
                build=build,
                estimate=estimate,
                roles=roles,
                notes=label,
                altitude_band=location.get("altitude_band", "band_2000_3000") if location else "band_2000_3000",
                temperature_band=location.get("temperature_band", "cold") if location else "cold",
                location={k: v for k, v in (location or {}).items() if k in {"lat", "lon", "elevation_m"}},
            )
        )

    project = {
        "schema": SCHEMA_VERSION,
        "origin_tool": "node",
        "generated_at": None,
        "mission": mission or {},
        "environment": environment or {},
        "constraints": constraints or [],
        "platforms": list(platforms.values()),
        "nodes": nodes,
        "mesh_links": mesh_links or [],
        "kits": kits or [],
    }
    return project


def parse_project(path: pathlib.Path) -> Dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _match_component(items: List, identifier: str):
    try:
        return find_by_id(items, identifier)
    except ValueError:
        return None


def project_to_builds(project: Dict, inventory: Dict[str, List]) -> Tuple[List[NodeBuild], List[str]]:
    builds: List[NodeBuild] = []
    warnings: List[str] = []
    for node in project.get("nodes", []):
        parts = node.get("parts", {})
        host = _match_component(inventory.get("hosts", []), parts.get("host_id"))
        radio = None
        antenna = None
        sensors: List[Sensor] = []
        rf_chains = parts.get("rf_chains") or []
        if rf_chains:
            radio = _match_component(inventory.get("radios", []), rf_chains[0].get("radio_id"))
            antenna = _match_component(inventory.get("antennas", []), rf_chains[0].get("antenna_id"))
        battery = _match_component(inventory.get("batteries", []), parts.get("battery_id"))
        for sid in parts.get("sensor_ids", []):
            sensor = _match_component(inventory.get("sensors", []), sid)
            if sensor:
                sensors.append(sensor)
            else:
                warnings.append(f"Missing sensor '{sid}' for node {node.get('id')}")
        if not all([host, radio, antenna, battery]):
            warnings.append(
                f"Skipping node {node.get('id')} due to missing components (host/radio/antenna/battery)"
            )
            continue
        build = NodeBuild(
            host=host,
            radio=radio,
            antenna=antenna,
            battery=battery,
            sensors=sensors,
            environment=(node.get("environment") or {}).get("propagation", "rural_open"),
        )
        builds.append(build)
    return builds, warnings


def to_geojson(project: Dict) -> Dict:
    features: List[Dict] = []

    node_lookup = {node.get("id"): node for node in project.get("nodes", [])}

    for node in project.get("nodes", []):
        loc = node.get("location") or {}
        if "lat" in loc and "lon" in loc:
            coordinates = [loc["lon"], loc["lat"]]
            if "elevation_m" in loc:
                coordinates.append(loc["elevation_m"])
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": coordinates},
                    "properties": {
                        "id": node.get("id"),
                        "name": node.get("name"),
                        "origin_tool": node.get("origin_tool", project.get("origin_tool", "node")),
                        "roles": node.get("roles", []),
                        "recommended_role": node.get("recommended_role"),
                        "rf_bands": node.get("rf_bands", []),
                        "power_draw_w": (node.get("power_profile") or {}).get("estimated_draw_w"),
                        "runtime_h": (node.get("power_profile") or {}).get("adjusted_runtime_h"),
                    },
                }
            )

    for link in project.get("mesh_links", []):
        start = node_lookup.get(link.get("from_node", ""), {}).get("location")
        end = node_lookup.get(link.get("to_node", ""), {}).get("location")
        if start and end and "lat" in start and "lon" in start and "lat" in end and "lon" in end:
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [
                            [start["lon"], start["lat"], start.get("elevation_m")],
                            [end["lon"], end["lat"], end.get("elevation_m")],
                        ],
                    },
                    "properties": {
                        "id": link.get("id"),
                        "origin_tool": link.get("origin_tool", project.get("origin_tool", "node")),
                        "band": link.get("band"),
                        "estimated_range_km": link.get("estimated_range_km"),
                    },
                }
            )

    return {"type": "FeatureCollection", "features": features}


def to_cot_stub(project: Dict) -> List[Dict]:
    events: List[Dict] = []
    for node in project.get("nodes", []):
        loc = node.get("location") or {}
        if "lat" not in loc or "lon" not in loc:
            continue
        events.append(
            {
                "uid": node.get("id"),
                "type": "a-f-G-U-C",
                "how": "m-g",
                "lat": loc["lat"],
                "lon": loc["lon"],
                "hae": loc.get("elevation_m"),
                "name": node.get("name"),
                "role": node.get("recommended_role"),
                "remarks": f"rf: {','.join(node.get('rf_bands', []))} | origin: {node.get('origin_tool', project.get('origin_tool', 'node'))}",
            }
        )
    return events


def merge_unknown_fields(original: Dict, updated: Dict) -> Dict:
    merged = copy.deepcopy(original)
    merged.update(updated)
    return merged
