// Paste-ready code for the Node-RED function that controls solar EV charging.
// The cloudy-buffer branch deliberately uses the house battery as a short-term
// solar buffer while preserving a hard reserve above 90% SOC.

const states = global.get('homeassistant')?.homeAssistant?.states;

if (!states) {
    node.status({ fill: 'red', shape: 'ring', text: 'Home Assistant states unavailable' });
    return null;
}

const isPlainObject = (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);

const injectedSources = [
    isPlainObject(msg.testEntities) ? msg.testEntities : undefined,
    isPlainObject(msg.payload) ? msg.payload : undefined,
    isPlainObject(msg) ? msg : undefined,
].filter(Boolean);

const injectedEntityState = (entityId) => {
    for (const source of injectedSources) {
        if (Object.prototype.hasOwnProperty.call(source, entityId)) {
            return source[entityId];
        }
    }

    return undefined;
};

const entityState = (entityId) => {
    const injectedValue = injectedEntityState(entityId);

    if (injectedValue !== undefined) {
        return injectedValue;
    }

    return states[entityId]?.state;
};

const numberState = (entityId) => {
    const value = Number(entityState(entityId));
    return Number.isFinite(value) ? value : undefined;
};

const isOn = (entityId) => entityState(entityId) === 'on';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const now = Date.now();

const status = (fill, shape, text) => {
    node.status({ fill, shape, text });
    // node.warn(text);
};

const requiredNumber = (entityId) => {
    const value = numberState(entityId);

    if (value === undefined) {
        status('red', 'ring', `Missing numeric value: ${entityId}`);
        node.error(`Required numeric helper is unavailable or not numeric: ${entityId}`);
        return undefined;
    }

    return value;
};

const optionalNumber = (entityId, fallback) => {
    const value = numberState(entityId);
    return value === undefined ? fallback : value;
};

const formatKw = (value) => `${value.toFixed(1)}kW`;
const formatMinutes = (ms) => `${Math.ceil(ms / 60000)}m`;

const EV_SOC_ENTITY = 'sensor.tesla_model_y_battery_level';
const EV_CHARGE_LIMIT_ENTITY = 'number.tesla_model_y_charge_limit';
const POOL_TEMPERATURE_ENTITY = 'sensor.filtered_pool_water_temperature';
const POOL_HEATING_COMPLETE_ENTITY = 'binary_sensor.node_red_pool_heating_complete';
const HOUSE_BATTERY_SOC_ENTITY = 'sensor.sigen_plant_battery_state_of_charge';
const HOUSE_BATTERY_POWER_ENTITY = 'sensor.sigen_plant_battery_power';
const GRID_EXPORT_ENTITY = 'sensor.sigen_plant_grid_export_power';
const GRID_IMPORT_ENTITY = 'sensor.sigen_plant_grid_import_power';
const GRID_ACTIVE_POWER_ENTITY = 'sensor.sigen_plant_grid_active_power';
const INVERTER_ACTIVE_POWER_ENTITY = 'sensor.sigen_inverter_active_power';
const PV_POWER_ENTITY = 'sensor.sigen_inverter_pv_power';
const TOMORROW_FORECAST_ENTITY = 'sensor.meteo_solar_production_forecast_estimate_tomorrow';
const REMAINING_TODAY_FORECAST_ENTITY = 'sensor.meteo_solar_production_forecast_estimate_remaining_today';
const EV_CHARGE_CURRENT_ENTITY = 'number.tesla_model_y_charge_current';
const EV_CHARGER_POWER_ENTITY = 'sensor.tesla_model_y_charger_power';
const EV_CHARGE_SWITCH_ENTITY = 'switch.tesla_model_y_charge';
const EV_CABLE_ENTITY = 'binary_sensor.tesla_model_y_charge_cable';

const minCurrent = 5;
const maxCurrent = 16;
const currentStep = 1;
const evChargingVoltage = 230;
const evChargingPhases = 3;
const evPowerPerAmp = (evChargingVoltage * evChargingPhases) / 1000;
const minimumEvPower = minCurrent * evPowerPerAmp;

const restartCooldownMs = 1 * 60 * 1000;
const stopCooldownMs = 3 * 60 * 1000;
const currentChangeCooldownMs = 60 * 1000;
const requiredStartPasses = 2;
const requiredSoftStopPasses = 2;
const stopPowerMargin = 0.2;

const runoffSolarMinimumPower = 2;
const runoffBatteryDischargeLimit = 2;
const runoffPreferredBatteryDischarge = 0;
const runoffBatteryDischargeTolerance = 0.2;
const runoffMinimumHouseBatterySoc = 90;
const runoffHouseLoadLimit = 1;
const runoffExportPowerThreshold = 1;
const runoffGracePeriodMs = 60 * 1000;

// Cloud detection requires a large PV range plus meaningful movement in both
// directions. A monotonic sunset decline therefore does not activate the mode.
const cloudyRemainingSolarMinimumEnergy = 5;
const cloudyPvWindowMs = 10 * 60 * 1000;
const cloudyPvSampleIntervalMs = 20 * 1000;
const cloudyPvMinimumObservationMs = 5 * 60 * 1000;
const cloudyPvMinimumRange = 2;
const cloudyPvMinimumRelativeRange = 0.25;
const cloudyPvMinimumReversalTravel = 1.5;
const cloudyModeHoldMs = 45 * 60 * 1000;

// At high SOC the controller creates battery headroom for the next sunny
// interval. Below the target it progressively leaves solar available to refill.
const cloudyBatteryTargetSoc = 94;
const cloudyBatteryProtectionSoc = 92;
const cloudyBatteryStopSoc = 90.5;
const cloudyBatteryResumeSoc = 92;
const cloudyMaximumPreferredDischarge = 1.4;
const cloudyMaximumRecoveryCharge = 0.7;

// Cloudy-mode current control is deliberately asymmetric: it absorbs sustained
// surplus promptly, but sheds only 1 A at a time from a smoothed power estimate.
const cloudyPowerSmoothingTimeConstantMs = 3 * 60 * 1000;
const cloudyFilterResetAfterMs = 15 * 60 * 1000;
const cloudyIncreaseCooldownMs = 90 * 1000;
const cloudyDecreaseCooldownMs = 2 * 60 * 1000;
const cloudyProtectionDecreaseCooldownMs = 60 * 1000;
const cloudyDirectionReversalHoldMs = 5 * 60 * 1000;
const cloudyIncreasePowerMargin = 0.2;
const cloudyDecreasePowerMargin = 0.35;

const evSoc = numberState(EV_SOC_ENTITY);
const evChargeLimit = optionalNumber(EV_CHARGE_LIMIT_ENTITY, 100);
const houseBatterySoc = numberState(HOUSE_BATTERY_SOC_ENTITY);
const houseBatteryPower = numberState(HOUSE_BATTERY_POWER_ENTITY);
const gridExport = numberState(GRID_EXPORT_ENTITY);
const gridImport = numberState(GRID_IMPORT_ENTITY);
const gridActivePower = numberState(GRID_ACTIVE_POWER_ENTITY);
const inverterActivePower = numberState(INVERTER_ACTIVE_POWER_ENTITY);
const pvPower = numberState(PV_POWER_ENTITY);
const tomorrowForecast = numberState(TOMORROW_FORECAST_ENTITY);
const remainingTodayForecast = numberState(REMAINING_TODAY_FORECAST_ENTITY);
const poolTemperature = numberState(POOL_TEMPERATURE_ENTITY);
const current = numberState(EV_CHARGE_CURRENT_ENTITY);
const evChargePower = numberState(EV_CHARGER_POWER_ENTITY);

const evHighPriorityThreshold = requiredNumber('input_number.ev_charging_ev_soc_high_priority_threshold');
const evLowPriorityThreshold = requiredNumber('input_number.ev_charging_ev_soc_low_priority_threshold');
const goodSolarForecastTomorrow = requiredNumber('input_number.solar_forecast_good_production');
const lowSolarForecast = requiredNumber('input_number.solar_forecast_low_production');
const poolWarmEnoughForEvPriority = requiredNumber('input_number.pool_heater_nominal_temp_start');
const startExportPower = requiredNumber('input_number.ev_charging_start_export_power');
const startImportLimit = requiredNumber('input_number.ev_charging_start_import_power_limit');
const reduceImport = requiredNumber('input_number.ev_charging_reduce_import_power');
const increaseExport = requiredNumber('input_number.ev_charging_increase_export_power');
const equalPriorityMinBatteryChargePower = requiredNumber('input_number.ev_charging_equal_priority_min_battery_charge_power');
const minStartHouseBatterySoc = requiredNumber('input_number.min_house_battery_soc_to_start_car_charging');
const minStopHouseBatterySoc = requiredNumber('input_number.min_house_battery_soc_to_stop_car_charging');
const equalPriorityHouseBatterySoc = requiredNumber('input_number.ev_charging_min_battery_soc');
const reduceHouseBatteryDischarge = optionalNumber('input_number.ev_charging_reduce_house_battery_discharge_power', 0.1);

if (
    evSoc === undefined ||
    evChargeLimit === undefined ||
    houseBatterySoc === undefined ||
    houseBatteryPower === undefined ||
    gridExport === undefined ||
    gridImport === undefined ||
    gridActivePower === undefined ||
    inverterActivePower === undefined ||
    pvPower === undefined ||
    current === undefined ||
    evChargePower === undefined ||
    evHighPriorityThreshold === undefined ||
    evLowPriorityThreshold === undefined ||
    goodSolarForecastTomorrow === undefined ||
    lowSolarForecast === undefined ||
    poolWarmEnoughForEvPriority === undefined ||
    startExportPower === undefined ||
    startImportLimit === undefined ||
    reduceImport === undefined ||
    increaseExport === undefined ||
    equalPriorityMinBatteryChargePower === undefined ||
    minStartHouseBatterySoc === undefined ||
    minStopHouseBatterySoc === undefined ||
    equalPriorityHouseBatterySoc === undefined ||
    reduceHouseBatteryDischarge === undefined
) {
    return null;
}

if (evHighPriorityThreshold >= evLowPriorityThreshold) {
    status('red', 'ring', `Invalid EV SOC thresholds: high ${evHighPriorityThreshold}% >= low ${evLowPriorityThreshold}%`);
    return null;
}

const evCharging = isOn(EV_CHARGE_SWITCH_ENTITY);
const cableConnected = isOn(EV_CABLE_ENTITY);
const poolHeatingComplete = isOn(POOL_HEATING_COMPLETE_ENTITY);
const evBelowChargeLimit = evSoc < evChargeLimit;

const houseBatteryChargePower = Math.max(0, houseBatteryPower);
const houseBatteryDischargePower = Math.max(0, -houseBatteryPower);
const availableStartPower = Math.max(0, gridExport) + houseBatteryChargePower - Math.max(0, gridImport);

const estimatedEvChargePower = evCharging
    ? current * evPowerPerAmp
    : 0;

const effectiveEvChargePower = Math.max(evChargePower, estimatedEvChargePower);
const houseLoadWithoutEv = gridActivePower + inverterActivePower - effectiveEvChargePower;

let evPriority;

if (evSoc < evHighPriorityThreshold) {
    evPriority = 'high';
} else if (evSoc < evLowPriorityThreshold) {
    evPriority = 'equal';
} else {
    evPriority = 'low';
}

const priorities = ['low', 'equal', 'high'];
const boostPriority = (priority) =>
    priorities[clamp(priorities.indexOf(priority) + 1, 0, priorities.length - 1)];

const forecastBoost =
    tomorrowForecast !== undefined &&
    poolTemperature !== undefined &&
    tomorrowForecast > goodSolarForecastTomorrow &&
    poolTemperature > poolWarmEnoughForEvPriority;

if (forecastBoost) {
    evPriority = boostPriority(evPriority);
}

const lowSolarExpected =
    remainingTodayForecast !== undefined &&
    tomorrowForecast !== undefined &&
    remainingTodayForecast <= lowSolarForecast &&
    tomorrowForecast <= lowSolarForecast;

const urgentEvImportAllowed =
    evPriority === 'high' &&
    evSoc < evHighPriorityThreshold &&
    lowSolarExpected;

let requiredHouseBatterySoc;

if (evPriority === 'high') {
    requiredHouseBatterySoc = minStartHouseBatterySoc;
} else if (evPriority === 'equal') {
    requiredHouseBatterySoc = equalPriorityHouseBatterySoc;
} else {
    requiredHouseBatterySoc = Math.max(equalPriorityHouseBatterySoc, minStartHouseBatterySoc);
}

const runoffBaseEligible =
    poolHeatingComplete &&
    evBelowChargeLimit &&
    houseBatterySoc > runoffMinimumHouseBatterySoc;

const runoffStartGate =
    houseLoadWithoutEv < runoffHouseLoadLimit ||
    gridExport >= runoffExportPowerThreshold ||
    houseBatteryChargePower >= minimumEvPower;

const runoffSolarLow = pvPower < runoffSolarMinimumPower;
const runoffBatteryDrainHigh = houseBatteryDischargePower > runoffBatteryDischargeLimit;

if (!runoffSolarLow) {
    flow.set('evSolarRunoffSolarLowSince', 0);
} else if (!flow.get('evSolarRunoffSolarLowSince')) {
    flow.set('evSolarRunoffSolarLowSince', now);
}

if (!runoffBatteryDrainHigh) {
    flow.set('evSolarRunoffBatteryDrainHighSince', 0);
} else if (!flow.get('evSolarRunoffBatteryDrainHighSince')) {
    flow.set('evSolarRunoffBatteryDrainHighSince', now);
}

const runoffSolarLowSince = flow.get('evSolarRunoffSolarLowSince') || 0;
const runoffBatteryDrainHighSince = flow.get('evSolarRunoffBatteryDrainHighSince') || 0;

const runoffSolarLowForTooLong =
    runoffSolarLowSince > 0 &&
    now - runoffSolarLowSince >= runoffGracePeriodMs;

const runoffBatteryDrainHighForTooLong =
    runoffBatteryDrainHighSince > 0 &&
    now - runoffBatteryDrainHighSince >= runoffGracePeriodMs;

const storedPvSamples = flow.get('evSolarCloudPvSamples');
let cloudPvSamples = Array.isArray(storedPvSamples)
    ? storedPvSamples.filter((sample) =>
        isPlainObject(sample) &&
        Number.isFinite(sample.at) &&
        Number.isFinite(sample.power) &&
        sample.at >= now - cloudyPvWindowMs &&
        sample.at <= now
    )
    : [];

const lastPvSample = cloudPvSamples[cloudPvSamples.length - 1];

if (!lastPvSample || now - lastPvSample.at >= cloudyPvSampleIntervalMs) {
    cloudPvSamples.push({ at: now, power: pvPower });
}

flow.set('evSolarCloudPvSamples', cloudPvSamples);

const cloudPvPowers = cloudPvSamples.map((sample) => sample.power);
const cloudPvObservationMs = cloudPvSamples.length > 1
    ? cloudPvSamples[cloudPvSamples.length - 1].at - cloudPvSamples[0].at
    : 0;
const cloudPvMean = cloudPvPowers.length > 0
    ? cloudPvPowers.reduce((sum, power) => sum + power, 0) / cloudPvPowers.length
    : pvPower;
const cloudPvRange = cloudPvPowers.length > 0
    ? Math.max(...cloudPvPowers) - Math.min(...cloudPvPowers)
    : 0;

let cloudPvTravel = 0;

for (let index = 1; index < cloudPvPowers.length; index += 1) {
    cloudPvTravel += Math.abs(cloudPvPowers[index] - cloudPvPowers[index - 1]);
}

const cloudPvNetMovement = cloudPvPowers.length > 1
    ? Math.abs(cloudPvPowers[cloudPvPowers.length - 1] - cloudPvPowers[0])
    : 0;
const cloudPvReversalTravel = Math.max(0, cloudPvTravel - cloudPvNetMovement);

const cloudPvFluctuatingNow =
    cloudPvObservationMs >= cloudyPvMinimumObservationMs &&
    cloudPvRange >= cloudyPvMinimumRange &&
    cloudPvRange >= cloudPvMean * cloudyPvMinimumRelativeRange &&
    cloudPvReversalTravel >= cloudyPvMinimumReversalTravel;

if (cloudPvFluctuatingNow) {
    flow.set('evSolarCloudyUntil', now + cloudyModeHoldMs);
}

const cloudyUntil = flow.get('evSolarCloudyUntil') || 0;
const cloudRecentlyDetected = cloudyUntil > now;
const cloudForecastEligible =
    remainingTodayForecast !== undefined &&
    remainingTodayForecast > cloudyRemainingSolarMinimumEnergy;
const cloudBufferMode =
    runoffBaseEligible &&
    cloudForecastEligible &&
    cloudRecentlyDetected;

// A confirmed cloudy period overrides the one-minute low-PV stop. The remaining
// forecast and the battery floor still bound how long the battery may buffer it.
const solarRunoffMode =
    runoffBaseEligible &&
    (!runoffSolarLowForTooLong || cloudBufferMode);

const solarRunoffSessionActive =
    Boolean(flow.get('evSolarRunoffSessionActive')) || solarRunoffMode;

msg.ev_priority = evPriority;
msg.ev_soc = evSoc;
msg.ev_charge_limit = evChargeLimit;
msg.ev_below_charge_limit = evBelowChargeLimit;
msg.house_battery_soc = houseBatterySoc;
msg.house_battery_power = houseBatteryPower;
msg.house_battery_charge_power = houseBatteryChargePower;
msg.house_battery_discharge_power = houseBatteryDischargePower;
msg.ev_charge_power = evChargePower;
msg.estimated_ev_charge_power = estimatedEvChargePower;
msg.effective_ev_charge_power = effectiveEvChargePower;
msg.grid_export_power = gridExport;
msg.grid_import_power = gridImport;
msg.grid_active_power = gridActivePower;
msg.inverter_active_power = inverterActivePower;
msg.pv_power = pvPower;
msg.house_load_without_ev = houseLoadWithoutEv;
msg.available_start_power = availableStartPower;
msg.required_house_battery_soc = requiredHouseBatterySoc;
msg.urgent_ev_import_allowed = urgentEvImportAllowed;
msg.low_solar_expected = lowSolarExpected;
msg.forecast_boost = forecastBoost;
msg.remaining_today_forecast = remainingTodayForecast;
msg.pool_heating_complete = poolHeatingComplete;
msg.solar_runoff_mode = solarRunoffMode;
msg.solar_runoff_session_active = solarRunoffSessionActive;
msg.runoff_start_gate = runoffStartGate;
msg.runoff_solar_low_for_too_long = runoffSolarLowForTooLong;
msg.runoff_battery_drain_high_for_too_long = runoffBatteryDrainHighForTooLong;
msg.cloud_pv_sample_count = cloudPvSamples.length;
msg.cloud_pv_observation_minutes = cloudPvObservationMs / 60000;
msg.cloud_pv_mean = cloudPvMean;
msg.cloud_pv_range = cloudPvRange;
msg.cloud_pv_reversal_travel = cloudPvReversalTravel;
msg.cloud_pv_fluctuating_now = cloudPvFluctuatingNow;
msg.cloud_recently_detected = cloudRecentlyDetected;
msg.cloud_forecast_eligible = cloudForecastEligible;
msg.cloud_buffer_mode = cloudBufferMode;
msg.cloudy_until = cloudyUntil;

const resetCloudCurrentControl = () => {
    flow.set('evSolarCloudFilteredSupportablePower', null);
    flow.set('evSolarCloudFilteredAt', 0);
    flow.set('evSolarCloudLastCurrentDirection', null);
    flow.set('evSolarCloudLastCurrentDirectionAt', 0);
};

if (!cableConnected) {
    flow.set('evSolarStartPasses', 0);
    flow.set('evSolarSoftStopPasses', 0);
    flow.set('evSolarRunoffSolarLowSince', 0);
    flow.set('evSolarRunoffBatteryDrainHighSince', 0);
    flow.set('evSolarRunoffSessionActive', false);
    resetCloudCurrentControl();

    if (evCharging) {
        flow.set('evSolarStoppedAt', now);
        msg.ev_action = 'stop';
        status('red', 'dot', 'Stop: EV cable disconnected');
        return msg;
    }

    status('grey', 'ring', 'EV cable not connected');
    return null;
}

if (!evBelowChargeLimit && !evCharging) {
    flow.set('evSolarStartPasses', 0);
    flow.set('evSolarSoftStopPasses', 0);
    flow.set('evSolarRunoffSolarLowSince', 0);
    flow.set('evSolarRunoffBatteryDrainHighSince', 0);
    flow.set('evSolarRunoffSessionActive', false);
    resetCloudCurrentControl();
    status('grey', 'ring', `Idle: EV at charge limit ${evSoc}%/${evChargeLimit}%`);
    return null;
}

const lastStoppedAt = flow.get('evSolarStoppedAt') || 0;
const lastStartedAt = flow.get('evSolarStartedAt') || 0;
const lastCurrentChangedAt = flow.get('evSolarCurrentChangedAt') || 0;

const setCurrent = (
    nextCurrent,
    reason,
    fill = 'yellow',
    cooldownMs = currentChangeCooldownMs,
) => {
    if (now - lastCurrentChangedAt < cooldownMs) {
        status('blue', 'ring', `Hold: current change cooldown, ${reason}`);
        return null;
    }

    if (nextCurrent === current) {
        status('blue', 'ring', `Hold: already ${current}A, ${reason}`);
        return null;
    }

    flow.set('evSolarCurrentChangedAt', now);
    msg.ev_action = 'set_current';
    msg.ev_current = nextCurrent;
    status(fill, 'dot', `${reason}: ${current}A → ${nextCurrent}A`);
    return msg;
};

const stopCharging = (reason, fill = 'red', respectCooldown = true) => {
    if (
        respectCooldown &&
        now - lastStartedAt < stopCooldownMs &&
        houseBatterySoc >= minStopHouseBatterySoc
    ) {
        status('blue', 'ring', `Hold: stop cooldown, ${reason}`);
        return null;
    }

    flow.set('evSolarStoppedAt', now);
    flow.set('evSolarStartPasses', 0);
    flow.set('evSolarSoftStopPasses', 0);
    flow.set('evSolarRunoffSessionActive', false);
    resetCloudCurrentControl();
    msg.ev_action = 'stop';
    status(fill, 'dot', `Stop: ${reason}`);
    return msg;
};

if (!evCharging) {
    flow.set('evSolarSoftStopPasses', 0);
    flow.set('evSolarRunoffSessionActive', false);
    resetCloudCurrentControl();

    const cooldownRemaining = restartCooldownMs - (now - lastStoppedAt);

    if (cooldownRemaining > 0) {
        flow.set('evSolarStartPasses', 0);
        status('grey', 'ring', `Blocked: restart cooldown ${formatMinutes(cooldownRemaining)} remaining`);
        return null;
    }

    const enoughSoc = houseBatterySoc >= requiredHouseBatterySoc;
    const enoughMinimumSoc = houseBatterySoc >= minStartHouseBatterySoc;
    const enoughPowerForMinimumCurrent = availableStartPower >= minimumEvPower;
    const exportStrongEnough = gridExport >= startExportPower;
    const importLowEnough = gridImport <= startImportLimit;
    const equalBatteryChargingEnough = houseBatteryChargePower >= equalPriorityMinBatteryChargePower;

    const highCanStart =
        evBelowChargeLimit &&
        evPriority === 'high' &&
        enoughMinimumSoc &&
        (enoughPowerForMinimumCurrent || urgentEvImportAllowed);

    const equalCanStart =
        evBelowChargeLimit &&
        evPriority === 'equal' &&
        enoughSoc &&
        importLowEnough &&
        enoughPowerForMinimumCurrent &&
        equalBatteryChargingEnough;

    const lowCanStart =
        evBelowChargeLimit &&
        evPriority === 'low' &&
        enoughSoc &&
        importLowEnough &&
        exportStrongEnough &&
        enoughPowerForMinimumCurrent;

    const runoffCanStart =
        evBelowChargeLimit &&
        solarRunoffMode &&
        runoffStartGate &&
        importLowEnough &&
        pvPower >= runoffSolarMinimumPower &&
        houseBatterySoc >= (
            cloudBufferMode
                ? cloudyBatteryResumeSoc
                : runoffMinimumHouseBatterySoc
        );

    const cloudReserveAllowsStart =
        !cloudBufferMode ||
        houseBatterySoc >= cloudyBatteryResumeSoc;
    const canStart =
        cloudReserveAllowsStart &&
        (highCanStart || equalCanStart || lowCanStart || runoffCanStart);

    if (!canStart) {
        flow.set('evSolarStartPasses', 0);
        status(
            'yellow',
            'ring',
            `Blocked: ${evPriority}, EV ${evSoc}%/${evChargeLimit}%, house ${houseBatterySoc}%/${requiredHouseBatterySoc}%, available ${formatKw(availableStartPower)}, needed ${formatKw(minimumEvPower)}, PV ${formatKw(pvPower)}, load ${formatKw(houseLoadWithoutEv)}, export ${formatKw(gridExport)}, import ${formatKw(gridImport)}`,
        );
        return null;
    }

    const startPasses = (flow.get('evSolarStartPasses') || 0) + 1;
    flow.set('evSolarStartPasses', startPasses);

    if (startPasses < requiredStartPasses) {
        status('yellow', 'ring', `Armed: start pass ${startPasses}/${requiredStartPasses}, available ${formatKw(availableStartPower)}, PV ${formatKw(pvPower)}`);
        return null;
    }

    flow.set('evSolarStartPasses', 0);
    flow.set('evSolarStartedAt', now);
    flow.set('evSolarCurrentChangedAt', now);
    flow.set('evSolarRunoffSessionActive', runoffCanStart);

    msg.ev_action = 'start';
    msg.ev_current = minCurrent;

    if (runoffCanStart) {
        const startMode = cloudBufferMode ? 'cloud buffer' : 'runoff';
        status('green', 'dot', `Start ${minCurrent}A: ${startMode}, PV ${formatKw(pvPower)}, house ${houseBatterySoc}%`);
    } else {
        status('green', 'dot', `Start ${minCurrent}A: ${evPriority}, available ${formatKw(availableStartPower)}, house ${houseBatterySoc}%`);
    }

    return msg;
}

flow.set('evSolarStartPasses', 0);

if (solarRunoffMode) {
    flow.set('evSolarRunoffSessionActive', true);
}

const activeRunoffSession =
    Boolean(flow.get('evSolarRunoffSessionActive')) || solarRunoffMode;

if (
    houseBatterySoc < minStopHouseBatterySoc &&
    !urgentEvImportAllowed &&
    !cloudBufferMode
) {
    return stopCharging(`house ${houseBatterySoc}% < minimum ${minStopHouseBatterySoc}%`);
}

const solarRunoffHardStop =
    activeRunoffSession &&
    (
        houseBatterySoc <= runoffMinimumHouseBatterySoc ||
        !evBelowChargeLimit ||
        !poolHeatingComplete ||
        (!cloudBufferMode && runoffSolarLowForTooLong)
    );

if (solarRunoffHardStop) {
    return stopCharging(
        `runoff ended: EV ${evSoc}%/${evChargeLimit}%, house ${houseBatterySoc}%, PV ${formatKw(pvPower)}, drain ${formatKw(houseBatteryDischargePower)}, load ${formatKw(houseLoadWithoutEv)}`,
        'red',
        houseBatterySoc > runoffMinimumHouseBatterySoc,
    );
}

if (cloudBufferMode) {
    const preferredBatteryPower = houseBatterySoc >= cloudyBatteryTargetSoc
        ? -cloudyMaximumPreferredDischarge * clamp(
            (houseBatterySoc - cloudyBatteryTargetSoc) /
                (100 - cloudyBatteryTargetSoc),
            0,
            1,
        )
        : cloudyMaximumRecoveryCharge * clamp(
            (cloudyBatteryTargetSoc - houseBatterySoc) /
                (cloudyBatteryTargetSoc - cloudyBatteryProtectionSoc),
            0,
            1,
        );

    // Reconstruct the EV power that the present PV/house balance can sustain
    // while meeting the preferred battery charge/discharge target.
    const cloudSupportableEvPower = Math.max(
        0,
        estimatedEvChargePower +
            gridExport -
            gridImport +
            houseBatteryPower -
            preferredBatteryPower,
    );

    const storedFilteredPower = flow.get('evSolarCloudFilteredSupportablePower');
    const previousFilteredPower =
        typeof storedFilteredPower === 'number' &&
        Number.isFinite(storedFilteredPower)
            ? storedFilteredPower
            : undefined;
    const previousFilteredAt = flow.get('evSolarCloudFilteredAt') || 0;
    const filterElapsedMs = now - previousFilteredAt;
    const resetFilter =
        previousFilteredPower === undefined ||
        filterElapsedMs <= 0 ||
        filterElapsedMs > cloudyFilterResetAfterMs;
    const filterAlpha = resetFilter
        ? 1
        : 1 - Math.exp(
            -filterElapsedMs / cloudyPowerSmoothingTimeConstantMs,
        );
    const filteredSupportableEvPower = resetFilter
        ? cloudSupportableEvPower
        : previousFilteredPower +
            filterAlpha * (cloudSupportableEvPower - previousFilteredPower);

    flow.set('evSolarCloudFilteredSupportablePower', filteredSupportableEvPower);
    flow.set('evSolarCloudFilteredAt', now);

    msg.cloud_preferred_battery_power = preferredBatteryPower;
    msg.cloud_supportable_ev_power = cloudSupportableEvPower;
    msg.cloud_filtered_supportable_ev_power = filteredSupportableEvPower;
    msg.cloud_battery_target_soc = cloudyBatteryTargetSoc;

    const setCloudCurrent = (
        nextCurrent,
        reason,
        direction,
        cooldownMs,
        allowDirectionReversal = false,
    ) => {
        const lastDirection = flow.get('evSolarCloudLastCurrentDirection');
        const lastDirectionAt = flow.get('evSolarCloudLastCurrentDirectionAt') || 0;
        const reversing =
            lastDirection !== null &&
            lastDirection !== undefined &&
            lastDirection !== direction;

        if (
            reversing &&
            !allowDirectionReversal &&
            now - lastDirectionAt < cloudyDirectionReversalHoldMs
        ) {
            status(
                'blue',
                'ring',
                `Hold: cloud direction lock, ${reason}`,
            );
            return null;
        }

        const result = setCurrent(
            nextCurrent,
            reason,
            direction === 'up' ? 'green' : 'yellow',
            cooldownMs,
        );

        if (result) {
            flow.set('evSolarCloudLastCurrentDirection', direction);
            flow.set('evSolarCloudLastCurrentDirectionAt', now);
        }

        return result;
    };

    const reserveNeedsProtection =
        houseBatterySoc <= cloudyBatteryProtectionSoc &&
        (
            houseBatteryDischargePower > runoffBatteryDischargeTolerance ||
            gridImport > startImportLimit
        );

    if (houseBatterySoc <= cloudyBatteryStopSoc && current <= minCurrent) {
        return stopCharging(
            `cloud buffer reserve ${houseBatterySoc}% <= ${cloudyBatteryStopSoc}%`,
            'red',
            false,
        );
    }

    if (reserveNeedsProtection && current > minCurrent) {
        return setCloudCurrent(
            clamp(current - currentStep, minCurrent, maxCurrent),
            `Protect cloud reserve ${houseBatterySoc}%`,
            'down',
            cloudyProtectionDecreaseCooldownMs,
            true,
        );
    }

    const nextCurrentPower = (current + currentStep) * evPowerPerAmp;
    const currentPower = current * evPowerPerAmp;
    const canIncreaseSmoothly =
        current < maxCurrent &&
        filteredSupportableEvPower >=
            nextCurrentPower + cloudyIncreasePowerMargin;
    const shouldDecreaseSmoothly =
        current > minCurrent &&
        filteredSupportableEvPower <=
            currentPower - cloudyDecreasePowerMargin;

    if (canIncreaseSmoothly) {
        return setCloudCurrent(
            clamp(current + currentStep, minCurrent, maxCurrent),
            `Cloud surplus, support ${formatKw(filteredSupportableEvPower)}`,
            'up',
            cloudyIncreaseCooldownMs,
        );
    }

    if (shouldDecreaseSmoothly) {
        return setCloudCurrent(
            clamp(current - currentStep, minCurrent, maxCurrent),
            `Cloud decline, support ${formatKw(filteredSupportableEvPower)}`,
            'down',
            cloudyDecreaseCooldownMs,
        );
    }

    status(
        'blue',
        'ring',
        `Hold: cloud buffer ${current}A, house ${houseBatterySoc}%, target ${cloudyBatteryTargetSoc}%, preferred battery ${formatKw(preferredBatteryPower)}, support ${formatKw(filteredSupportableEvPower)}, PV range ${formatKw(cloudPvRange)}, remaining ${remainingTodayForecast}kWh`,
    );
    return null;
}

resetCloudCurrentControl();

const importTooHigh = gridImport > reduceImport + stopPowerMargin;
const normalBatteryDischargeTooHigh = houseBatteryDischargePower > reduceHouseBatteryDischarge + stopPowerMargin;
const runoffBatteryDischargeTooHigh =
    activeRunoffSession &&
    houseBatteryDischargePower > runoffPreferredBatteryDischarge + runoffBatteryDischargeTolerance;
const runoffBatteryDischargeCritical =
    activeRunoffSession &&
    houseBatteryDischargePower > runoffBatteryDischargeLimit + stopPowerMargin;
const belowRequiredSoc = houseBatterySoc < requiredHouseBatterySoc;
const equalBatteryChargeTooLow =
    evPriority === 'equal' &&
    houseBatteryChargePower < equalPriorityMinBatteryChargePower - stopPowerMargin;

const softStopRisk =
    (!activeRunoffSession && !urgentEvImportAllowed && importTooHigh) ||
    (!activeRunoffSession && normalBatteryDischargeTooHigh) ||
    runoffBatteryDischargeCritical ||
    (!activeRunoffSession && belowRequiredSoc && evPriority !== 'high') ||
    (!activeRunoffSession && belowRequiredSoc && evPriority === 'equal' && equalBatteryChargeTooLow);

if (softStopRisk && current > minCurrent) {
    flow.set('evSolarSoftStopPasses', 0);

    const reason = activeRunoffSession
        ? 'Reduce runoff battery drain'
        : 'Reduce load';

    return setCurrent(clamp(current - currentStep, minCurrent, maxCurrent), reason);
}

if (softStopRisk && current <= minCurrent) {
    const softStopPasses = (flow.get('evSolarSoftStopPasses') || 0) + 1;
    flow.set('evSolarSoftStopPasses', softStopPasses);

    if (softStopPasses < requiredSoftStopPasses) {
        status('yellow', 'ring', `Armed: stop pass ${softStopPasses}/${requiredSoftStopPasses}, import ${formatKw(gridImport)}, discharge ${formatKw(houseBatteryDischargePower)}`);
        return null;
    }

    return stopCharging(`minimum current with import ${formatKw(gridImport)}, discharge ${formatKw(houseBatteryDischargePower)}`);
}

flow.set('evSolarSoftStopPasses', 0);

if (evPriority === 'equal' && !activeRunoffSession) {
    const powerDifference = evChargePower - houseBatteryChargePower;
    const tolerance = evPowerPerAmp / 2;

    if (powerDifference > tolerance && current > minCurrent) {
        return setCurrent(clamp(current - currentStep, minCurrent, maxCurrent), 'Balance down');
    }

    if (powerDifference < -tolerance && current < maxCurrent && gridImport <= startImportLimit) {
        return setCurrent(clamp(current + currentStep, minCurrent, maxCurrent), 'Balance up', 'green');
    }
}

const nextCurrentPowerIncrease = currentStep * evPowerPerAmp;
const runoffHasSurplusForIncrease =
    houseBatteryChargePower >= nextCurrentPowerIncrease + runoffBatteryDischargeTolerance ||
    gridExport >= Math.max(runoffExportPowerThreshold, nextCurrentPowerIncrease) ||
    (
        houseBatteryDischargePower <= runoffPreferredBatteryDischarge + runoffBatteryDischargeTolerance &&
        houseLoadWithoutEv < runoffHouseLoadLimit
    );

const runoffCanIncrease =
    evBelowChargeLimit &&
    activeRunoffSession &&
    solarRunoffMode &&
    current < maxCurrent &&
    pvPower >= runoffSolarMinimumPower &&
    gridImport <= startImportLimit &&
    runoffHasSurplusForIncrease;

if (runoffCanIncrease) {
    return setCurrent(clamp(current + currentStep, minCurrent, maxCurrent), 'Runoff increase', 'green');
}

if (
    activeRunoffSession &&
    runoffBatteryDischargeTooHigh &&
    current > minCurrent
) {
    return setCurrent(clamp(current - currentStep, minCurrent, maxCurrent), 'Trim runoff battery drain');
}

if (
    evBelowChargeLimit &&
    !activeRunoffSession &&
    gridExport > increaseExport &&
    current < maxCurrent &&
    gridImport <= startImportLimit
) {
    return setCurrent(clamp(current + currentStep, minCurrent, maxCurrent), 'Increase on surplus', 'green');
}

status(
    'blue',
    'ring',
    `Hold: ${activeRunoffSession ? 'runoff' : evPriority}, ${current}A, EV ${evSoc}%/${evChargeLimit}%, house ${houseBatterySoc}%, EV power ${formatKw(evChargePower)}, effective EV ${formatKw(effectiveEvChargePower)}, PV ${formatKw(pvPower)}, load ${formatKw(houseLoadWithoutEv)}, export ${formatKw(gridExport)}, import ${formatKw(gridImport)}, battery ${formatKw(houseBatteryPower)}`,
);

return null;
