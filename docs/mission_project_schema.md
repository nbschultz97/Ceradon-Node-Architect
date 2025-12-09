# MissionProject JSON Schema (Ceradon Node Architect)

This repository exchanges mission data with the rest of the Ceradon Architect stack using a shared **MissionProject** JSON structure. The schema is designed to be stable, offline-friendly, and tolerant of partial data coming from other tools (Mission Architect, Mesh Architect, KitSmith, UxS Architect, and the Architect hub).

## Top-level shape

```jsonc
{
  "schema": "mission_project_v1",
  "origin_tool": "node",                    // node | uxs | mesh | kit | mission | hub
  "generated_at": "2024-06-01T12:00:00Z",
  "mission": { ... },
  "environment": { ... },
  "constraints": [ ... ],
  "platforms": [ ... ],
  "nodes": [ ... ],
  "mesh_links": [ ... ],
  "kits": [ ... ]
}
```

All IDs must be stable strings. Other tools can attach their own namespaces (e.g., `mesh-link-1`, `kit-alpha`, `uxs-quad-1`). Unknown fields must be preserved on re-export to avoid losing upstream data.

## Platforms
Represents a physical frame or compute platform (SBC, laptop, airframe, etc.).

```jsonc
{
  "id": "platform-rpi5",
  "name": "Raspberry Pi 5 8GB",
  "role": "compute",                         // compute | airframe | payload_host | relay
  "origin_tool": "node",
  "specs": {
    "cpu": "Broadcom Cortex-A76",
    "ram_gb": 8,
    "storage": "microSD",
    "power_idle_w": 4.5,
    "power_load_w": 11.0,
    "weight_kg": 0.046
  }
}
```

## Nodes
Represents a configured payload or control node that can be fielded.

```jsonc
{
  "id": "node-whitefrost-recon",
  "name": "WHITEFROST Recon Quad Control",
  "origin_tool": "node",
  "platform_id": "platform-rpi5",
  "roles": ["controller", "relay"],
  "rf_bands": ["wifi_2.4", "wifi_5"],
  "power_profile": {
    "estimated_draw_w": 18.2,
    "ideal_runtime_h": 7.9,
    "adjusted_runtime_h": 6.3,
    "capacity_factor": 0.8
  },
  "battery": {
    "id": "talentcell_144wh",
    "capacity_wh": 144,
    "chemistry": "Li-ion"
  },
  "estimated_runtime_min": 378,
  "location": { "lat": 39.55, "lon": -105.78, "elevation_m": 2600 },
  "environment": {
    "propagation": "rural_open",
    "altitude_band": "band_2000_3000",
    "temperature_band": "very_cold"
  },
  "environment_assumptions": {
    "propagation": "rural_open",
    "altitude_band": "band_2000_3000",
    "temperature_band": "very_cold"
  },
  "capabilities": ["WiFi recon / monitor mode scanning", "Potential WiFi CSI / channel analysis (driver support required)", "GPS time/position reference"],
  "recommended_role": "Experimental WiFi CSI / channel analysis node",
  "host_type": {"id": "rpi5_8gb", "name": "Raspberry Pi 5 8GB", "tags": ["whitefrost_default"]},
  "radios": [{"id": "wifi_ax210", "name": "Intel AX210 M.2 WiFi 6E", "radio_type": "wifi", "bands": ["2.4 GHz", "5 GHz", "6 GHz"]}],
  "antennas": [{"id": "patch_14dbi", "name": "Patch panel (14 dBi)", "gain_dbi": 14, "pattern": "patch"}],
  "sensors": [{"id": "gps_usb", "name": "USB GPS puck", "type": "gps"}],
  "parts": {
    "host_id": "rpi5_8gb",
    "battery_id": "talentcell_144wh",
    "rf_chains": [
      {
        "radio_id": "wifi_ax210",
        "antenna_id": "patch_14dbi"
      }
    ],
    "sensor_ids": ["gps_usb", "imu_i2c"]
  },
  "notes": "Cold-weather tuned recon/CSI control package."
}
```

Fields such as `platform_id` should reference entries in the `platforms` array. Nodes are tolerant of missing `location` or partial `parts` when imported; unknown fields must pass through untouched.

## Mesh links
Optional, used by Mesh Architect or Node Architect when range estimates are available.

```jsonc
{
  "id": "mesh-link-1",
  "origin_tool": "node",
  "from_node": "node-whitefrost-relay-1",
  "to_node": "node-whitefrost-relay-2",
  "band": "lora_0.9",
  "estimated_range_km": 2.0,
  "notes": "Line-of-sight ridge hop"
}
```

## Kits
Kits capture grouped payloads or sustainment bundles.

```jsonc
{
  "id": "kit-whitefrost sustainment",
  "origin_tool": "kit",
  "contents": ["talentcell_144wh", "solar_fold_50w"],
  "notes": "Cold-soaked batteries derate to ~80% at -10C"
}
```

## Mission
Lightweight description for downstream tooling.

```jsonc
{
  "name": "Project WHITEFROST Demo",
  "ao": "High-altitude alpine valley",
  "objective": "Demonstrate recon quad + mesh relays + sustainment drop",
  "timeframe": "Demo",
  "notes": "Public-facing scenario only"
}
```

## Environment
Represents common environment defaults applied across the mission.

```jsonc
{
  "temperature_band": "very_cold",           // hot | temperate | cold | very_cold
  "altitude_band": "band_2000_3000",         // sea_level | band_1000_2000 | band_2000_3000 | above_3000
  "propagation": "rural_open",
  "weather": "light snow",
  "terrain": "alpine ridges"
}
```

## Constraints
Constraints help other tools pre-filter fieldable nodes.

```jsonc
{
  "id": "constraint-runtime",
  "type": "min_runtime_hours",
  "value": 4,
  "notes": "Nodes must hold 4h at -10C, 2400 m"
}
```

## Graceful handling of partial data
- Unknown fields must be preserved when transforming a project.
- Nodes without `location` or missing `parts` remain in the payload; downstream tools can fill gaps.
- `origin_tool` helps identify which app last touched an entity; leave intact when importing.

## File naming guidance
Use `.mission.json` or `.mission_project.json` to make tooling discovery easier, and keep everything UTF-8.
