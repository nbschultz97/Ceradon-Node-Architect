# Ceradon Node Architect

Offline-first CLI for modeling COTS RF/sensor nodes (hosts, radios, antennas, batteries, sensors) and estimating power draw, runtime, link range, plausible capabilities, and a recommended role. Designed for Raspberry Pi/Jetson-class deployments where WiFi CSI pose sensing is the long-term anchor.

## Features
- Curated component library with Linux hosts, WiFi/LoRa/FPV/SDR radios, antennas, batteries, and basic sensors.
- JSON-driven build configs; fast CLI to list parts and simulate builds.
- Estimates total power, runtime from battery Wh, coarse radio range with antenna gain, and capability set (CSI-aware when supported).
- Generates concise text reports suitable for field notes or further tooling.

## Quickstart
1. Create a Python 3.9+ virtual environment (no external deps beyond stdlib) and run the CLI directly:
   ```bash
   python -m ceradon list
   python -m ceradon simulate sample_builds/pose_ready.json
   ```

2. If you prefer to install the package locally:
   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install .
   ```

## Writing your own builds
Create a JSON file with component IDs from `python -m ceradon list`:
```json
{
  "host": "rpi4",
  "radio": "wifi_ax210",
  "antenna": "yagi_12dbi",
  "battery": "usb_pd_60wh",
  "sensors": ["gps_usb", "imu_spi"]
}
```
Run `python -m ceradon simulate your_build.json` to see the report.

## Estimation model (coarse but consistent)
- **Power**: sums host + radio + sensors (antenna/battery assumed negligible draw).
- **Runtime**: battery Wh divided by load watts.
- **Range**: radio baseline (WiFi 0.25 km, LoRa 5 km, Analog FPV 1 km, SDR 2 km) scaled by antenna/radio gain buckets.
- **Capabilities**: derived from radio type, CSI flag, and attached sensors.
- **Recommended role**: favors CSI-ready payloads, otherwise picks endurance or niche roles based on runtime/range.

## Project layout
- `src/ceradon/` — models, data loader, estimator, CLI entrypoints.
- `data/default_components.json` — component catalog; extend as needed.
- `sample_builds/` — starter build configs.
- `tests/` — lightweight regression tests.

## Hardening and extensions
- Extend `data/default_components.json` with local parts; keep IDs unique.
- Use `NodeBuild` + `estimate_node` in your own scripts for CSV/JSON exports.
- Future-friendly toward CSI-based pose estimation: WiFi cards with CSI set `supports_csi: true` so capability strings and recommended roles surface it early.
