# Ceradon Node Architect

Offline-first CLI for modeling COTS RF/sensor nodes (Linux hosts, WiFi/LoRa/FPV/SDR/cellular radios, antennas, batteries, and sensors) you can buy from Amazon/RadioShack-tier suppliers. It estimates power draw, runtime, coarse RF range, likely capabilities, and a recommended role while staying lightweight enough for Raspberry Pi/Jetson deployments that anchor on WiFi CSI pose sensing.

## Features
- Rich COTS catalog: Raspberry Pis, Jetson/NUC-class boxes, handheld PCs, WiFi/LoRa/FPV/SDR/cellular links, omni/patch/yagi/FPV antennas, USB-PD and TalentCell batteries, and simple sensors (camera/GPS/IMU/environmental).
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

## Project layout
- `src/ceradon/` — models, data loader, estimator, CLI entrypoints.
- `data/default_components.json` — component catalog; extend as needed.
- `web/` — static browser UI that mirrors the CLI estimator (no backend required).
- `sample_builds/` — starter build configs/presets.
- `tests/` — lightweight regression tests.

## Web UI
- The `web/` folder hosts a static HTML/JS/CSS version of the estimator that runs entirely in the browser using `web/components.json` (kept in sync with `data/default_components.json`).
- To run locally, open `web/index.html` in a browser or start a quick server: `cd web && python -m http.server 8000` then browse to `http://localhost:8000`.
- GitHub Pages: in repository **Settings → Pages**, set **Source** to the `main` branch and **Folder** to `/web` to serve the UI directly.

## Hardening and extensions
- Extend `data/default_components.json` with local parts; keep IDs unique.
- Use `NodeBuild` + `estimate_node` in your own scripts for CSV/JSON exports.
- Future-friendly toward CSI-based pose estimation: WiFi cards with `supports_csi: true` and higher `cpu_score` surface CSI roles early so you can layer pose pipelines later.
