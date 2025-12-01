import pathlib
import os
import subprocess
import sys

from ceradon.cli import parse_build
from ceradon.estimator import estimate_node


SAMPLES = pathlib.Path(__file__).resolve().parents[1] / "sample_builds"


def test_pose_ready_build():
    build_path = SAMPLES / "pose_ready.json"
    build = parse_build(build_path)
    estimate = estimate_node(build)

    assert estimate.total_power_w > 0
    assert estimate.runtime_hours > 0
    assert estimate.range_km is None or estimate.range_km >= 0
    assert any("CSI" in cap for cap in estimate.capabilities)
    assert "csi" in estimate.recommended_role.lower()
    assert estimate.capabilities  # non-empty capability list


def test_lora_sensor_node():
    build_path = SAMPLES / "rural_lora_sensor.json"
    build = parse_build(build_path)
    estimate = estimate_node(build)

    assert estimate.total_power_w > 0
    assert estimate.runtime_hours > 0
    assert any("LoRa" in cap for cap in estimate.capabilities)
    assert "telemetry" in estimate.recommended_role.lower()


def test_analog_fpv_payload():
    build_path = SAMPLES / "fpv_relay_payload.json"
    build = parse_build(build_path)
    estimate = estimate_node(build)

    assert estimate.range_km is not None and estimate.range_km > 0
    assert any("FPV" in cap for cap in estimate.capabilities)
    assert "video" in estimate.recommended_role.lower() or "payload" in estimate.recommended_role.lower()


def test_cli_list_and_simulate():
    env = os.environ.copy()
    env["PYTHONPATH"] = str(pathlib.Path(__file__).resolve().parents[1] / "src")

    list_result = subprocess.run(
        [sys.executable, "-m", "ceradon", "list"], capture_output=True, check=True, env=env
    )
    assert b"HOSTS" in list_result.stdout

    sim_result = subprocess.run(
        [sys.executable, "-m", "ceradon", "simulate", "--preset", "urban_wifi_recon"],
        capture_output=True,
        check=True,
        env=env,
    )
    assert b"Selected stack" in sim_result.stdout
