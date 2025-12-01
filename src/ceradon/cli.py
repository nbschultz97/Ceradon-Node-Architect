from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import List, Tuple

from .data_loader import find_by_id, load_components
from .estimator import estimate_node, format_report
from .models import NodeBuild

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
        description="Ceradon Node Architect: estimate power, runtime, and roles for RF/sensor nodes",
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
        build = parse_build(config_path)
        if args.environment:
            build.environment = args.environment
        estimate = estimate_node(build)
        report = format_report(build, estimate)
        print(report)
    else:
        parser.print_help()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
