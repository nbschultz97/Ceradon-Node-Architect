from __future__ import annotations

import copy
import json
import pathlib
from typing import Dict, Iterable, List, Optional, Tuple

from .data_loader import find_by_id
from .models import Host, NodeBuild, Radio, Sensor

SCHEMA_VERSION = "2.0.0"
LEGACY_SCHEMA_TAG = "mission_project_v1"

BATTERY_CAPACITY_FACTOR = {
    "sea_level": {"hot": 1.0, "temperate": 1.0, "cold": 0.95, "very_cold": 0.9},
    "band_1000_2000": {"hot": 0.95, "temperate": 0.93, "cold": 0.88, "very_cold": 0.82},
    "band_2000_3000": {"hot": 0.9, "temperate": 0.88, "cold": 0.82, "very_cold": 0.76},
    "above_3000": {"hot": 0.85, "temperate": 0.82, "cold": 0.75, "very_cold": 0.7},
}


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
    cap_factor = BATTERY_CAPACITY_FACTOR.get(altitude_band, {}).get(temperature_band, 1.0)
    adjusted_runtime_h = round(estimate.runtime_hours * cap_factor, 2)
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
            "adjusted_runtime_h": adjusted_runtime_h,
            "capacity_factor": cap_factor,
        },
        "environment": {
            "propagation": build.environment,
            "altitude_band": altitude_band,
            "temperature_band": temperature_band,
        },
        "capabilities": estimate.capabilities,
        "recommended_role": estimate.recommended_role,
        "host_type": {"id": build.host.id, "name": build.host.name, "tags": build.host.tags},
        "radios": [
            {
                "id": build.radio.id,
                "name": build.radio.name,
                "radio_type": build.radio.radio_type,
                "bands": build.radio.bands,
            }
        ],
        "antennas": [
            {
                "id": build.antenna.id,
                "name": build.antenna.name,
                "gain_dbi": build.antenna.gain_dbi,
                "pattern": build.antenna.pattern,
            }
        ],
        "battery": {
            "id": build.battery.id,
            "capacity_wh": build.battery.capacity_wh,
            "chemistry": build.battery.chemistry,
            "tags": build.battery.tags,
        },
        "sensors": [
            {"id": sensor.id, "name": sensor.name, "type": sensor.sensor_type, "tags": sensor.tags}
            for sensor in build.sensors
        ],
        "estimated_runtime_min": round(adjusted_runtime_h * 60, 1),
        "environment_assumptions": {
            "propagation": build.environment,
            "altitude_band": altitude_band,
            "temperature_band": temperature_band,
        },
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


def assemble_node_bundle(
    builds: Iterable[Tuple[str, NodeBuild, object, List[str], str, Dict[str, float]]],
    altitude_band: str = "band_2000_3000",
    temperature_band: str = "cold",
    mission: Optional[Dict] = None,
    schema_version: str = SCHEMA_VERSION,
) -> Dict:
    """Assemble a lightweight MissionProject schema payload with only nodes/platforms.

    This keeps the shape aligned to the MissionProject v2.0.0 schema while focusing on
    the modeled nodes. It is meant for downstream tools that want a clean bundle of
    nodes without extra mission scaffolding.
    """

    platforms: Dict[str, Dict] = {}
    nodes: List[Dict] = []

    for node_id, build, estimate, roles, label, location in builds:
        platform_entry = _build_platform(build.host)
        platforms[platform_entry["id"]] = platform_entry
        node_location = {k: v for k, v in (location or {}).items() if k in {"lat", "lon", "elevation_m"}}
        node_altitude = (location or {}).get("altitude_band", altitude_band)
        node_temperature = (location or {}).get("temperature_band", temperature_band)
        nodes.append(
            _build_node(
                node_id=node_id,
                name=label or node_id,
                build=build,
                estimate=estimate,
                roles=roles,
                notes=label,
                altitude_band=node_altitude,
                temperature_band=node_temperature,
                location=node_location,
            )
        )

    return {
        "schemaVersion": schema_version,
        "meta": {"origin_tool": "node"},
        "origin_tool": "node",
        "mission": mission or {},
        "platforms": list(platforms.values()),
        "nodes": nodes,
    }


def assemble_project(
    builds: Iterable[Tuple[str, NodeBuild, object, List[str], str, Dict[str, float]]],
    mission: Optional[Dict] = None,
    environment: Optional[Dict] = None,
    constraints: Optional[List[Dict]] = None,
    kits: Optional[List[Dict]] = None,
    mesh_links: Optional[List[Dict]] = None,
    schema_version: str = SCHEMA_VERSION,
) -> Dict:
    schema_version = schema_version or SCHEMA_VERSION
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
        "schemaVersion": SCHEMA_VERSION if schema_version == SCHEMA_VERSION else schema_version,
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

    if schema_version != SCHEMA_VERSION:
        project["schema"] = schema_version

    return project


def parse_project(path: pathlib.Path) -> Dict:
    with path.open("r", encoding="utf-8") as handle:
        project = json.load(handle)
    if project.get("schemaVersion") != SCHEMA_VERSION:
        project = upgrade_project_schema(project)
    return project


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


def upgrade_project_schema(project: Dict) -> Dict:
    legacy = copy.deepcopy(project)
    upgraded = copy.deepcopy(project)

    upgraded["schemaVersion"] = SCHEMA_VERSION
    upgraded.setdefault("mission", legacy.get("mission", {}))
    upgraded.setdefault("environment", legacy.get("environment", {}))
    upgraded.setdefault("constraints", legacy.get("constraints", []))
    upgraded.setdefault("platforms", legacy.get("platforms", []))
    upgraded.setdefault("nodes", legacy.get("nodes", []))
    upgraded.setdefault("mesh_links", legacy.get("mesh_links", []))
    upgraded.setdefault("kits", legacy.get("kits", []))
    upgraded.setdefault("origin_tool", legacy.get("origin_tool", "node"))

    for node in upgraded.get("nodes", []):
        node.setdefault("origin_tool", upgraded.get("origin_tool", "node"))
        environment = node.get("environment") or node.get("environment_assumptions") or {}
        node.setdefault("environment", environment)
        node.setdefault("environment_assumptions", environment)
        if "estimated_runtime_min" not in node and (node.get("power_profile") or {}).get("adjusted_runtime_h"):
            node["estimated_runtime_min"] = round(
                (node.get("power_profile") or {}).get("adjusted_runtime_h", 0) * 60, 1
            )
        if "host_type" not in node:
            parts = node.get("parts") or {}
            host_id = parts.get("host_id")
            if host_id:
                node["host_type"] = {"id": host_id, "name": parts.get("host_name", host_id), "tags": parts.get("host_tags", [])}

    return merge_unknown_fields(project, upgraded)
