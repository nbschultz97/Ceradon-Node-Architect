let components = null;
let lastPresetWarnings = [];
let savedDesigns = [];
let lastEvaluation = null;
let missionName = 'Project WHITEFROST Demo';
let importedProjectExtras = {};

const STORAGE_KEYS = {
  designs: 'ceradonSavedDesigns',
  environment: 'ceradonEnvBands',
  constraints: 'ceradonConstraints',
};

const SCHEMA_VERSION = 'mission_project_v1';

/**
 * @typedef {Object} RuntimeBreakdown
 * @property {number} basePowerW
 * @property {number} environmentPowerFactor
 * @property {number} capacityFactor
 * @property {number} baseRuntimeHours
 * @property {number} environmentRuntimeHours
 * @property {number} adjustedRuntimeHours
 */

/**
 * @typedef {Object} NodeDesign
 * @property {string} id
 * @property {string} name
 * @property {string} missionName
 * @property {string} originTool
 * @property {string[]} roles
 * @property {string} environment
 * @property {string} altitudeBand
 * @property {string} temperatureBand
 * @property {object} location
 * @property {number} totalPowerW
 * @property {number} idealRuntimeHours
 * @property {number} adjustedRuntimeHours
 * @property {number} capacityFactor
 * @property {number} totalWeightKg
 * @property {string[]} rfBands
 * @property {string[]} capabilities
 * @property {string} recommendedRole
 * @property {object} parts
 * @property {string} notes
 * @property {RuntimeBreakdown} runtime
 * @property {object} passthrough
 */

const nodeIdCache = {};
let nodeSequence = 1;
let autoEvaluateTimer = null;

function extractUnknownFields(payload, knownKeys) {
  if (!payload || typeof payload !== 'object') return {};
  return Object.keys(payload).reduce((acc, key) => {
    if (!knownKeys.includes(key)) {
      acc[key] = payload[key];
    }
    return acc;
  }, {});
}

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

function allocateNodeId(nameHint) {
  const slug = slugify(nameHint) || `node-${nodeSequence}`;
  if (!nodeIdCache[slug]) {
    nodeIdCache[slug] = slug.startsWith('node-') ? slug : `node-${slug}`;
    nodeSequence += 1;
  }
  return nodeIdCache[slug];
}

const ROLE_OPTIONS = ['sensor', 'relay', 'ground_station', 'controller', 'gateway', 'c2_support'];

let activeConstraints = { maxWeight: null, minRuntime: null, requiredRoles: [] };

const batteryCapacityFactor = {
  sea_level: { hot: 1.0, temperate: 1.0, cold: 0.95, very_cold: 0.9 },
  band_1000_2000: { hot: 0.95, temperate: 0.93, cold: 0.88, very_cold: 0.82 },
  band_2000_3000: { hot: 0.9, temperate: 0.88, cold: 0.82, very_cold: 0.76 },
  above_3000: { hot: 0.85, temperate: 0.82, cold: 0.75, very_cold: 0.7 },
};

const environmentPowerFactor = {
  lab: 0.8,
  urban_indoor: 1.0,
  urban_outdoor: 1.1,
  rural_open: 1.0,
};

const environmentRangeFactor = {
  lab: 0.7,
  urban_indoor: 0.3,
  urban_outdoor: 0.6,
  rural_open: 1.0,
};

function triggerAutoEvaluate() {
  clearTimeout(autoEvaluateTimer);
  autoEvaluateTimer = setTimeout(() => handleEvaluate({ allowIncomplete: true }), 200);
}

function deriveRfBands(radio) {
  if (!radio) return [];
  if (radio.bands && radio.bands.length) {
    return radio.bands.map((band) => band.toLowerCase());
  }
  if (radio.band) {
    return radio.band
      .split('/')
      .map((band) => band.trim())
      .filter(Boolean)
      .map((band) => band.toLowerCase());
  }
  if (radio.radio_type) return [radio.radio_type.toLowerCase()];
  return [];
}

const PRESETS = [
  {
    id: 'airborne_recon_node',
    label: 'Airborne Recon Node',
    description: 'Lightweight Pi 5 build with WiFi 6E and nav sensors for aerial ISR legs.',
    config: {
      computeId: 'rpi5_8gb',
      environment: 'urban_outdoor',
      altitudeBand: 'band_1000_2000',
      temperatureBand: 'temperate',
      batteryId: 'lipo_4s_5200mah',
      rfChains: [
        { radioId: 'wifi_mt7922', antennaIds: ['omni_3dbi_stub'] },
      ],
      sensorIds: ['gps_usb', 'imu_i2c', 'camera_pi'],
    },
  },
  {
    id: 'ground_relay_cots',
    label: 'Ground Relay Node',
    description: 'Tripod/vehicle relay with larger battery and dual-radio coverage.',
    config: {
      computeId: 'rugged_mini_pc',
      environment: 'rural_open',
      altitudeBand: 'band_2000_3000',
      temperatureBand: 'temperate',
      batteryId: 'field_200wh',
      rfChains: [
        { radioId: 'wifi_ax210', antennaIds: ['yagi_24ghz_12dbi'] },
        { radioId: 'wifi_awus036acm', antennaIds: ['omni_9dbi'] },
      ],
      sensorIds: ['gps_usb'],
    },
  },
  {
    id: 'bench_dev_node',
    label: 'Bench Dev Node',
    description: 'Lab-friendly Jetson bring-up kit for SDR/CSI/payload testing.',
    config: {
      computeId: 'jetson_orin_nano',
      environment: 'lab',
      altitudeBand: 'sea_level',
      temperatureBand: 'temperate',
      batteryId: 'dc_barrel_99wh',
      rfChains: [{ radioId: 'sdr_hackrf_one', antennaIds: ['omni_3dbi_stub'] }],
      sensorIds: ['camera_usb', 'imu_i2c'],
    },
  },
  {
    id: 'whitefrost_demo',
    label: 'WHITEFROST Demo Control Node',
    description: 'Cold-weather recon/control node for alpine quad + mesh relays.',
    config: {
      computeId: 'rpi5_8gb',
      environment: 'rural_open',
      altitudeBand: 'band_2000_3000',
      temperatureBand: 'very_cold',
      location: { lat: 39.55, lon: -105.78, elevation_m: 2600 },
      missionName: 'Project WHITEFROST Demo',
      batteryId: 'talentcell_144wh',
      rfChains: [{ radioId: 'wifi_ax210', antennaIds: ['patch_14dbi'] }],
      sensorIds: ['gps_usb', 'imu_i2c'],
    },
  },
  {
    id: 'lab_dev_node',
    label: 'Lab dev node',
    description: 'Bench-top WHITEFROST lab node for CSI/SDR bring-up.',
    config: {
      computeId: 'jetson_orin_nx_16gb',
      environment: 'lab',
      altitudeBand: 'sea_level',
      temperatureBand: 'temperate',
      batteryId: 'dc_barrel_99wh',
      rfChains: [{ radioId: 'sdr_hackrf_one', antennaIds: ['omni_3dbi_stub'] }],
      sensorIds: ['camera_usb', 'gps_usb'],
    },
  },
  {
    id: 'recon_airborne_node',
    label: 'Recon airborne node',
    description: 'Airframe-mounted Pi 5 + WiFi 6E for UAS recon.',
    config: {
      computeId: 'rpi5_8gb',
      environment: 'urban_outdoor',
      altitudeBand: 'band_1000_2000',
      temperatureBand: 'cold',
      batteryId: 'lipo_4s_5200mah',
      rfChains: [{ radioId: 'wifi_mt7922', antennaIds: ['omni_3dbi_stub'] }],
      sensorIds: ['gps_usb', 'imu_i2c', 'camera_pi'],
    },
  },
  {
    id: 'ground_relay_node',
    label: 'Ground relay node',
    description: 'Tripod/vehicle WiFi relay with directional panel.',
    config: {
      computeId: 'rugged_mini_pc',
      environment: 'rural_open',
      altitudeBand: 'band_2000_3000',
      temperatureBand: 'temperate',
      batteryId: 'lipo_4s_10000mah',
      rfChains: [{ radioId: 'wifi_ax210', antennaIds: ['yagi_24ghz_12dbi'] }],
      sensorIds: ['gps_usb'],
    },
  },
  {
    id: 'urban_wifi_recon',
    label: 'Urban WiFi Recon Node',
    description: 'NUC + AX210 + patch panel for short-range urban RF mapping.',
    config: {
      computeId: 'intel_nuc_i5',
      environment: 'urban_outdoor',
      batteryId: 'talentcell_144wh',
      rfChains: [{ radioId: 'wifi_ax210', antennaIds: ['patch_14dbi'] }],
      sensorIds: ['camera_usb', 'gps_usb'],
    },
  },
  {
    id: 'rural_lora_sensor',
    label: 'Rural LoRa Sensor Hub',
    description: 'Pi 4 with LoRa concentrator and yagi for long-haul telemetry drops.',
    config: {
      computeId: 'rpi4',
      environment: 'rural_open',
      batteryId: 'field_200wh',
      rfChains: [{ radioId: 'lora_sx1302', antennaIds: ['yagi_900_10dbi'] }],
      sensorIds: ['env_bme280', 'imu_i2c'],
    },
  },
  {
    id: 'analog_fpv_relay',
    label: 'Analog FPV Relay',
    description: 'Handheld PC driving a 5.8 GHz analog VTx with FPV camera payload.',
    config: {
      computeId: 'handheld_pc',
      environment: 'urban_outdoor',
      batteryId: 'v_mount_98wh',
      rfChains: [{ radioId: 'analog_5g8', antennaIds: ['fpv_cp'] }],
      sensorIds: ['camera_usb'],
    },
  },
  {
    id: 'experimental_csi_node',
    label: 'Experimental CSI Node',
    description: 'Jetson Orin Nano with AX210 and IMU for CSI/pose experiments.',
    config: {
      computeId: 'jetson_orin_nano',
      environment: 'urban_indoor',
      batteryId: 'talentcell_144wh',
      rfChains: [{ radioId: 'wifi_ax210', antennaIds: ['omni_9dbi'] }],
      sensorIds: ['camera_usb', 'imu_i2c'],
    },
  },
  {
    id: 'cellular_backhaul_node',
    label: 'Cellular Backhaul Node',
    description: 'NUC-class host with cellular uplink plus WiFi access for field teams.',
    config: {
      computeId: 'intel_nuc_i5',
      environment: 'rural_open',
      batteryId: 'liion_98wh',
      rfChains: [
        { radioId: 'cellular_hotspot', antennaIds: ['omni_2dbi'] },
        { radioId: 'wifi_awus036acm', antennaIds: ['omni_5dbi'] },
      ],
      sensorIds: ['gps_usb'],
    },
  },
];

document.addEventListener('DOMContentLoaded', () => {
  loadComponents();
  buildRoleCheckboxes();
  loadSavedDesigns();
  loadConstraints();
  loadEnvironmentSelection();
  document.getElementById('mission-name').value = missionName;
  document.getElementById('mission-name').addEventListener('input', (event) => {
    missionName = (event.target.value || '').trim() || 'Project WHITEFROST Demo';
  });
  document.getElementById('evaluate-btn').addEventListener('click', handleEvaluate);
  document.getElementById('add-rf-chain-btn').addEventListener('click', () => addRfChain());
  document.getElementById('compute-select').addEventListener('change', () => {
    updateRfCapacity();
    triggerAutoEvaluate();
  });
  document.getElementById('preset-select').addEventListener('change', handlePresetChange);
  document.getElementById('export-designs').addEventListener('click', exportDesigns);
  document.getElementById('whitefrost-demo').addEventListener('click', loadWhitefrostDemo);
  document.getElementById('import-mission').addEventListener('change', handleMissionImport);
  bindConstraintInputs();
  bindEnvironmentPersistence();
  bindAutoEvaluation();
});

async function loadComponents() {
  try {
    const response = await fetch('components.json');
    if (!response.ok) {
      throw new Error('Unable to load components catalog');
    }
    components = await response.json();
    populateSelectors(components);
    populatePresetSelect();
    addRfChain();
    updateRfCapacity();
  } catch (error) {
    showError(`Failed to load components: ${error.message}`);
  }
}

function populateSelectors(data) {
  const computeList = data.compute || data.hosts || [];
  const radios = data.radios || [];
  const antennas = data.antennas || [];
  const batteries = data.batteries || [];
  const sensors = data.sensors || [];

  populateSelect('compute-select', computeList);
  populateSelect('battery-select', batteries, (bat) => `${bat.name} (${bat.capacity_wh} Wh)`);
  populateSensors(sensors);

  // Store radio/antenna options for RF chain rows
  const radioSelectTemplate = document.createElement('select');
  radioSelectTemplate.id = 'radio-template';
  radioSelectTemplate.style.display = 'none';
  populateSelectFromElement(radioSelectTemplate, radios);

  const antennaSelectTemplate = document.createElement('select');
  antennaSelectTemplate.id = 'antenna-template';
  antennaSelectTemplate.style.display = 'none';
  populateSelectFromElement(
    antennaSelectTemplate,
    antennas,
    (ant) => `${ant.name}${ant.gain_dbi ? ` (${ant.gain_dbi} dBi)` : ''}`
  );

  document.body.appendChild(radioSelectTemplate);
  document.body.appendChild(antennaSelectTemplate);
}

function populatePresetSelect() {
  const select = document.getElementById('preset-select');
  PRESETS.forEach((preset) => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    select.appendChild(option);
  });
}

function populateSelect(selectId, items, labelFn) {
  const select = document.getElementById(selectId);
  items.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = labelFn ? labelFn(item) : item.name;
    select.appendChild(option);
  });
}

function populateSelectFromElement(select, items, labelFn) {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select';
  select.appendChild(placeholder);

  items.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = labelFn ? labelFn(item) : item.name;
    select.appendChild(option);
  });
}

function populateSensors(sensors) {
  const container = document.getElementById('sensors-container');
  container.innerHTML = '';
  sensors.forEach((sensor) => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = sensor.id;
    checkbox.name = 'sensor';
    checkbox.addEventListener('change', triggerAutoEvaluate);
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(sensor.name));
    container.appendChild(label);
  });
}

function buildRoleCheckboxes() {
  const roleContainer = document.getElementById('role-checkboxes');
  const requiredContainer = document.getElementById('required-role-checkboxes');
  roleContainer.innerHTML = '';
  requiredContainer.innerHTML = '';

  ROLE_OPTIONS.forEach((role) => {
    roleContainer.appendChild(createRoleCheckbox(role, 'role'));
    requiredContainer.appendChild(createRoleCheckbox(role, 'required-role'));
  });
}

function createRoleCheckbox(role, name) {
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.value = role;
  checkbox.name = name;
  checkbox.addEventListener('change', triggerAutoEvaluate);
  label.appendChild(checkbox);
  label.appendChild(document.createTextNode(formatRoleLabel(role)));
  return label;
}

function formatRoleLabel(role) {
  return role
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function loadEnvironmentSelection() {
  const saved = localStorage.getItem(STORAGE_KEYS.environment);
  if (!saved) return;
  try {
    const env = JSON.parse(saved);
    if (env.environment) {
      document.getElementById('environment-select').value = env.environment;
    }
    if (env.altitudeBand) {
      document.getElementById('altitude-select').value = env.altitudeBand;
    }
    if (env.temperatureBand) {
      document.getElementById('temperature-select').value = env.temperatureBand;
    }
  } catch (error) {
    console.warn('Failed to load environment selection', error);
  }
}

function bindEnvironmentPersistence() {
  ['environment-select', 'altitude-select', 'temperature-select'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', persistEnvironmentSelection);
    }
  });
}

function bindAutoEvaluation() {
  const changeListeners = [
    'compute-select',
    'battery-select',
    'environment-select',
    'altitude-select',
    'temperature-select',
    'lat-input',
    'lon-input',
    'elevation-input',
  ];

  changeListeners.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', triggerAutoEvaluate);
    }
  });

  const inputListeners = ['mission-name', 'node-name', 'node-notes'];
  inputListeners.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', triggerAutoEvaluate);
    }
  });

  const rfChainsContainer = document.getElementById('rf-chains-container');
  if (rfChainsContainer) {
    rfChainsContainer.addEventListener('change', (event) => {
      if (event.target.tagName === 'SELECT') {
        triggerAutoEvaluate();
      }
    });
  }
}

function persistEnvironmentSelection() {
  const environment = document.getElementById('environment-select').value || 'lab';
  const altitudeBand = document.getElementById('altitude-select').value || 'sea_level';
  const temperatureBand = document.getElementById('temperature-select').value || 'temperate';
  const payload = { environment, altitudeBand, temperatureBand };
  localStorage.setItem(STORAGE_KEYS.environment, JSON.stringify(payload));
}

function loadConstraints() {
  const stored = localStorage.getItem(STORAGE_KEYS.constraints);
  if (!stored) return;
  try {
    const parsed = JSON.parse(stored);
    activeConstraints = {
      maxWeight: parsed.maxWeight ?? null,
      minRuntime: parsed.minRuntime ?? null,
      requiredRoles: parsed.requiredRoles || [],
    };

    if (parsed.maxWeight !== undefined) {
      document.getElementById('max-weight').value = parsed.maxWeight;
    }
    if (parsed.minRuntime !== undefined) {
      document.getElementById('min-runtime').value = parsed.minRuntime;
    }

    const requiredRoleInputs = document.querySelectorAll('input[name="required-role"]');
    requiredRoleInputs.forEach((input) => {
      input.checked = activeConstraints.requiredRoles.includes(input.value);
    });
    renderDesignsList();
  } catch (error) {
    console.warn('Failed to load constraints', error);
  }
}

function bindConstraintInputs() {
  const maxWeightInput = document.getElementById('max-weight');
  const minRuntimeInput = document.getElementById('min-runtime');
  const requiredRoleInputs = document.querySelectorAll('input[name="required-role"]');

  maxWeightInput.addEventListener('input', () => {
    activeConstraints.maxWeight = maxWeightInput.value ? Number(maxWeightInput.value) : null;
    persistConstraints();
    renderDesignsList();
  });

  minRuntimeInput.addEventListener('input', () => {
    activeConstraints.minRuntime = minRuntimeInput.value ? Number(minRuntimeInput.value) : null;
    persistConstraints();
    renderDesignsList();
  });

  requiredRoleInputs.forEach((input) => {
    input.addEventListener('change', () => {
      activeConstraints.requiredRoles = Array.from(requiredRoleInputs)
        .filter((el) => el.checked)
        .map((el) => el.value);
      persistConstraints();
      renderDesignsList();
    });
  });
}

function persistConstraints() {
  localStorage.setItem(STORAGE_KEYS.constraints, JSON.stringify(activeConstraints));
}

function loadSavedDesigns() {
  const stored = localStorage.getItem(STORAGE_KEYS.designs);
  if (stored) {
    try {
      savedDesigns = (JSON.parse(stored) || []).map((design) => {
        const runtime = design.runtime || {
          basePowerW: design.totalPowerW || 0,
          environmentPowerFactor: 1,
          capacityFactor: design.capacityFactor ?? 1,
          baseRuntimeHours: design.idealRuntimeHours || design.adjustedRuntimeHours || 0,
          environmentRuntimeHours:
            design.environmentRuntimeHours || design.adjustedRuntimeHours || design.idealRuntimeHours || design.runtimeHours || 0,
          adjustedRuntimeHours: design.adjustedRuntimeHours || 0,
        };
        return {
          ...design,
          runtime,
          environmentRuntimeHours: design.environmentRuntimeHours ?? runtime.environmentRuntimeHours,
          passthrough: design.passthrough || {},
        };
      });
    } catch (error) {
      console.warn('Failed to parse saved designs', error);
      savedDesigns = [];
    }
  }
  if (savedDesigns.length && savedDesigns[0].missionName) {
    missionName = savedDesigns[0].missionName;
    const missionInput = document.getElementById('mission-name');
    if (missionInput) missionInput.value = missionName;
  }
  renderDesignsList();
}

function persistDesigns() {
  localStorage.setItem(STORAGE_KEYS.designs, JSON.stringify(savedDesigns));
}

function handlePresetChange(event) {
  const presetId = event.target.value;
  const descriptionEl = document.getElementById('preset-description');
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) {
    descriptionEl.textContent = 'Pick a preset to pre-fill radios, antennas, and sensors.';
    lastPresetWarnings = [];
    return;
  }

  descriptionEl.textContent = preset.description;
  applyPreset(preset);
  handleEvaluate();
}

function applyPreset(preset) {
  if (!components) return;

  lastPresetWarnings = [];
  const catalog = getCatalog();
  const { computeId, environment, batteryId, rfChains = [], sensorIds = [] } = preset.config;

  setSelectValue('compute-select', computeId, catalog.compute, 'compute');
  setSelectValue('battery-select', batteryId, catalog.batteries, 'battery');
  setEnvironment(environment);
  if (preset.config.altitudeBand) {
    document.getElementById('altitude-select').value = preset.config.altitudeBand;
  }
  if (preset.config.temperatureBand) {
    document.getElementById('temperature-select').value = preset.config.temperatureBand;
  }
  if (preset.config.location) {
    const { lat, lon, elevation_m: elevation } = preset.config.location;
    document.getElementById('lat-input').value = lat ?? '';
    document.getElementById('lon-input').value = lon ?? '';
    document.getElementById('elevation-input').value = elevation ?? '';
  }
  if (preset.config.missionName) {
    missionName = preset.config.missionName;
    document.getElementById('mission-name').value = missionName;
  }
  setSensors(sensorIds);

  const container = document.getElementById('rf-chains-container');
  container.innerHTML = '';
  rfChains.forEach((chain) => {
    const radioOk = catalog.radios.some((r) => r.id === chain.radioId);
    const antennaId = chain.antennaIds?.[0] ?? '';
    const antennaOk = catalog.antennas.some((a) => a.id === antennaId);

    if (!radioOk) {
      lastPresetWarnings.push(`Preset radio not found: ${chain.radioId}`);
    }
    if (!antennaOk && antennaId) {
      lastPresetWarnings.push(`Preset antenna not found: ${antennaId}`);
    }

    addRfChain({ radioId: radioOk ? chain.radioId : '', antennaId: antennaOk ? antennaId : '' });
  });

  if (rfChains.length === 0) {
    addRfChain();
  }

  updateRfCapacity();
}

function setSelectValue(selectId, value, items, label) {
  const select = document.getElementById(selectId);
  const exists = items.some((item) => item.id === value);
  if (exists) {
    select.value = value;
  } else if (value) {
    lastPresetWarnings.push(`Preset ${label} not found: ${value}`);
  }
}

function setEnvironment(environment) {
  const envSelect = document.getElementById('environment-select');
  if (environment) {
    envSelect.value = environment;
  }
}

function setSensors(sensorIds) {
  const sensors = Array.from(document.querySelectorAll('input[name="sensor"]'));
  sensors.forEach((checkbox) => {
    checkbox.checked = sensorIds.includes(checkbox.value);
  });
}

function addRfChain(prefill = {}) {
  if (!components) return;
  const maxChains = getSelectedCompute()?.max_rf_chains || 1;
  const container = document.getElementById('rf-chains-container');
  const currentChains = container.querySelectorAll('.rf-chain-row').length;

  if (currentChains >= maxChains) {
    const countEl = document.getElementById('rf-chain-count');
    countEl.textContent = `RF chains: ${currentChains} / ${maxChains} available (at capacity)`;
    return;
  }

  const row = document.createElement('div');
  row.className = 'rf-chain-row';

  const radioSelect = document.getElementById('radio-template').cloneNode(true);
  radioSelect.id = '';
  radioSelect.style.display = '';
  radioSelect.value = prefill.radioId || '';
  radioSelect.addEventListener('change', () => {
    updateRfCapacity();
    triggerAutoEvaluate();
  });

  const antennaSelect = document.getElementById('antenna-template').cloneNode(true);
  antennaSelect.id = '';
  antennaSelect.style.display = '';
  antennaSelect.value = prefill.antennaId || '';
  antennaSelect.addEventListener('change', () => {
    updateRfCapacity();
    triggerAutoEvaluate();
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    row.remove();
    updateRfCapacity();
    triggerAutoEvaluate();
  });

  row.appendChild(radioSelect);
  row.appendChild(antennaSelect);
  row.appendChild(removeBtn);

  container.appendChild(row);
  updateRfCapacity();
  triggerAutoEvaluate();
}

function updateRfCapacity() {
  const compute = getSelectedCompute();
  const container = document.getElementById('rf-chains-container');
  const countEl = document.getElementById('rf-chain-count');
  const used = container.querySelectorAll('.rf-chain-row').length;
  const max = compute?.max_rf_chains || 1;
  countEl.textContent = `RF chains: ${used} / ${max} available`;
  if (used > max) {
    countEl.textContent += ' (over capacity)';
  }
}

function getCatalog() {
  return {
    compute: components.compute || components.hosts || [],
    radios: components.radios || [],
    antennas: components.antennas || [],
    batteries: components.batteries || [],
    sensors: components.sensors || [],
  };
}

function getSelectedCompute() {
  if (!components) return null;
  const computeId = document.getElementById('compute-select').value;
  return getCatalog().compute.find((item) => item.id === computeId) || null;
}

function handleEvaluate(options = {}) {
  const { allowIncomplete = false } = options;
  clearError();
  if (!components) {
    if (!allowIncomplete) {
      showError('Component catalog not loaded yet.');
    }
    return;
  }

  const catalog = getCatalog();
  const computeId = document.getElementById('compute-select').value;
  const batteryId = document.getElementById('battery-select').value;
  const environment = document.getElementById('environment-select').value || 'lab';
  const altitudeBand = document.getElementById('altitude-select').value || 'sea_level';
  const temperatureBand = document.getElementById('temperature-select').value || 'temperate';
  const sensorIds = Array.from(document.querySelectorAll('input[name="sensor"]:checked')).map((el) => el.value);
  const nodeName = (document.getElementById('node-name').value || '').trim();
  const nodeNotes = (document.getElementById('node-notes').value || '').trim();
  const selectedRoles = getSelectedRoles();
  missionName = (document.getElementById('mission-name').value || '').trim() || missionName;

  const lat = parseFloat(document.getElementById('lat-input').value);
  const lon = parseFloat(document.getElementById('lon-input').value);
  const elevation = parseFloat(document.getElementById('elevation-input').value);
  const location = {};
  if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
    location.lat = lat;
    location.lon = lon;
  }
  if (!Number.isNaN(elevation)) {
    location.elevation_m = elevation;
  }

  persistEnvironmentSelection();

  if (!computeId || !batteryId) {
    if (!allowIncomplete) {
      showError('Select compute and battery to evaluate.');
    }
    return;
  }

  const compute = catalog.compute.find((item) => item.id === computeId);
  const battery = catalog.batteries.find((item) => item.id === batteryId);
  const selectedSensors = catalog.sensors.filter((sensor) => sensorIds.includes(sensor.id));

  if (!compute || !battery) {
    showError('Invalid selection. Reload the page and try again.');
    return;
  }

  const { chains: rfChains, warnings: chainWarnings } = getRfChainsFromUI(catalog);
  if (rfChains.length === 0) {
    if (!allowIncomplete) {
      showError('Add at least one RF chain with both a radio and an antenna.');
    }
    return;
  }

  const nodeConfig = {
    compute,
    battery,
    rfChains,
    sensors: selectedSensors,
    environment,
    altitudeBand,
    temperatureBand,
    location,
  };

  const powerProfile = estimatePowerProfile(nodeConfig);
  const idealRuntimeHours = estimateRuntime(powerProfile.basePowerW, battery);
  const environmentRuntimeHours = estimateRuntime(powerProfile.totalPowerW, battery);
  const capacityFactor = (batteryCapacityFactor[altitudeBand] || {})[temperatureBand] ?? 1.0;
  const adjustedRuntimeHours = environmentRuntimeHours * capacityFactor;
  const rangeInfo = rfChains.map((chain) => ({
    ...chain,
    range: estimateRange(chain.radio, chain.antenna, environment),
  }));

  const runtimeBreakdown = {
    basePowerW: powerProfile.basePowerW,
    environmentPowerFactor: powerProfile.environmentPowerFactor,
    capacityFactor,
    baseRuntimeHours: idealRuntimeHours,
    environmentRuntimeHours,
    adjustedRuntimeHours,
  };

  const capabilities = deriveCapabilities(rfChains, selectedSensors);
  const recommendedRole = recommendRole({ rfChains, compute, sensors: selectedSensors, runtimeHours: adjustedRuntimeHours });
  const totalWeightKg = computeTotalWeight(nodeConfig);

  const warnings = [];
  if (adjustedRuntimeHours > 0 && adjustedRuntimeHours < 2) {
    warnings.push('Adjusted runtime under 2 hours – consider a larger battery or lower draw components.');
  }
  if (rfChains.length > (compute.max_rf_chains || rfChains.length)) {
    warnings.push(`Warning: this host is configured with more RF chains than its modeled capacity (${rfChains.length} used vs ${compute.max_rf_chains || 'unknown'} available).`);
  }
  warnings.push(...chainWarnings, ...lastPresetWarnings);

  const constraintNotes = evaluateConstraints({ totalWeightKg, adjustedRuntimeHours, roles: selectedRoles }, true);
  warnings.push(...constraintNotes.warnings);

  lastEvaluation = {
    id: allocateNodeId(nodeName || computeId || 'node'),
    name: nodeName,
    notes: nodeNotes,
    roles: selectedRoles,
    nodeConfig,
    missionName,
    location,
    totalPowerW: powerProfile.totalPowerW,
    idealRuntimeHours,
    adjustedRuntimeHours,
    capacityFactor,
    rangeInfo,
    capabilities,
    recommendedRole,
    totalWeightKg,
    runtimeBreakdown,
  };

  renderResults({
    nodeConfig,
    totalPowerW: powerProfile.totalPowerW,
    idealRuntimeHours,
    environmentRuntimeHours,
    adjustedRuntimeHours,
    rangeInfo,
    capabilities,
    recommendedRole,
    warnings,
    totalWeightKg,
    capacityFactor,
    runtimeBreakdown,
    selectedRoles,
    nodeName,
    nodeNotes,
  });
}

function getRfChainsFromUI(catalog) {
  const container = document.getElementById('rf-chains-container');
  const rows = Array.from(container.querySelectorAll('.rf-chain-row'));
  const chains = [];
  const warnings = [];

  rows.forEach((row, index) => {
    const radioId = row.querySelector('select:nth-child(1)').value;
    const antennaId = row.querySelector('select:nth-child(2)').value;

    if (!radioId && !antennaId) return;
    if (!radioId || !antennaId) {
      warnings.push(`RF chain ${index + 1} is incomplete and was skipped.`);
      return;
    }

    const radio = catalog.radios.find((r) => r.id === radioId);
    const antenna = catalog.antennas.find((a) => a.id === antennaId);

    if (!radio) {
      warnings.push(`Radio not found for chain ${index + 1} (${radioId}).`);
      return;
    }
    if (!antenna) {
      warnings.push(`Antenna not found for chain ${index + 1} (${antennaId}).`);
      return;
    }

    chains.push({ radio, antenna });
  });

  return { chains, warnings };
}

function estimatePowerProfile(config) {
  const { compute, rfChains, sensors, environment } = config;
  const hostPower = ((compute.power_w_idle || 0) + (compute.power_w_load || 0)) / 2;
  const radioPower = rfChains.reduce((sum, chain) => sum + (((chain.radio.power_w_tx || 0) + (chain.radio.power_w_rx || 0)) / 2), 0);
  const sensorPower = sensors.reduce((sum, sensor) => sum + (sensor.power_w || 0), 0);

  const basePowerW = hostPower + radioPower + sensorPower;
  const environmentPowerFactorValue = environmentPowerFactor[environment] ?? 1.0;
  const totalPowerW = basePowerW * environmentPowerFactorValue;
  return {
    basePowerW: Number.isFinite(basePowerW) && basePowerW > 0 ? basePowerW : 0,
    environmentPowerFactor: environmentPowerFactorValue,
    totalPowerW: Number.isFinite(totalPowerW) && totalPowerW > 0 ? totalPowerW : 0,
  };
}

function estimateRuntime(totalPowerW, battery) {
  if (!battery || !battery.capacity_wh || totalPowerW <= 0) {
    return 0;
  }
  return battery.capacity_wh / totalPowerW;
}

function formatRuntimeLabel(hours) {
  if (!hours || hours <= 0) return 'N/A';
  const minutes = Math.round(hours * 60);
  if (hours < 1) return `${minutes} min`;
  return `${hours.toFixed(1)} h (${minutes} min)`;
}

function componentWeightKg(component) {
  if (!component) return 0;
  if (typeof component.weight_kg === 'number') return component.weight_kg;
  if (typeof component.mass_kg === 'number') return component.mass_kg;
  return 0;
}

function computeTotalWeight(config) {
  const hostWeight = componentWeightKg(config.compute);
  const batteryWeight = componentWeightKg(config.battery);
  const sensorWeight = (config.sensors || []).reduce((sum, sensor) => sum + componentWeightKg(sensor), 0);
  const rfWeight = (config.rfChains || []).reduce(
    (sum, chain) => sum + componentWeightKg(chain.radio) + componentWeightKg(chain.antenna),
    0,
  );

  const total = hostWeight + batteryWeight + sensorWeight + rfWeight;
  return Math.round(total * 100) / 100;
}

function getSelectedRoles() {
  return Array.from(document.querySelectorAll('input[name="role"]:checked')).map((el) => el.value);
}

function estimateRange(radio, antenna, environment) {
  if (!radio) {
    return { range_m: null, description: 'Radio not specified' };
  }

  if (radio.radio_type === 'cellular') {
    return { range_m: null, description: 'Backhaul via 4G/5G network' };
  }

  const bands = radio.bands || [];
  let baseline = 0;

  if (radio.radio_type === 'wifi') {
    if (bands.some((band) => band.includes('2.4'))) {
      baseline = 150;
    } else if (bands.some((band) => band.includes('5'))) {
      baseline = 80;
    } else {
      baseline = 100;
    }
  } else if (radio.radio_type === 'lora') {
    baseline = 2000;
  } else if (radio.radio_type === 'analog_fpv') {
    baseline = 1000;
  } else if (radio.radio_type === 'sdr') {
    baseline = 500;
  } else {
    baseline = 100;
  }

  const gain = antenna?.gain_dbi ?? antenna?.gain_db ?? radio.antenna_gain_db ?? 0;
  let gainFactor = 1.0;
  if (gain >= 14) {
    gainFactor = 3.0;
  } else if (gain >= 9) {
    gainFactor = 2.0;
  } else if (gain >= 4) {
    gainFactor = 1.5;
  }

  const envFactor = environmentRangeFactor[environment] ?? 1.0;
  let range = baseline * gainFactor * envFactor;
  range = Math.max(20, Math.min(range, 5000));

  return { range_m: Math.round(range), description: `${radio.radio_type.toUpperCase()} link estimate` };
}

function describeRangeCategory(rangeInfo) {
  if (!rangeInfo?.length) return { category: 'unknown', label: 'Range not modeled' };
  const maxMeters = rangeInfo.reduce((max, info) => {
    if (info.range?.range_m) return Math.max(max, info.range.range_m);
    if (info.range?.range_km) return Math.max(max, info.range.range_km * 1000);
    return max;
  }, 0);

  if (maxMeters >= 2000) return { category: 'long', label: 'Long range profile' };
  if (maxMeters >= 400) return { category: 'medium', label: 'Medium range profile' };
  if (maxMeters > 0) return { category: 'short', label: 'Short range profile' };
  return { category: 'unknown', label: 'Range not modeled' };
}

function deriveCapabilities(rfChains, sensors) {
  const caps = new Set();

  rfChains.forEach(({ radio }) => {
    if (radio.radio_type === 'wifi' && radio.supports_monitor) {
      caps.add('WiFi recon / monitor mode scanning');
    }
    if (radio.radio_type === 'wifi' && radio.supports_csi) {
      caps.add('Potential WiFi CSI / channel analysis (driver support required)');
    }
    if (radio.radio_type === 'lora') {
      caps.add('LoRa telemetry / low-rate sensor network');
    }
    if (radio.radio_type === 'analog_fpv') {
      caps.add('Analog FPV video link');
    }
    if (radio.radio_type === 'sdr') {
      caps.add('SDR-based RF capture / analysis');
    }
    if (radio.radio_type === 'cellular') {
      caps.add('Cellular backhaul');
    }
  });

  const hasCamera = sensors.some((sensor) => sensor.sensor_type === 'camera');
  const hasGps = sensors.some((sensor) => sensor.sensor_type === 'gps');
  const hasImu = sensors.some((sensor) => sensor.sensor_type === 'imu');

  if (hasCamera) {
    caps.add('Video / imagery capture');
  }
  if (hasGps) {
    caps.add('GPS position/time reference');
  }
  if (hasImu) {
    caps.add('IMU / motion sensing');
  }

  return Array.from(caps);
}

function recommendRole({ rfChains, compute, sensors, runtimeHours }) {
  const cpuScore = compute.cpu_score || 0;
  const hasCamera = sensors.some((sensor) => sensor.sensor_type === 'camera');
  const hasWifiMonitor = rfChains.some(({ radio }) => radio.radio_type === 'wifi' && radio.supports_monitor);
  const hasWifiCsi = rfChains.some(({ radio }) => radio.radio_type === 'wifi' && radio.supports_csi);
  const hasLoRa = rfChains.some(({ radio }) => radio.radio_type === 'lora');
  const hasAnalog = rfChains.some(({ radio }) => radio.radio_type === 'analog_fpv');
  const hasSdr = rfChains.some(({ radio }) => radio.radio_type === 'sdr');
  const hasCellular = rfChains.some(({ radio }) => radio.radio_type === 'cellular');

  let role = 'General-purpose RF node';

  if (hasWifiCsi && cpuScore >= 7 && runtimeHours >= 2) {
    role = 'Experimental WiFi CSI / through-wall sensing node';
  } else if (hasWifiMonitor && cpuScore >= 5 && runtimeHours >= 2) {
    role = 'WiFi recon / RF mapping node';
  } else if (hasLoRa && runtimeHours >= 12) {
    role = 'Low-power perimeter / telemetry node';
  } else if (hasAnalog && hasCamera) {
    role = 'FPV video relay / payload node';
  } else if (hasSdr && cpuScore >= 6) {
    role = 'RF capture / survey node';
  }

  if (hasCellular) {
    role = `${role} with LTE/5G backhaul`;
  }

  return role;
}

function describeAltitude(band) {
  const labels = {
    sea_level: 'Sea level / < 500 m',
    band_1000_2000: '1000–2000 m',
    band_2000_3000: '2000–3000 m',
    above_3000: '> 3000 m',
  };
  return labels[band] || band.replaceAll('_', ' ');
}

function describeTemperature(band) {
  const labels = {
    hot: 'Hot',
    temperate: 'Temperate',
    cold: 'Cold',
    very_cold: 'Very cold',
  };
  return labels[band] || band;
}

function evaluateConstraints(metrics, includeWarnings = false) {
  const warnings = [];
  let passes = true;

  if (activeConstraints.maxWeight && metrics.totalWeightKg > activeConstraints.maxWeight) {
    passes = false;
    if (includeWarnings) {
      warnings.push(`Exceeds max weight (${metrics.totalWeightKg.toFixed(2)} kg > ${activeConstraints.maxWeight} kg).`);
    }
  }

  if (activeConstraints.minRuntime && metrics.adjustedRuntimeHours < activeConstraints.minRuntime) {
    passes = false;
    if (includeWarnings) {
      warnings.push(
        `Adjusted runtime below requirement (${metrics.adjustedRuntimeHours.toFixed(1)} h < ${activeConstraints.minRuntime} h).`,
      );
    }
  }

  if (activeConstraints.requiredRoles?.length) {
    const roles = metrics.roles || [];
    const missing = activeConstraints.requiredRoles.filter((role) => !roles.includes(role));
    if (missing.length) {
      passes = false;
      if (includeWarnings) {
        warnings.push(`Missing required roles: ${missing.map((role) => formatRoleLabel(role)).join(', ')}`);
      }
    }
  }

  return includeWarnings ? { passes, warnings } : { passes };
}

function renderDesignsList() {
  const container = document.getElementById('designs-list');
  if (!savedDesigns.length) {
    container.textContent = 'No saved designs yet.';
    return;
  }

  const filtered = savedDesigns.filter((design) =>
    evaluateConstraints(
      {
        totalWeightKg: design.totalWeightKg,
        adjustedRuntimeHours: design.adjustedRuntimeHours,
        roles: design.roles,
      },
      false,
    ).passes,
  );

  const hiddenCount = savedDesigns.length - filtered.length;
  container.innerHTML = '';

  if (hiddenCount > 0) {
    const note = document.createElement('p');
    note.className = 'muted small';
    note.textContent = `${hiddenCount} design(s) hidden by constraints.`;
    container.appendChild(note);
  }

  filtered.forEach((design) => {
    const entry = document.createElement('div');
    entry.className = 'design-entry';

    const title = document.createElement('h4');
    title.textContent = design.name || 'Unnamed node design';
    entry.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `
      <span>Adjusted runtime: ${design.adjustedRuntimeHours.toFixed(1)} h</span>
      <span>Approx. weight: ${design.totalWeightKg.toFixed(2)} kg</span>
      <span>Env: ${design.environment.replaceAll('_', ' ')} | Alt: ${describeAltitude(design.altitudeBand)} | Temp: ${describeTemperature(design.temperatureBand)}</span>
      ${design.location && design.location.lat !== undefined ? `<span>Loc: ${design.location.lat.toFixed(3)}, ${design.location.lon.toFixed(3)}${design.location.elevation_m ? ` (${design.location.elevation_m} m)` : ''}</span>` : ''}
      <span>Mission: ${design.missionName || missionName}</span>
    `;
    entry.appendChild(meta);

    if (design.roles?.length) {
      const roleRow = document.createElement('div');
      design.roles.forEach((role) => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = formatRoleLabel(role);
        roleRow.appendChild(tag);
      });
      entry.appendChild(roleRow);
    }

    const actions = document.createElement('div');
    actions.className = 'design-actions';

    const roleLabel = document.createElement('span');
    roleLabel.className = 'muted small';
    roleLabel.textContent = design.recommendedRole || '';
    actions.appendChild(roleLabel);

    const buttons = document.createElement('div');
    buttons.className = 'design-action-buttons';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ghost-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => loadDesignIntoConfig(design));
    buttons.appendChild(editBtn);

    const duplicateBtn = document.createElement('button');
    duplicateBtn.type = 'button';
    duplicateBtn.className = 'ghost-btn';
    duplicateBtn.textContent = 'Duplicate';
    duplicateBtn.addEventListener('click', () => duplicateDesign(design));
    buttons.appendChild(duplicateBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteDesign(design.id));
    buttons.appendChild(deleteBtn);

    actions.appendChild(buttons);

    entry.appendChild(actions);
    container.appendChild(entry);
  });
}

function deleteDesign(id) {
  savedDesigns = savedDesigns.filter((design) => design.id !== id);
  persistDesigns();
  renderDesignsList();
}

function loadDesignIntoConfig(design) {
  if (!design?.parts || !components) return;
  const catalog = getCatalog();

  setSelectValue('compute-select', design.parts.compute.id, catalog.compute, 'compute');
  setSelectValue('battery-select', design.parts.battery.id, catalog.batteries, 'battery');
  setEnvironment(design.environment);
  document.getElementById('altitude-select').value = design.altitudeBand || 'sea_level';
  document.getElementById('temperature-select').value = design.temperatureBand || 'temperate';

  if (design.location) {
    document.getElementById('lat-input').value = design.location.lat ?? '';
    document.getElementById('lon-input').value = design.location.lon ?? '';
    document.getElementById('elevation-input').value = design.location.elevation_m ?? '';
  }

  const nameInput = document.getElementById('node-name');
  if (nameInput) nameInput.value = design.name || '';
  const notesInput = document.getElementById('node-notes');
  if (notesInput) notesInput.value = design.notes || '';

  if (design.missionName) {
    missionName = design.missionName;
    document.getElementById('mission-name').value = missionName;
  }

  const roleInputs = document.querySelectorAll('input[name="role"]');
  roleInputs.forEach((input) => {
    input.checked = design.roles?.includes(input.value) || false;
  });

  setSensors(design.parts.sensors?.map((sensor) => sensor.id) || []);

  const container = document.getElementById('rf-chains-container');
  container.innerHTML = '';
  (design.parts.rfChains || []).forEach((chain) => {
    addRfChain({ radioId: chain.radio.id, antennaId: chain.antenna.id });
  });
  updateRfCapacity();
  handleEvaluate();
}

function duplicateDesign(design) {
  if (!design) return;
  const copy = JSON.parse(JSON.stringify(design));
  copy.id = allocateNodeId(`${design.id || 'node'}-copy`);
  copy.name = `${design.name || 'Node design'} (copy)`;
  savedDesigns.push(copy);
  persistDesigns();
  renderDesignsList();
}

function handleSaveDesign() {
  if (!lastEvaluation) {
    showError('Evaluate a node before saving.');
    return;
  }

  const nameInput = document.getElementById('node-name');
  const notesInput = document.getElementById('node-notes');
  const name = (nameInput?.value || '').trim() || `Node design ${savedDesigns.length + 1}`;
  const notes = (notesInput?.value || '').trim();
  const roles = getSelectedRoles();

  const { nodeConfig } = lastEvaluation;
  const design = {
    id: allocateNodeId(name || nodeConfig.compute.id),
    name,
    notes,
    missionName,
    originTool: 'node',
    roles,
    environment: nodeConfig.environment,
    altitudeBand: nodeConfig.altitudeBand,
    temperatureBand: nodeConfig.temperatureBand,
    location: nodeConfig.location,
    totalPowerW: Number(lastEvaluation.totalPowerW.toFixed(2)),
    idealRuntimeHours: Number(lastEvaluation.idealRuntimeHours.toFixed(2)),
    environmentRuntimeHours: Number(lastEvaluation.runtimeBreakdown.environmentRuntimeHours.toFixed(2)),
    adjustedRuntimeHours: Number(lastEvaluation.adjustedRuntimeHours.toFixed(2)),
    capacityFactor: Number(lastEvaluation.capacityFactor.toFixed(2)),
    runtime: lastEvaluation.runtimeBreakdown,
    totalWeightKg: Number(lastEvaluation.totalWeightKg.toFixed(2)),
    capabilities: lastEvaluation.capabilities,
    recommendedRole: lastEvaluation.recommendedRole,
    rangeInfo: lastEvaluation.rangeInfo.map((info) => ({
      radio: { id: info.radio.id, name: info.radio.name, type: info.radio.radio_type },
      antenna: { id: info.antenna.id, name: info.antenna.name },
      range: info.range,
    })),
    rfBands: nodeConfig.rfChains.flatMap((chain) => deriveRfBands(chain.radio)),
    passthrough: {},
    parts: {
      compute: {
        id: nodeConfig.compute.id,
        name: nodeConfig.compute.name,
        cpu: nodeConfig.compute.cpu,
        ram_gb: nodeConfig.compute.ram_gb,
        storage: nodeConfig.compute.storage,
        power_w_idle: nodeConfig.compute.power_w_idle,
        power_w_load: nodeConfig.compute.power_w_load,
        weight_kg: nodeConfig.compute.weight_kg,
        tags: nodeConfig.compute.tags || [],
      },
      battery: {
        id: nodeConfig.battery.id,
        name: nodeConfig.battery.name,
        capacity_wh: nodeConfig.battery.capacity_wh,
        chemistry: nodeConfig.battery.chemistry,
        tags: nodeConfig.battery.tags || [],
      },
      sensors: (nodeConfig.sensors || []).map((s) => ({
        id: s.id,
        name: s.name,
        sensor_type: s.sensor_type,
        tags: s.tags || [],
      })),
      rfChains: (nodeConfig.rfChains || []).map((chain) => ({
        radio: {
          id: chain.radio.id,
          name: chain.radio.name,
          radio_type: chain.radio.radio_type,
          band: chain.radio.band || chain.radio.bands?.join('/'),
          bands: chain.radio.bands,
          tags: chain.radio.tags || [],
        },
        antenna: {
          id: chain.antenna.id,
          name: chain.antenna.name,
          gain_dbi: chain.antenna.gain_dbi,
          tags: chain.antenna.tags || [],
        },
      })),
    },
  };

  savedDesigns.push(design);
  persistDesigns();
  renderDesignsList();

  const panel = document.getElementById('results-panel');
  const confirmation = document.createElement('div');
  confirmation.className = 'warning-note';
  confirmation.textContent = 'Design saved locally. Use Export Node Designs to download JSON.';
  panel.appendChild(confirmation);
}

function exportDesigns() {
  if (!savedDesigns.length) {
    showError('Save at least one design before exporting.');
    return;
  }

  const payload = buildMissionProjectPayload();

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'mission_project.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildConstraintsPayload() {
  const constraints = [];
  if (activeConstraints.maxWeight) {
    constraints.push({ id: 'constraint-weight', type: 'max_weight_kg', value: activeConstraints.maxWeight });
  }
  if (activeConstraints.minRuntime) {
    constraints.push({ id: 'constraint-runtime', type: 'min_runtime_hours', value: activeConstraints.minRuntime });
  }
  if (activeConstraints.requiredRoles && activeConstraints.requiredRoles.length) {
    constraints.push({ id: 'constraint-roles', type: 'required_roles', value: activeConstraints.requiredRoles });
  }
  return constraints;
}

function buildMissionProjectPayload() {
  const platforms = {};
  const nodes = savedDesigns
    .map((design) => {
      if (!design.parts?.compute || !design.parts?.battery) return null;
      const platformId = `platform-${design.parts.compute.id}`;
      const compute = design.parts.compute;
      if (!platforms[platformId]) {
        platforms[platformId] = {
          id: platformId,
          name: compute.name,
          role: 'compute',
          origin_tool: design.originTool || 'node',
          specs: {
            cpu: compute.cpu,
            ram_gb: compute.ram_gb,
            storage: compute.storage,
            power_idle_w: compute.power_w_idle,
            power_load_w: compute.power_w_load,
            weight_kg: compute.weight_kg,
          },
        };
      }

      const radios = design.parts.rfChains.map((chain) => ({
        id: chain.radio.id,
        name: chain.radio.name,
        radio_type: chain.radio.radio_type,
        bands: chain.radio.bands || (chain.radio.band ? chain.radio.band.split('/') : []),
      }));
      const antennas = design.parts.rfChains.map((chain) => ({
        id: chain.antenna.id,
        name: chain.antenna.name,
        gain_dbi: chain.antenna.gain_dbi,
        pattern: chain.antenna.pattern,
      }));
      const runtime =
        design.runtime ||
        {
          basePowerW: design.totalPowerW,
          environmentPowerFactor: 1,
          capacityFactor: design.capacityFactor ?? 1,
          baseRuntimeHours: design.idealRuntimeHours,
          environmentRuntimeHours: design.environmentRuntimeHours || design.adjustedRuntimeHours,
          adjustedRuntimeHours: design.adjustedRuntimeHours,
        };
      const estimatedRuntimeHours = Number((runtime.adjustedRuntimeHours ?? design.adjustedRuntimeHours).toFixed(2));
      const baseRuntimeHours = Number((runtime.baseRuntimeHours ?? design.idealRuntimeHours).toFixed(2));
      const environmentRuntimeHours = Number(
        (runtime.environmentRuntimeHours ?? runtime.adjustedRuntimeHours ?? design.adjustedRuntimeHours).toFixed(2),
      );
      const powerProfile = {
        estimated_draw_w: design.totalPowerW,
        base_draw_w: runtime.basePowerW || design.totalPowerW,
        environment_power_factor: runtime.environmentPowerFactor ?? 1,
        ideal_runtime_h: baseRuntimeHours,
        environment_runtime_h: environmentRuntimeHours,
        adjusted_runtime_h: estimatedRuntimeHours,
        capacity_factor: runtime.capacityFactor ?? design.capacityFactor ?? 1,
      };
      const nodeEntry = {
        ...design.passthrough,
        id: design.id,
        name: design.name,
        origin_tool: design.originTool || 'node',
        platform_id: platformId,
        roles: design.roles || [],
        compute: {
          id: design.parts.compute.id,
          name: design.parts.compute.name,
          cpu: design.parts.compute.cpu,
          ram_gb: design.parts.compute.ram_gb,
          storage: design.parts.compute.storage,
          weight_kg: design.parts.compute.weight_kg,
        },
        radios,
        antennas,
        sensors: (design.parts.sensors || []).map((sensor) => ({
          id: sensor.id,
          name: sensor.name,
          type: sensor.sensor_type,
          tags: sensor.tags || [],
        })),
        battery: {
          id: design.parts.battery.id,
          capacity_wh: design.parts.battery.capacity_wh,
          chemistry: design.parts.battery.chemistry,
          tags: design.parts.battery.tags || [],
        },
        power_profile: powerProfile,
        power: {
          battery: {
            id: design.parts.battery.id,
            capacity_wh: design.parts.battery.capacity_wh,
            chemistry: design.parts.battery.chemistry,
            tags: design.parts.battery.tags || [],
          },
          estimated_draw_w: design.totalPowerW,
          ideal_runtime_h: baseRuntimeHours,
          adjusted_runtime_h: estimatedRuntimeHours,
          capacity_factor: runtime.capacityFactor ?? design.capacityFactor ?? 1,
        },
        environment: {
          propagation: design.environment,
          altitude_band: design.altitudeBand,
          temperature_band: design.temperatureBand,
        },
        environment_assumptions: {
          propagation: design.environment,
          altitude_band: design.altitudeBand,
          temperature_band: design.temperatureBand,
        },
        environment_adjustments: {
          propagation_draw_factor: runtime.environmentPowerFactor ?? 1,
          battery_capacity_factor: runtime.capacityFactor ?? design.capacityFactor ?? 1,
        },
        estimated_runtime: {
          hours: estimatedRuntimeHours,
          minutes: Number((estimatedRuntimeHours * 60).toFixed(1)),
          base_hours: baseRuntimeHours,
          environment_hours: environmentRuntimeHours,
        },
        estimated_runtime_min: Number((estimatedRuntimeHours * 60).toFixed(1)),
        total_weight_kg: design.totalWeightKg,
        rf_bands: design.rfBands || [],
        capabilities: design.capabilities,
        recommended_role: design.recommendedRole,
        parts: {
          host_id: design.parts.compute.id,
          battery_id: design.parts.battery.id,
          rf_chains: design.parts.rfChains.map((chain) => ({
            radio_id: chain.radio.id,
            antenna_id: chain.antenna.id,
          })),
          sensor_ids: (design.parts.sensors || []).map((sensor) => sensor.id),
        },
        notes: design.notes,
      };

      if (design.location && design.location.lat !== undefined && design.location.lon !== undefined) {
        nodeEntry.location = {
          lat: Number(design.location.lat),
          lon: Number(design.location.lon),
          elevation_m: design.location.elevation_m,
        };
      }

      return nodeEntry;
    })
    .filter(Boolean);

  const defaultEnvironment = nodes[0]?.environment || importedProjectExtras.environment || {};

  return {
    schema: SCHEMA_VERSION,
    schemaVersion: SCHEMA_VERSION,
    origin_tool: 'node',
    generated_at: new Date().toISOString(),
    mission: { name: missionName || 'Node Architect export', ao: 'Project WHITEFROST Demo' },
    environment: defaultEnvironment,
    constraints: buildConstraintsPayload(),
    platforms: Object.values(platforms),
    nodes,
    mesh_links: [],
    kits: [],
    ...importedProjectExtras,
  };
}

async function handleMissionImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const project = JSON.parse(text);
    importMissionProject(project);
  } catch (error) {
    showError(`Failed to import MissionProject: ${error.message}`);
  } finally {
    event.target.value = '';
  }
}

async function loadWhitefrostDemo() {
  try {
    const response = await fetch('whitefrost_demo.mission.json');
    if (!response.ok) throw new Error('Unable to load WHITEFROST demo file');
    const project = await response.json();
    importMissionProject(project);
    missionName = project.mission?.name || missionName;
    document.getElementById('mission-name').value = missionName;
    clearError();
  } catch (error) {
    showError(`WHITEFROST demo unavailable: ${error.message}`);
  }
}

function importMissionProject(project) {
  if (!components) {
    showError('Component catalog not loaded yet.');
    return;
  }

  const catalog = getCatalog();
  const designs = [];
  const warnings = [];
  const knownProjectFields = ['schema', 'schemaVersion', 'origin_tool', 'generated_at', 'mission', 'environment', 'constraints', 'platforms', 'nodes', 'mesh_links', 'kits'];
  const knownNodeFields = [
    'id',
    'name',
    'origin_tool',
    'platform_id',
    'roles',
    'rf_bands',
    'power_profile',
    'power',
    'battery',
    'estimated_runtime',
    'estimated_runtime_min',
    'location',
    'environment',
    'environment_assumptions',
    'capabilities',
    'recommended_role',
    'host_type',
    'radios',
    'antennas',
    'sensors',
    'parts',
    'notes',
    'mesh_hints',
    'weight_kg',
    'total_weight_kg',
  ];

  importedProjectExtras = extractUnknownFields(project, knownProjectFields);

  (project.nodes || []).forEach((node, idx) => {
    const nodePassthrough = extractUnknownFields(node, knownNodeFields);
    const parts = node.parts || {};
    let rfChains = parts.rf_chains || [];
    if (!rfChains.length && node.radios?.length && node.antennas?.length) {
      rfChains = node.radios.map((radioEntry, radioIdx) => ({
        radio_id: radioEntry.id,
        antenna_id: node.antennas[radioIdx]?.id,
      }));
    }
    const primaryChain = rfChains[0] || {};
    const compute = catalog.compute.find((item) => item.id === parts.host_id || node.compute?.id);
    const battery = catalog.batteries.find(
      (item) => item.id === parts.battery_id || node.power?.battery?.id || node.battery?.id,
    );
    const radio = catalog.radios.find((item) => item.id === primaryChain.radio_id);
    const antenna = catalog.antennas.find((item) => item.id === primaryChain.antenna_id);
    const sensors = (parts.sensor_ids || node.sensors?.map((sensor) => sensor.id) || [])
      .map((sid) => catalog.sensors.find((sensor) => sensor.id === sid))
      .filter(Boolean);

    if (!compute || !battery || !radio || !antenna) {
      warnings.push(`Skipping node ${node.id || idx} due to missing components.`);
      return;
    }

    const powerProfile = node.power_profile || node.power || {};
    const environment = node.environment || node.environment_assumptions || {};
    const rfBands = node.rf_bands || deriveRfBands(radio);
    const rangeHints = node.mesh_hints || [];
    const estimatedRuntimeHours =
      typeof node.estimated_runtime?.hours === 'number'
        ? node.estimated_runtime.hours
        : powerProfile.adjusted_runtime_h || powerProfile.ideal_runtime_h || 0;

    const basePowerW = powerProfile.base_draw_w || powerProfile.estimated_draw_w || 0;
    const environmentPowerFactorValue = powerProfile.environment_power_factor ?? powerProfile.environment_factor ?? 1;
    const capacityFactor = powerProfile.capacity_factor ?? 1.0;
    const baseRuntimeHours = typeof powerProfile.ideal_runtime_h === 'number' ? powerProfile.ideal_runtime_h : estimatedRuntimeHours;
    const environmentRuntimeHours =
      typeof powerProfile.environment_runtime_h === 'number'
        ? powerProfile.environment_runtime_h
        : typeof powerProfile.ideal_runtime_h === 'number'
        ? powerProfile.ideal_runtime_h
        : estimatedRuntimeHours;
    const adjustedRuntimeHours =
      typeof powerProfile.adjusted_runtime_h === 'number' ? powerProfile.adjusted_runtime_h : estimatedRuntimeHours;
    const runtimeBreakdown = {
      basePowerW: Number(basePowerW) || Number(powerProfile.estimated_draw_w) || 0,
      environmentPowerFactor: Number(environmentPowerFactorValue) || 1,
      capacityFactor: Number(capacityFactor) || 1,
      baseRuntimeHours: Number(baseRuntimeHours) || Number(adjustedRuntimeHours) || 0,
      environmentRuntimeHours: Number(environmentRuntimeHours) || Number(adjustedRuntimeHours) || 0,
      adjustedRuntimeHours: Number(adjustedRuntimeHours) || 0,
    };
    const combinedPowerW = runtimeBreakdown.basePowerW * runtimeBreakdown.environmentPowerFactor || powerProfile.estimated_draw_w || 0;

    const stableId = node.id || allocateNodeId(node.name || parts.host_id || `imported-${idx}`);
    const design = {
      id: stableId,
      name: node.name || `Imported node ${idx + 1}`,
      missionName: project.mission?.name || missionName,
      originTool: node.origin_tool || project.origin_tool || 'node',
      roles: node.roles || [],
      environment: environment.propagation || 'rural_open',
      altitudeBand: environment.altitude_band || 'sea_level',
      temperatureBand: environment.temperature_band || 'temperate',
      location: node.location,
      totalPowerW: Number(combinedPowerW),
      idealRuntimeHours: Number(runtimeBreakdown.baseRuntimeHours),
      environmentRuntimeHours: Number(runtimeBreakdown.environmentRuntimeHours),
      adjustedRuntimeHours: Number(runtimeBreakdown.adjustedRuntimeHours),
      capacityFactor: Number(runtimeBreakdown.capacityFactor || 1.0),
      runtime: runtimeBreakdown,
      totalWeightKg:
        Number(node.total_weight_kg || node.weight_kg || 0) ||
        Number(compute.weight_kg || 0) + Number(battery.mass_kg || battery.weight_kg || 0),
      capabilities: node.capabilities || [],
      recommendedRole: node.recommended_role || '',
      rfBands,
      rangeInfo: rfChains.map((chain, chainIdx) => {
        const chainRadio = catalog.radios.find((item) => item.id === chain.radio_id) || radio;
        const chainAntenna = catalog.antennas.find((item) => item.id === chain.antenna_id) || antenna;
        return {
          radio: { id: chainRadio.id, name: chainRadio.name, type: chainRadio.radio_type },
          antenna: { id: chainAntenna.id, name: chainAntenna.name },
          range: rangeHints[chainIdx]
            ? { range_km: rangeHints[chainIdx].estimated_range_km, description: rangeHints[chainIdx].band }
            : { description: 'Range not provided' },
        };
      }),
      parts: {
        compute: {
          id: compute.id,
          name: compute.name,
          cpu: compute.cpu,
          ram_gb: compute.ram_gb,
          storage: compute.storage,
          power_w_idle: compute.power_w_idle,
          power_w_load: compute.power_w_load,
          weight_kg: compute.weight_kg,
          tags: compute.tags || [],
        },
        battery: {
          id: battery.id,
          name: battery.name,
          capacity_wh: battery.capacity_wh,
          chemistry: battery.chemistry,
          tags: battery.tags || [],
        },
        sensors: sensors.map((s) => ({ id: s.id, name: s.name, sensor_type: s.sensor_type, tags: s.tags || [] })),
        rfChains: rfChains.map((chain) => {
          const chainRadio = catalog.radios.find((item) => item.id === chain.radio_id) || radio;
          const chainAntenna = catalog.antennas.find((item) => item.id === chain.antenna_id) || antenna;
          return {
            radio: {
              id: chainRadio.id,
              name: chainRadio.name,
              radio_type: chainRadio.radio_type,
              band: chainRadio.band,
              bands: chainRadio.bands,
              tags: chainRadio.tags || [],
            },
            antenna: { id: chainAntenna.id, name: chainAntenna.name, gain_dbi: chainAntenna.gain_dbi, tags: chainAntenna.tags || [] },
          };
        }),
      },
      passthrough: nodePassthrough,
    };

    designs.push(design);
  });

  if (!designs.length) {
    showError('No usable nodes found in MissionProject payload.');
    return;
  }

  missionName = project.mission?.name || missionName;
  document.getElementById('mission-name').value = missionName;
  savedDesigns = designs;
  persistDesigns();
  renderDesignsList();
  clearError();

  if (warnings.length) {
    showError(warnings.join(' '));
  }
}

function renderResults({
  nodeConfig,
  totalPowerW,
  idealRuntimeHours,
  environmentRuntimeHours,
  adjustedRuntimeHours,
  rangeInfo,
  capabilities,
  recommendedRole,
  warnings,
  totalWeightKg,
  capacityFactor,
  runtimeBreakdown,
  selectedRoles,
  nodeName,
  nodeNotes,
}) {
  const panel = document.getElementById('results-panel');
  const { compute, battery, sensors, rfChains, environment, altitudeBand, temperatureBand, location = {} } = nodeConfig;

  const sensorNames = sensors.length ? sensors.map((s) => s.name).join(', ') : 'None selected';
  const idealRuntime = formatRuntimeLabel(idealRuntimeHours);
  const envRuntime = formatRuntimeLabel(environmentRuntimeHours);
  const adjustedRuntime = formatRuntimeLabel(adjustedRuntimeHours);
  const summaryRole = recommendedRole || 'N/A';
  const rangeCategory = describeRangeCategory(rangeInfo);
  const envPowerNote = runtimeBreakdown
    ? `${(runtimeBreakdown.environmentPowerFactor * 100).toFixed(0)}% load factor for ${environment.split('_').join(' ')}`
    : '';
  const capacityNote = runtimeBreakdown
    ? `${(runtimeBreakdown.capacityFactor * 100).toFixed(0)}% battery efficiency at ${describeAltitude(altitudeBand)} / ${describeTemperature(
        temperatureBand,
      )}`
    : '';

  const rfList = rangeInfo
    .map((info, idx) => {
      const envLabel = environment.split('_').join(' ');
      const rangeText = info.range.range_m
        ? `~${info.range.range_m} m ${envLabel} (${info.range.description})`
        : info.range.range_km
        ? `~${info.range.range_km} km ${envLabel} (${info.range.description})`
        : info.range.description;
      return `<li><strong>Chain ${idx + 1}:</strong> ${info.radio.name} + ${info.antenna.name} → ${rangeText}</li>`;
    })
    .join('');

  const warningBlocks = warnings
    .filter(Boolean)
    .map((note) => `<div class="warning-note">${note}</div>`) // eslint-disable-line quotes
    .join('');

  const roleTags = selectedRoles
    .map((role) => `<span class="tag">${formatRoleLabel(role)}</span>`)
    .join('');

  panel.innerHTML = `
    <h2>Results</h2>
    <div class="summary-bar">
      <div class="summary-block">
        <div class="summary-label">Base runtime (nominal)</div>
        <div class="summary-value">${idealRuntime}</div>
        <div class="muted small">No environment derates applied</div>
      </div>
      <div class="summary-block">
        <div class="summary-label">Adjusted runtime</div>
        <div class="summary-value">${adjustedRuntime}</div>
        <div class="muted small">${envPowerNote}</div>
        <div class="muted small">${capacityNote}</div>
      </div>
      <div class="summary-block">
        <div class="summary-label">Weight</div>
        <div class="summary-value">${totalWeightKg.toFixed(2)} kg</div>
        <div class="muted small">${summaryRole}</div>
      </div>
    </div>
    <div class="result-section">
      <h3>Core</h3>
      <p class="result-line"><span class="result-label">Name:</span> ${nodeName || 'Unnamed build'}</p>
      <p class="result-line"><span class="result-label">Compute:</span> ${compute.name}</p>
      <p class="result-line"><span class="result-label">Battery:</span> ${battery.name}</p>
      <p class="result-line"><span class="result-label">Environment:</span> ${environment.split('_').join(' ')} | Alt: ${describeAltitude(altitudeBand)} | Temp: ${describeTemperature(temperatureBand)}</p>
      ${location.lat !== undefined && location.lon !== undefined ? `<p class="result-line"><span class="result-label">Location:</span> ${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}${location.elevation_m ? ` (${location.elevation_m} m)` : ''}</p>` : ''}
      <p class="result-line"><span class="result-label">Roles:</span> ${roleTags || 'No roles tagged'}</p>
      <p class="result-line"><span class="result-label">Sensors:</span> ${sensorNames}</p>
      <p class="result-line"><span class="result-label">Total power:</span> ${totalPowerW.toFixed(2)} W</p>
      <p class="result-line"><span class="result-label">Base runtime:</span> ${idealRuntime}</p>
      <p class="result-line"><span class="result-label">Environment runtime:</span> ${envRuntime}</p>
      <p class="result-line"><span class="result-label">Adjusted runtime:</span> ${adjustedRuntime}</p>
      ${nodeNotes ? `<p class="result-line"><span class="result-label">Notes:</span> ${nodeNotes}</p>` : ''}
    </div>
    <div class="result-section">
      <h3>Evaluation metrics</h3>
      <ul class="result-list">
        <li><strong>Base runtime:</strong> ${idealRuntime}</li>
        <li><strong>Environment runtime:</strong> ${envRuntime}</li>
        <li><strong>Adjusted runtime:</strong> ${adjustedRuntime}</li>
        <li><strong>Approximate weight:</strong> ${totalWeightKg.toFixed(2)} kg</li>
        <li><strong>RF chains:</strong> ${rfChains.length} configured (${rangeCategory.label})</li>
      </ul>
      <p class="inline-note">Environment runtime applies propagation draw; adjusted runtime also derates battery for altitude and temperature.</p>
    </div>
    <div class="result-section">
      <h3>RF Chains</h3>
      <ul class="result-list">${rfList}</ul>
      <p class="inline-note">RF chains: ${rfChains.length} / ${compute.max_rf_chains || 'n/a'} modeled slots</p>
    </div>
    <div class="result-section">
      <h3>Capabilities</h3>
      ${capabilities.length ? `<ul class="result-list">${capabilities.map((cap) => `<li>${cap}</li>`).join('')}</ul>` : '<p class="result-line">No specialized capabilities detected.</p>'}
    </div>
    <div class="result-section">
      <h3>Warnings</h3>
      ${warningBlocks || '<p class="muted small">No warnings.</p>'}
    </div>
    <button id="save-design-btn" class="secondary-btn" type="button">Save node design</button>
  `;

  document.getElementById('save-design-btn').addEventListener('click', handleSaveDesign);
}

function showError(message) {
  const banner = document.getElementById('error-banner');
  banner.textContent = message;
  banner.style.display = 'block';
}

function clearError() {
  const banner = document.getElementById('error-banner');
  banner.textContent = '';
  banner.style.display = 'none';
}
