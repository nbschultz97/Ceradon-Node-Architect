let components = null;
let lastPresetWarnings = [];
let savedDesigns = [];
let lastEvaluation = null;

const STORAGE_KEYS = {
  designs: 'ceradonSavedDesigns',
  environment: 'ceradonEnvBands',
  constraints: 'ceradonConstraints',
};

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

const PRESETS = [
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
  document.getElementById('evaluate-btn').addEventListener('click', handleEvaluate);
  document.getElementById('add-rf-chain-btn').addEventListener('click', () => addRfChain());
  document.getElementById('compute-select').addEventListener('change', () => updateRfCapacity());
  document.getElementById('preset-select').addEventListener('change', handlePresetChange);
  document.getElementById('export-designs').addEventListener('click', exportDesigns);
  bindConstraintInputs();
  bindEnvironmentPersistence();
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
      savedDesigns = JSON.parse(stored) || [];
    } catch (error) {
      console.warn('Failed to parse saved designs', error);
      savedDesigns = [];
    }
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

  const antennaSelect = document.getElementById('antenna-template').cloneNode(true);
  antennaSelect.id = '';
  antennaSelect.style.display = '';
  antennaSelect.value = prefill.antennaId || '';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    row.remove();
    updateRfCapacity();
  });

  row.appendChild(radioSelect);
  row.appendChild(antennaSelect);
  row.appendChild(removeBtn);

  container.appendChild(row);
  updateRfCapacity();
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

function handleEvaluate() {
  clearError();
  if (!components) {
    showError('Component catalog not loaded yet.');
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

  persistEnvironmentSelection();

  if (!computeId || !batteryId) {
    showError('Select compute and battery to evaluate.');
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
    showError('Add at least one RF chain with both a radio and an antenna.');
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
  };

  const totalPowerW = estimatePower(nodeConfig);
  const idealRuntimeHours = estimateRuntime(totalPowerW, battery);
  const capacityFactor = (batteryCapacityFactor[altitudeBand] || {})[temperatureBand] ?? 1.0;
  const adjustedRuntimeHours = idealRuntimeHours * capacityFactor;
  const rangeInfo = rfChains.map((chain) => ({
    ...chain,
    range: estimateRange(chain.radio, chain.antenna, environment),
  }));

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
    id: `design-${Date.now()}`,
    name: nodeName,
    notes: nodeNotes,
    roles: selectedRoles,
    nodeConfig,
    totalPowerW,
    idealRuntimeHours,
    adjustedRuntimeHours,
    capacityFactor,
    rangeInfo,
    capabilities,
    recommendedRole,
    totalWeightKg,
  };

  renderResults({
    nodeConfig,
    totalPowerW,
    idealRuntimeHours,
    adjustedRuntimeHours,
    rangeInfo,
    capabilities,
    recommendedRole,
    warnings,
    totalWeightKg,
    capacityFactor,
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

function estimatePower(config) {
  const { compute, rfChains, sensors, environment } = config;
  const hostPower = ((compute.power_w_idle || 0) + (compute.power_w_load || 0)) / 2;
  const radioPower = rfChains.reduce((sum, chain) => sum + (((chain.radio.power_w_tx || 0) + (chain.radio.power_w_rx || 0)) / 2), 0);
  const sensorPower = sensors.reduce((sum, sensor) => sum + (sensor.power_w || 0), 0);

  const basePower = hostPower + radioPower + sensorPower;
  const factor = environmentPowerFactor[environment] ?? 1.0;
  const totalPower = basePower * factor;
  return Number.isFinite(totalPower) && totalPower > 0 ? totalPower : 0;
}

function estimateRuntime(totalPowerW, battery) {
  if (!battery || !battery.capacity_wh || totalPowerW <= 0) {
    return 0;
  }
  return battery.capacity_wh / totalPowerW;
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
      <span>Total weight: ${design.totalWeightKg.toFixed(2)} kg</span>
      <span>Env: ${design.environment.replaceAll('_', ' ')} | Alt: ${describeAltitude(design.altitudeBand)} | Temp: ${describeTemperature(design.temperatureBand)}</span>
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
    actions.style.display = 'flex';
    actions.style.justifyContent = 'space-between';
    actions.style.alignItems = 'center';
    actions.style.marginTop = '0.35rem';

    const roleLabel = document.createElement('span');
    roleLabel.className = 'muted small';
    roleLabel.textContent = design.recommendedRole || '';
    actions.appendChild(roleLabel);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteDesign(design.id));
    actions.appendChild(deleteBtn);

    entry.appendChild(actions);
    container.appendChild(entry);
  });
}

function deleteDesign(id) {
  savedDesigns = savedDesigns.filter((design) => design.id !== id);
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
    id: `design-${Date.now()}`,
    name,
    notes,
    roles,
    environment: nodeConfig.environment,
    altitudeBand: nodeConfig.altitudeBand,
    temperatureBand: nodeConfig.temperatureBand,
    totalPowerW: Number(lastEvaluation.totalPowerW.toFixed(2)),
    idealRuntimeHours: Number(lastEvaluation.idealRuntimeHours.toFixed(2)),
    adjustedRuntimeHours: Number(lastEvaluation.adjustedRuntimeHours.toFixed(2)),
    capacityFactor: Number(lastEvaluation.capacityFactor.toFixed(2)),
    totalWeightKg: Number(lastEvaluation.totalWeightKg.toFixed(2)),
    capabilities: lastEvaluation.capabilities,
    recommendedRole: lastEvaluation.recommendedRole,
    rangeInfo: lastEvaluation.rangeInfo.map((info) => ({
      radio: { id: info.radio.id, name: info.radio.name, type: info.radio.radio_type },
      antenna: { id: info.antenna.id, name: info.antenna.name },
      range: info.range,
    })),
    parts: {
      compute: { id: nodeConfig.compute.id, name: nodeConfig.compute.name },
      battery: { id: nodeConfig.battery.id, name: nodeConfig.battery.name, capacity_wh: nodeConfig.battery.capacity_wh },
      sensors: (nodeConfig.sensors || []).map((s) => ({ id: s.id, name: s.name })),
      rfChains: (nodeConfig.rfChains || []).map((chain) => ({
        radio: { id: chain.radio.id, name: chain.radio.name, radio_type: chain.radio.radio_type },
        antenna: { id: chain.antenna.id, name: chain.antenna.name },
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

  const payload = {
    schema: 'ceradon_node_designs_v1',
    generated_at: new Date().toISOString(),
    nodes: savedDesigns.map((design) => ({
      id: design.id,
      name: design.name,
      notes: design.notes,
      roles: design.roles,
      environment: {
        propagation: design.environment,
        altitude_band: design.altitudeBand,
        temperature_band: design.temperatureBand,
      },
      totals: {
        total_weight_kg: design.totalWeightKg,
        ideal_runtime_hours: design.idealRuntimeHours,
        adjusted_runtime_hours: design.adjustedRuntimeHours,
        total_power_w: design.totalPowerW,
        capacity_factor: design.capacityFactor,
      },
      parts: design.parts,
      radios: design.parts.rfChains.map((chain) => chain.radio),
      antennas: design.parts.rfChains.map((chain) => chain.antenna),
      capabilities: design.capabilities,
      recommended_role: design.recommendedRole,
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'ceradon_node_designs.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

function renderResults({
  nodeConfig,
  totalPowerW,
  idealRuntimeHours,
  adjustedRuntimeHours,
  rangeInfo,
  capabilities,
  recommendedRole,
  warnings,
  totalWeightKg,
  capacityFactor,
  selectedRoles,
  nodeName,
  nodeNotes,
}) {
  const panel = document.getElementById('results-panel');
  const { compute, battery, sensors, rfChains, environment, altitudeBand, temperatureBand } = nodeConfig;

  const sensorNames = sensors.length ? sensors.map((s) => s.name).join(', ') : 'None selected';
  const idealRuntime = idealRuntimeHours > 0 ? `${idealRuntimeHours.toFixed(1)} h` : 'N/A';
  const adjustedRuntime = adjustedRuntimeHours > 0 ? `${adjustedRuntimeHours.toFixed(1)} h` : 'N/A';
  const summaryRole = recommendedRole || 'N/A';

  const rfList = rangeInfo
    .map((info, idx) => {
      const envLabel = environment.split('_').join(' ');
      const rangeText = info.range.range_m
        ? `~${info.range.range_m} m ${envLabel} (${info.range.description})`
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
        <div class="summary-label">Ideal runtime</div>
        <div class="summary-value">${idealRuntime}</div>
      </div>
      <div class="summary-block">
        <div class="summary-label">Adjusted runtime</div>
        <div class="summary-value">${adjustedRuntime}</div>
        <div class="muted small">Capacity factor: ${(capacityFactor * 100).toFixed(0)}%</div>
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
      <p class="result-line"><span class="result-label">Roles:</span> ${roleTags || 'No roles tagged'}</p>
      <p class="result-line"><span class="result-label">Sensors:</span> ${sensorNames}</p>
      <p class="result-line"><span class="result-label">Total power:</span> ${totalPowerW.toFixed(2)} W</p>
      <p class="result-line"><span class="result-label">Ideal runtime:</span> ${idealRuntime}</p>
      <p class="result-line"><span class="result-label">Adjusted runtime:</span> ${adjustedRuntime}</p>
      ${nodeNotes ? `<p class="result-line"><span class="result-label">Notes:</span> ${nodeNotes}</p>` : ''}
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
