# Ceradon Node Architect

Offline-first CLI for modeling COTS RF/sensor nodes (Linux hosts, WiFi/LoRa/FPV/SDR/cellular radios, antennas, batteries, and sensors) you can buy from Amazon/RadioShack-tier suppliers. It estimates power draw, runtime, coarse RF range, likely capabilities, and a recommended role while staying lightweight enough for Raspberry Pi/Jetson deployments that anchor on WiFi CSI pose sensing. In the public WHITEFROST demo, Node Architect is the authoritative catalog and node designer that feeds Mission Architect, UxS Architect, and Mesh Architect with vetted COTS-heavy nodes that can be built on Pi/Jetson/handheld/mini-PC hosts.

## Features
- Rich COTS catalog: Raspberry Pis, Jetson/Orin modules, rugged/handheld PCs, WiFi 6/6E/LoRa/FPV/SDR/cellular links, omni/patch/yagi/FPV antennas, USB-PD and LiPo bricks, and simple sensors (camera/GPS/IMU/environmental). Tagged parts highlight `whitefrost_default`, `3d_printed_uas_core`, `relay_node`, `edge_compute`, and `partner_friendly` options.
- JSON-driven builds plus bundled presets for quick archetypes.
- Estimator accounts for host idle/load, radio tx/rx, sensor draw, antenna gain buckets, and environment factors (lab/urban indoor/urban outdoor/rural open/subterranean).
- Capability tags flag WiFi recon/CSI potential, LoRa telemetry, FPV video, SDR capture, cellular backhaul, and sensor payloads; roles steer toward recon, CSI experiments, FPV payloads, or low-power telemeter nodes.
- Concise text reports suitable for field notes or further scripting.

## Quickstart
1. Create a Python 3.9+ virtual environment (stdlib-only dependencies) and run the CLI directly:
   ```bash
   python -m ceradon list
   python -m ceradon presets
   python -m ceradon simulate sample_builds/pose_ready.json
   python -m ceradon simulate --preset urban_wifi_recon
   ```

2. Install locally if preferred:
   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install .
   ```

## Writing your own builds
Create a JSON file with component IDs from `python -m ceradon list`:
```json
{
  "host": "rpi5_8gb",
  "radio": "wifi_ax210",
  "antenna": "patch_14dbi",
  "battery": "talentcell_144wh",
  "sensors": ["gps_usb", "imu_i2c", "camera_pi"],
  "environment": "urban_outdoor"
}
```
Run `python -m ceradon simulate your_build.json` to see the report. Leave `sensors` empty or point to `none` for bare RF nodes. Use `--environment` to override the config when simulating.

## Presets
The `sample_builds/` directory includes quick archetypes; list them with `python -m ceradon presets`:
- `pose_ready` — Jetson + AX210 + panel for CSI/pose experimentation.
- `rural_lora_sensor` — Low-power Pi + LoRa yagi + TalentCell for rural telemetry.
- `urban_wifi_recon` — NUC + AX210 + patch panel + V-mount for city RF mapping.
- `fpv_relay_payload` — Handheld PC + analog FPV VTx + CP antenna for video relay.
- `cellular_backhaul_node` — Mini PC with cellular hotspot backhaul for remote drops.

## Estimation model (coarse but consistent)
- **Power**: averages host idle/load + radio tx/rx + sensor draw (antenna assumed zero) with an optional environment factor.
- **Runtime**: battery Wh divided by estimated load watts.
- **Range**: baseline per radio type/band (e.g., WiFi 2.4 ≈ 0.15 km, WiFi 5/6 ≈ 0.08 km, LoRa ≈ 2 km, analog FPV ≈ 1 km, SDR ≈ 0.5 km; cellular reports infrastructure backhaul) scaled by antenna gain buckets and environment multipliers (lab 0.8x, urban indoor 0.3x, urban outdoor 0.6x, rural open 1x, subterranean 0.2x).
- **Capabilities**: WiFi recon/monitor, CSI potential, LoRa telemetry, analog FPV, SDR capture, cellular backhaul, plus sensor-driven tags (video, GPS, IMU, environmental).
- **Recommended role**: heuristic rules prefer CSI/channel analysis builds, WiFi recon nodes with decent CPU/runtime, LoRa endurance beacons, FPV payload relays, SDR survey boxes, or cellular backhaul notes.

### Environment, constraints, and exports
- **Environment adjustments**: The web UI adds altitude and temperature bands that derate effective battery capacity (-5% to -30% across higher altitude and colder bands). Ideal runtime (no derate) and adjusted runtime (with derate) are shown side by side for transparency.
- **Constraint-first filtering**: An optional constraints sidebar lets you screen designs by max weight, minimum adjusted runtime, and required roles. Active constraints hide non-compliant saved designs and surface warnings when evaluating a new node.
- **JSON export**: Saved node designs can be exported to `ceradon_node_designs_v1` JSON with id, name, parts list (compute/battery/RF chains/sensors), total weight, ideal and adjusted runtime, radios, roles, environment bands, and notes so Mission Architect, Mesh Architect, or KitSmith can ingest the same objects. The CLI adds `export-bundle` to emit a MissionProject v2.0.0 skeleton (`schemaVersion`, `meta.origin_tool`, `nodes`, `platforms`) directly from one or more presets/configs without extra mission scaffolding.

### MissionProject nodes[] shape (what UxS Architect expects)
`export-mission` (CLI) and the web "Export MissionProject" button now emit MissionProject schema v2.0.0 payloads by default. Each `nodes[]` entry exposes:
- `id`, `name`, `roles`, `recommended_role` (stable per session so UxS/Mesh links can reference them)
- `host_type` (id/name/tags), `radios[]`, `antennas[]`, `battery`, `sensors[]` with WHITEFROST-friendly tags such as `whitefrost_default`, `relay_node`, or `edge_compute`
- `rf_bands`, `power_profile`, and `estimated_runtime_min` plus `environment_assumptions` (propagation, altitude band, temperature band) so endurance math matches between CLI and web
- `parts` (host/battery/rf_chains/sensor_ids) retained for backward compatibility with other Architects

Sample:

```json
{
  "schemaVersion": "2.0.0",
  "mission": {"name": "Project WHITEFROST Demo"},
  "environment": {"propagation": "rural_open", "altitude_band": "band_2000_3000", "temperature_band": "cold"},
  "nodes": [
    {
      "id": "node-alpha",
      "name": "Quad recon",
      "roles": ["sensor", "relay"],
      "recommended_role": "Experimental WiFi CSI / channel analysis node",
      "host_type": {"id": "rpi5_8gb", "name": "Raspberry Pi 5 8GB", "tags": ["whitefrost_default"]},
      "radios": [{"id": "wifi_ax210", "name": "Intel AX210", "radio_type": "wifi", "bands": ["wifi_2.4", "wifi_5", "wifi_6e"]}],
      "antennas": [{"id": "omni_5dbi", "name": "5 dBi omni", "gain_dbi": 5, "pattern": "omni"}],
      "battery": {"id": "talentcell_144wh", "capacity_wh": 144, "chemistry": "Li-ion"},
      "sensors": [{"id": "gps_usb", "name": "u-blox GPS", "type": "gps"}],
      "rf_bands": ["wifi_2.4", "wifi_5"],
      "power_profile": {"estimated_draw_w": 18.2, "adjusted_runtime_h": 6.3, "capacity_factor": 0.8},
      "estimated_runtime_min": 378,
      "environment_assumptions": {"propagation": "rural_open", "altitude_band": "band_2000_3000", "temperature_band": "cold"},
      "parts": {"host_id": "rpi5_8gb", "battery_id": "talentcell_144wh", "rf_chains": [{"radio_id": "wifi_ax210", "antenna_id": "omni_5dbi"}], "sensor_ids": ["gps_usb"]},
      "origin_tool": "node"
    }
  ],
  "mesh_links": [],
  "kits": []
}
```

Imports preserve unknown fields in the payload and carry them through on re-export so downstream tools do not lose schema extensions. A deprecated `--export-mission-v1` flag remains available in the CLI when you need `mission_project_v1` compatibility.

UI-only preview: a MissionProject preview card mirrors the CLI bundle output, showing the exact JSON and exposing copy/download buttons before exporting.

## Project layout
- `src/ceradon/` — models, data loader, estimator, CLI entrypoints.
- `data/default_components.json` — component catalog; extend as needed.
- `web/` — static browser UI that mirrors the CLI estimator (no backend required).
- `sample_builds/` — starter build configs/presets.
- `tests/` — lightweight regression tests.

## Web UI
- The `web/` folder hosts a static HTML/JS/CSS version of the estimator that runs entirely in the browser using `web/components.json` (kept in sync with `data/default_components.json`).
- To run locally, open `web/index.html` in a browser or start a quick server: `cd web && python -m http.server 8000` then browse to `http://localhost:8000`.
- GitHub Pages: GitHub now only exposes `(root)` or `/docs` as publish targets. A root-level `index.html` is provided to redirect to `/web/index.html`, so set **Settings → Pages → Source** to the `main` branch and **Folder** to `(root)` to host the UI without moving files. If you prefer `/docs`, copy `web/` into `docs/` and serve from there instead.

### Web UI updates
- Mobile-friendly single-page layout with configuration up top and results below.
- Preset configurations for common nodes that pre-fill compute, RF chains, sensors, and environment (still editable after selection). WHITEFROST presets now include lab dev, recon airborne, and ground relay nodes alongside the existing demo/control builds.
- Multi-radio/antenna RF chains with basic host slot counts (`max_rf_chains`) to warn when a build exceeds modeled capacity.

## Hardening and extensions
- Extend `data/default_components.json` with local parts; keep IDs unique.
- Use `NodeBuild` + `estimate_node` in your own scripts for CSV/JSON exports.
- Future-friendly toward CSI-based pose estimation: WiFi cards with `supports_csi: true` and higher `cpu_score` surface CSI roles early so you can layer pose pipelines later.
