import pathlib

from ceradon.cli import parse_build
from ceradon.estimator import estimate_node


def test_pose_ready_build():
    build_path = pathlib.Path(__file__).resolve().parents[1] / "sample_builds" / "pose_ready.json"
    build = parse_build(build_path)
    estimate = estimate_node(build)

    assert estimate.total_power_w > 0
    assert estimate.runtime_hours > 0
    assert estimate.range_km >= 0.25
    assert any("CSI" in cap for cap in estimate.capabilities)
    assert "pose" in estimate.recommended_role.lower()
