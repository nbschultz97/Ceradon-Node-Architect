let components = null;

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

document.addEventListener('DOMContentLoaded', () => {
  loadComponents();
  const evaluateBtn = document.getElementById('evaluate-btn');
  evaluateBtn.addEventListener('click', handleEvaluate);
});

async function loadComponents() {
  try {
    const response = await fetch('components.json');
    if (!response.ok) {
      throw new Error('Unable to load components catalog');
    }
    components = await response.json();
    populateSelectors(components);
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
  populateSelect('radio-select', radios);
  populateSelect('antenna-select', antennas, (ant) => `${ant.name} (${ant.gain_db} dBi)`);
  populateSelect('battery-select', batteries, (bat) => `${bat.name} (${bat.capacity_wh} Wh)`);
  populateSensors(sensors);
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

function handleEvaluate() {
  clearError();
  if (!components) {
    showError('Component catalog not loaded yet.');
    return;
  }

  const computeId = document.getElementById('compute-select').value;
  const radioId = document.getElementById('radio-select').value;
  const antennaId = document.getElementById('antenna-select').value;
  const batteryId = document.getElementById('battery-select').value;
  const environment = document.getElementById('environment-select').value || 'lab';
  const sensorIds = Array.from(document.querySelectorAll('input[name="sensor"]:checked')).map((el) => el.value);

  if (!computeId || !radioId || !antennaId || !batteryId) {
    showError('Select compute, radio, antenna, and battery to evaluate.');
    return;
  }

  const catalog = {
    compute: components.compute || components.hosts || [],
    radios: components.radios || [],
    antennas: components.antennas || [],
    batteries: components.batteries || [],
    sensors: components.sensors || [],
  };

  const compute = catalog.compute.find((item) => item.id === computeId);
  const radio = catalog.radios.find((item) => item.id === radioId);
  const antenna = catalog.antennas.find((item) => item.id === antennaId);
  const battery = catalog.batteries.find((item) => item.id === batteryId);
  const selectedSensors = catalog.sensors.filter((sensor) => sensorIds.includes(sensor.id));

  if (!compute || !radio || !antenna || !battery) {
    showError('Invalid selection. Reload the page and try again.');
    return;
  }

  const nodeConfig = {
    compute,
    radio,
    antenna,
    battery,
    sensors: selectedSensors,
    environment,
  };

  const totalPowerW = estimatePower(nodeConfig, catalog);
  const runtimeHours = estimateRuntime(totalPowerW, battery);
  const rangeInfo = estimateRange(radio, antenna, environment);
  const capabilities = deriveCapabilities(nodeConfig);
  const recommendedRole = recommendRole({
    ...nodeConfig,
    totalPowerW,
    runtimeHours,
    capabilities,
  });

  renderResults({
    nodeConfig,
    totalPowerW,
    runtimeHours,
    rangeInfo,
    capabilities,
    recommendedRole,
  });
}

function estimatePower(config) {
  const { compute, radio, sensors, environment } = config;
  const hostPower = ((compute.power_w_idle || 0) + (compute.power_w_load || 0)) / 2;
  const radioPower = ((radio.power_w_tx || 0) + (radio.power_w_rx || 0)) / 2;
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

  const gain = antenna?.gain_db ?? radio.antenna_gain_db ?? 0;
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

function deriveCapabilities(node) {
  const { radio, sensors } = node;
  const caps = [];

  if (radio.radio_type === 'wifi' && radio.supports_monitor) {
    caps.push('WiFi recon / monitor mode scanning');
  }
  if (radio.radio_type === 'wifi' && radio.supports_csi) {
    caps.push('Potential WiFi CSI / channel analysis (driver support required)');
  }
  if (radio.radio_type === 'lora') {
    caps.push('LoRa telemetry / low-rate sensor network');
  }
  if (radio.radio_type === 'analog_fpv') {
    caps.push('Analog FPV video link');
  }
  if (radio.radio_type === 'sdr') {
    caps.push('SDR-based RF capture / analysis');
  }
  if (radio.radio_type === 'cellular') {
    caps.push('Cellular backhaul');
  }

  const hasCamera = sensors.some((sensor) => sensor.sensor_type === 'camera');
  const hasGps = sensors.some((sensor) => sensor.sensor_type === 'gps');
  const hasImu = sensors.some((sensor) => sensor.sensor_type === 'imu');

  if (hasCamera) {
    caps.push('Video / imagery capture');
  }
  if (hasGps) {
    caps.push('GPS position/time reference');
  }
  if (hasImu) {
    caps.push('IMU / motion sensing');
  }

  return caps;
}

function recommendRole(node) {
  const { radio, compute, sensors, runtimeHours } = node;
  const caps = node.capabilities || [];
  const cpuScore = compute.cpu_score || 0;
  const hasCamera = sensors.some((sensor) => sensor.sensor_type === 'camera');
  let role = 'General-purpose RF node';

  const hasMonitor = radio.radio_type === 'wifi' && radio.supports_monitor;
  const hasCsi = radio.radio_type === 'wifi' && radio.supports_csi;

  if (hasMonitor && cpuScore >= 5.5 && runtimeHours >= 2) {
    role = 'WiFi recon / RF mapping node';
  }

  if (hasCsi && cpuScore >= 7 && runtimeHours >= 2) {
    role = 'Experimental WiFi CSI / through-wall sensing node';
  }

  if (radio.radio_type === 'lora' && runtimeHours >= 24) {
    role = 'Low-power perimeter / telemetry node';
  }

  if (radio.radio_type === 'analog_fpv' && hasCamera) {
    role = 'FPV video relay / payload node';
  }

  if (radio.radio_type === 'sdr' && cpuScore >= 6) {
    role = 'RF capture / survey node';
  }

  if (radio.radio_type === 'cellular') {
    role = `${role} with LTE/5G backhaul`;
  }

  if (caps.length === 0) {
    role = `${role} (capabilities limited)`;
  }

  return role;
}

function renderResults({ nodeConfig, totalPowerW, runtimeHours, rangeInfo, capabilities, recommendedRole }) {
  const panel = document.getElementById('results-panel');
  const { compute, radio, antenna, battery, sensors } = nodeConfig;

  const sensorNames = sensors.length ? sensors.map((s) => s.name).join(', ') : 'None selected';
  const rangeText = rangeInfo.range_m ? `${rangeInfo.range_m} m (${rangeInfo.description})` : rangeInfo.description;

  const warnings = [];
  if (runtimeHours > 0 && runtimeHours < 2) {
    warnings.push('Runtime under 2 hours – consider a larger battery or lower draw components.');
  }

  panel.innerHTML = `
    <h2>Results</h2>
    <p class="result-line"><span class="result-label">Compute:</span> ${compute.name}</p>
    <p class="result-line"><span class="result-label">Radio:</span> ${radio.name}</p>
    <p class="result-line"><span class="result-label">Antenna:</span> ${antenna.name}</p>
    <p class="result-line"><span class="result-label">Battery:</span> ${battery.name}</p>
    <p class="result-line"><span class="result-label">Sensors:</span> ${sensorNames}</p>
    <p class="result-line"><span class="result-label">Total power:</span> ${totalPowerW.toFixed(2)} W</p>
    <p class="result-line"><span class="result-label">Estimated runtime:</span> ${runtimeHours.toFixed(1)} hours</p>
    <p class="result-line"><span class="result-label">Estimated range:</span> ${rangeText}</p>
    <div class="form-group">
      <span class="result-label">Capabilities:</span>
      ${capabilities.length ? `<ul class="result-list">${capabilities.map((cap) => `<li>${cap}</li>`).join('')}</ul>` : '<p class="result-line">No specialized capabilities detected.</p>'}
    </div>
    <p class="result-line"><span class="result-label">Recommended role:</span> ${recommendedRole}</p>
    ${warnings.map((note) => `<div class="warning-note">${note}</div>`).join('')}
  `;
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
