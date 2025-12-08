# ATAK / Tactical Companion Exports

Ceradon Node Architect can export **MissionProject** data into simple geospatial products that tactical applications (e.g., ATAK, ITAK, WinTAK, or lightweight CoT-aware tools) can ingest offline.

## GeoJSON features
`mission_project.to_geojson()` produces a `FeatureCollection` containing:

- **Nodes** (`Point`) — includes `name`, `roles`, `origin_tool`, `rf_bands`, `recommended_role`, and `power_profile` (draw/runtime).
- **Platforms** (`Point`) — optional duplicate of nodes when platform locations are known.
- **Mesh links** (`LineString`) — connects `from_node` and `to_node` when both have coordinates and includes `band` and `estimated_range_km`.

Example feature properties:
```jsonc
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [-105.78, 39.55, 2600] },
  "properties": {
    "id": "node-whitefrost-recon",
    "name": "WHITEFROST Recon Quad Control",
    "origin_tool": "node",
    "roles": ["controller", "relay"],
    "recommended_role": "Experimental WiFi CSI / channel analysis node",
    "rf_bands": ["wifi_2.4", "wifi_5"],
    "power_draw_w": 18.2,
    "runtime_h": 6.3
  }
}
```

## CoT-style JSON stub
`mission_project.to_cot_stub()` emits a lightweight JSON array (not XML) suitable for CoT-friendly gateways:

```jsonc
[
  {
    "uid": "node-whitefrost-recon",
    "type": "a-f-G-U-C",               // coarse unit type code
    "how": "m-g",
    "lat": 39.55,
    "lon": -105.78,
    "hae": 2600,
    "name": "WHITEFROST Recon Quad Control",
    "role": "Experimental WiFi CSI / channel analysis node",
    "remarks": "rf: wifi_2.4,wifi_5 | origin: node"
  }
]
```

The stub keeps property names short to remain portable across low-bandwidth links. Missing coordinates are skipped to avoid emitting invalid CoT events.

## Usage
- **CLI**: `python -m ceradon atak-export mission_project.mission.json --geojson out.geojson --cot cot_stub.json`
- **Web**: use the MissionProject export button, then feed the JSON into your TAK companion workflow. The exported MissionProject already contains the data needed for the GeoJSON/CoT transforms above.

## Notes
- No external APIs are called; exports are fully offline-capable.
- Fields map 1:1 with the MissionProject schema, so other Architect tools (Mesh Architect, Mission Architect) can share the same export path without additional mapping layers.
