from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Dict, List, Optional, Tuple

from .data_loader import find_by_id, load_components
from .estimator import estimate_node, format_report
from .models import NodeBuild
from .mission_project import (
    LEGACY_SCHEMA_TAG,
    assemble_node_bundle,
    assemble_project,
    parse_project,
    project_to_builds,
    to_cot_stub,
    to_geojson,
)

PRESET_DIR = pathlib.Path(__file__).resolve().parents[2] / "sample_builds"


def parse_build(config_path: pathlib.Path):
    inventory = load_components()
    with config_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    host = find_by_id(inventory["hosts"], data["host"])
    radio = find_by_id(inventory["radios"], data["radio"])
    antenna = find_by_id(inventory["antennas"], data["antenna"])
    battery = find_by_id(inventory["batteries"], data["battery"])
    sensor_ids: List[str] = data.get("sensors", [])
    sensors = [find_by_id(inventory["sensors"], sid) for sid in sensor_ids]
    environment = data.get("environment", "rural_open")

    return NodeBuild(
        host=host,
        radio=radio,
        antenna=antenna,
        battery=battery,
        sensors=sensors,
        environment=environment,
    )


def _build_and_estimate(config_path: pathlib.Path, environment_override: Optional[str] = None) -> Tuple[NodeBuild, object]:
    build = parse_build(config_path)
    if environment_override:
        build.environment = environment_override
    estimate = estimate_node(build)
    return build, estimate


def list_components():
    inventory = load_components()
    for key, items in inventory.items():
        print(f"{key.upper()}")
        for item in items:
            if key == "batteries":
                extra = f"{item.capacity_wh} Wh, {item.chemistry}"
            elif key == "antennas":
                extra = f"{item.gain_dbi} dBi, {item.pattern}"
            elif key == "radios":
                bands = item.band or "/".join(item.bands)
                extra = f"{item.radio_type}, {bands}"
            else:
                extra = item.notes or ""
            print(f"- {item.id}: {item.name} ({extra})")
        print("")


def simulate(config_path: pathlib.Path):
    build = parse_build(config_path)
    estimate = estimate_node(build)
    report = format_report(build, estimate)
    print(report)


def export_node_bundle(
    config_paths: List[pathlib.Path],
    preset_names: List[str],
    output_path: pathlib.Path,
    mission_name: str,
    altitude_band: str,
    temperature_band: str,
    environment_override: Optional[str] = None,
):
    inventory_paths = list(config_paths)
    inventory_paths.extend(resolve_preset(name) for name in preset_names)
    if not inventory_paths:
        raise ValueError("At least one --config or --preset is required to export a bundle")

    builds: List[Tuple[str, NodeBuild, object, List[str], str, Dict[str, float]]] = []
    for config_path in inventory_paths:
        build, estimate = _build_and_estimate(config_path, environment_override)
        node_id = f"node-{config_path.stem}"
        node_label = config_path.stem.replace("_", " ")
        location = {"altitude_band": altitude_band, "temperature_band": temperature_band}
        builds.append((node_id, build, estimate, [estimate.recommended_role], node_label, location))

    bundle = assemble_node_bundle(
        builds,
        altitude_band=altitude_band,
        temperature_band=temperature_band,
        mission={"name": mission_name},
    )
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(bundle, handle, indent=2)
    print(f"MissionProject bundle written to {output_path}")


def export_mission_project(
    config_path: pathlib.Path,
    output_path: pathlib.Path,
    mission_name: str,
    altitude_band: str,
    temperature_band: str,
    environment_override: Optional[str] = None,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    elevation_m: Optional[float] = None,
    schema_version: str = None,
):
    build, estimate = _build_and_estimate(config_path, environment_override)
    node_id = f"node-{config_path.stem}"
    node_label = config_path.stem.replace("_", " ")
    location = {
        k: v
        for k, v in {
            "lat": lat,
            "lon": lon,
            "elevation_m": elevation_m,
            "altitude_band": altitude_band,
            "temperature_band": temperature_band,
        }.items()
        if v is not None
    }
    project = assemble_project(
        [
            (
                node_id,
                build,
                estimate,
                [estimate.recommended_role],
                node_label,
                location,
            )
        ],
        mission={"name": mission_name or "Node Architect export", "ao": "Project WHITEFROST Demo"},
        environment={"propagation": build.environment, "altitude_band": altitude_band, "temperature_band": temperature_band},
        schema_version=schema_version,
    )
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(project, handle, indent=2)
    print(f"MissionProject written to {output_path}")


def import_mission_project(path: pathlib.Path, simulate: bool = False):
    inventory = load_components()
    project = parse_project(path)
    builds, warnings = project_to_builds(project, inventory)
    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    for build in builds:
        estimate = estimate_node(build) if simulate else None
        print(format_report(build, estimate) if estimate else build.as_dict())


def atak_export(path: pathlib.Path, geojson_path: Optional[pathlib.Path], cot_path: Optional[pathlib.Path]):
    project = parse_project(path)
    if geojson_path:
        geojson = to_geojson(project)
        with geojson_path.open("w", encoding="utf-8") as handle:
            json.dump(geojson, handle, indent=2)
        print(f"GeoJSON written to {geojson_path}")
    if cot_path:
        cot = to_cot_stub(project)
        with cot_path.open("w", encoding="utf-8") as handle:
            json.dump(cot, handle, indent=2)
        print(f"CoT stub written to {cot_path}")


def list_presets() -> List[Tuple[str, str]]:
    presets: List[Tuple[str, str]] = []
    if not PRESET_DIR.exists():
        return presets
    for preset_file in sorted(PRESET_DIR.glob("*.json")):
        with preset_file.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        description = data.get("description", "")
        presets.append((preset_file.stem, description))
    return presets


def resolve_preset(name: str) -> pathlib.Path:
    preset_path = PRESET_DIR / f"{name}.json"
    if not preset_path.exists():
        raise ValueError(f"Preset '{name}' not found in {PRESET_DIR}")
    return preset_path


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Ceradon Node Architect: estimate power, runtime, and roles for RF/sensor nodes (MissionProject schema v2.0.0 exports by default)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="List all available components")

    presets = sub.add_parser("presets", help="List bundled sample builds")

    preset_choices = [name for name, _ in list_presets()]

    sim = sub.add_parser("simulate", help="Simulate a build from a JSON config")
    sim.add_argument("config", nargs="?", type=pathlib.Path, help="Path to build JSON")
    sim.add_argument("--preset", choices=preset_choices, help="Preset name from sample_builds")
    sim.add_argument(
        "--environment",
        choices=["lab", "urban_indoor", "urban_outdoor", "rural_open", "subterranean"],
        help="Override environment assumption for range/power scaling",
    )

    export_mp = sub.add_parser("export-mission", help="Export a MissionProject JSON from a build (schema v2.0.0)")
    export_mp.add_argument("output", type=pathlib.Path, help="Output path for mission project JSON")
    export_mp.add_argument("--config", type=pathlib.Path, help="Path to build JSON")
    export_mp.add_argument("--preset", choices=preset_choices, help="Preset name from sample_builds")
    export_mp.add_argument("--mission-name", default="Project WHITEFROST Demo")
    export_mp.add_argument(
        "--altitude-band",
        default="band_2000_3000",
        choices=["sea_level", "band_1000_2000", "band_2000_3000", "above_3000"],
    )
    export_mp.add_argument(
        "--temperature-band",
        default="very_cold",
        choices=["hot", "temperate", "cold", "very_cold"],
    )
    export_mp.add_argument(
        "--environment",
        choices=["lab", "urban_indoor", "urban_outdoor", "rural_open", "subterranean"],
        help="Override environment assumption",
    )
    export_mp.add_argument("--lat", type=float)
    export_mp.add_argument("--lon", type=float)
    export_mp.add_argument("--elevation-m", type=float)
    export_mp.add_argument(
        "--export-mission-v1",
        action="store_true",
        help="Deprecated: emit legacy mission_project_v1 schema instead of schemaVersion 2.0.0",
    )

    export_bundle = sub.add_parser(
        "export-bundle", help="Export a MissionProject node bundle skeleton (schema v2.0.0)"
    )
    export_bundle.add_argument("output", type=pathlib.Path, help="Output path for MissionProject bundle JSON")
    export_bundle.add_argument("--config", action="append", type=pathlib.Path, help="Path to build JSON")
    export_bundle.add_argument("--preset", action="append", choices=preset_choices, help="Preset name from sample_builds")
    export_bundle.add_argument("--mission-name", default="Project WHITEFROST Demo")
    export_bundle.add_argument(
        "--altitude-band",
        default="band_2000_3000",
        choices=["sea_level", "band_1000_2000", "band_2000_3000", "above_3000"],
    )
    export_bundle.add_argument(
        "--temperature-band",
        default="cold",
        choices=["hot", "temperate", "cold", "very_cold"],
    )
    export_bundle.add_argument(
        "--environment",
        choices=["lab", "urban_indoor", "urban_outdoor", "rural_open", "subterranean"],
        help="Override environment assumption for all bundle nodes",
    )

    import_mp = sub.add_parser("import-mission", help="Import a MissionProject JSON and list usable builds")
    import_mp.add_argument("mission_file", type=pathlib.Path)
    import_mp.add_argument("--simulate", action="store_true", help="Run estimator for each usable node")

    atak = sub.add_parser("atak-export", help="Export GeoJSON and CoT from a MissionProject JSON")
    atak.add_argument("mission_file", type=pathlib.Path)
    atak.add_argument("--geojson", type=pathlib.Path, help="Output GeoJSON path")
    atak.add_argument("--cot", type=pathlib.Path, help="Output CoT stub path")

    return parser


def main(argv=None):
    argv = argv or sys.argv[1:]
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.command == "list":
        list_components()
    elif args.command == "presets":
        for name, description in list_presets():
            suffix = f" - {description}" if description else ""
            print(f"{name}{suffix}")
    elif args.command == "simulate":
        config_path = args.config
        if args.preset:
            config_path = resolve_preset(args.preset)
        if not config_path:
            parser.error("simulate requires a config path or --preset")
        build, estimate = _build_and_estimate(config_path, args.environment)
        print(format_report(build, estimate))
    elif args.command == "export-mission":
        config_path = args.config
        if args.preset:
            config_path = resolve_preset(args.preset)
        if not config_path:
            parser.error("export-mission requires a config path or --preset")
        schema_version = LEGACY_SCHEMA_TAG if args.export_mission_v1 else None
        export_mission_project(
            config_path=config_path,
            output_path=args.output,
            mission_name=args.mission_name,
            altitude_band=args.altitude_band,
            temperature_band=args.temperature_band,
            environment_override=args.environment,
            lat=args.lat,
            lon=args.lon,
            elevation_m=args.elevation_m,
            schema_version=schema_version,
        )
    elif args.command == "export-bundle":
        config_paths = args.config or []
        preset_names = args.preset or []
        if not config_paths and not preset_names:
            parser.error("export-bundle requires at least one --config or --preset")
        try:
            export_node_bundle(
                config_paths=config_paths,
                preset_names=preset_names,
                output_path=args.output,
                mission_name=args.mission_name,
                altitude_band=args.altitude_band,
                temperature_band=args.temperature_band,
                environment_override=args.environment,
            )
        except ValueError as exc:
            parser.error(str(exc))
    elif args.command == "import-mission":
        import_mission_project(args.mission_file, simulate=args.simulate)
    elif args.command == "atak-export":
        atak_export(args.mission_file, args.geojson, args.cot)
    else:
        parser.print_help()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
