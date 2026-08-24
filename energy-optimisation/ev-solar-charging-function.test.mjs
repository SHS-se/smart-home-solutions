import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const functionSource = readFileSync(
    new URL('./ev-solar-charging-function.js', import.meta.url),
    'utf8',
);

const executeFunction = new Function(
    'global',
    'flow',
    'node',
    'msg',
    'Date',
    functionSource,
);

const baseEntities = {
    'sensor.tesla_model_y_battery_level': 40,
    'number.tesla_model_y_charge_limit': 80,
    'sensor.filtered_pool_water_temperature': 30,
    'binary_sensor.node_red_pool_heating_complete': 'on',
    'sensor.sigen_plant_battery_state_of_charge': 95,
    'sensor.sigen_plant_battery_power': 0,
    'sensor.sigen_plant_grid_export_power': 0,
    'sensor.sigen_plant_grid_import_power': 0,
    'sensor.sigen_plant_grid_active_power': 4,
    'sensor.sigen_inverter_active_power': 0,
    'sensor.sigen_inverter_pv_power': 7,
    'sensor.meteo_solar_production_forecast_estimate_tomorrow': 10,
    'sensor.meteo_solar_production_forecast_estimate_remaining_today': 6,
    'number.tesla_model_y_charge_current': 5,
    'sensor.tesla_model_y_charger_power': 3.45,
    'switch.tesla_model_y_charge': 'on',
    'binary_sensor.tesla_model_y_charge_cable': 'on',
    'input_number.ev_charging_ev_soc_high_priority_threshold': 30,
    'input_number.ev_charging_ev_soc_low_priority_threshold': 60,
    'input_number.solar_forecast_good_production': 30,
    'input_number.solar_forecast_low_production': 5,
    'input_number.pool_heater_nominal_temp_start': 28,
    'input_number.ev_charging_start_export_power': 1,
    'input_number.ev_charging_start_import_power_limit': 0.2,
    'input_number.ev_charging_reduce_import_power': 0.5,
    'input_number.ev_charging_increase_export_power': 0.7,
    'input_number.ev_charging_equal_priority_min_battery_charge_power': 1,
    'input_number.min_house_battery_soc_to_start_car_charging': 50,
    'input_number.min_house_battery_soc_to_stop_car_charging': 50,
    'input_number.ev_charging_min_battery_soc': 70,
    'input_number.ev_charging_reduce_house_battery_discharge_power': 0.1,
};

const makeFlow = (seed = {}) => {
    const values = new Map(Object.entries(seed));

    return {
        get(key) {
            return values.get(key);
        },
        set(key, value) {
            values.set(key, value);
        },
        values,
    };
};

const runController = ({
    now,
    flow = makeFlow(),
    entities = {},
}) => {
    const stateValues = { ...baseEntities, ...entities };
    const states = Object.fromEntries(
        Object.entries(stateValues).map(([entityId, state]) => [
            entityId,
            { state: String(state) },
        ]),
    );
    const statuses = [];
    const errors = [];
    const msg = {};
    const result = executeFunction(
        {
            get(key) {
                assert.equal(key, 'homeassistant');
                return { homeAssistant: { states } };
            },
        },
        flow,
        {
            status(value) {
                statuses.push(value);
            },
            error(value) {
                errors.push(value);
            },
        },
        msg,
        { now: () => now },
    );

    assert.deepEqual(errors, []);
    return { result, msg, statuses, flow };
};

const fluctuatingPvSamples = (now) => [
    { at: now - 10 * 60 * 1000, power: 8 },
    { at: now - 8 * 60 * 1000, power: 3 },
    { at: now - 6 * 60 * 1000, power: 7.5 },
    { at: now - 4 * 60 * 1000, power: 2.5 },
    { at: now - 2 * 60 * 1000, power: 7 },
];

test('detects cloud fluctuation and uses high-SOC battery headroom', () => {
    const now = Date.parse('2026-08-24T15:22:11Z');
    const flow = makeFlow({
        evSolarCloudPvSamples: fluctuatingPvSamples(now),
    });
    const { result, msg } = runController({
        now,
        flow,
        entities: {
            'sensor.sigen_plant_battery_state_of_charge': 100,
            'sensor.sigen_plant_grid_export_power': 2,
        },
    });

    assert.equal(msg.cloud_pv_fluctuating_now, true);
    assert.equal(msg.cloud_buffer_mode, true);
    assert.equal(msg.cloud_forecast_eligible, true);
    assert.equal(msg.cloud_preferred_battery_power, -1.4);
    assert.equal(result, msg);
    assert.equal(result.ev_action, 'set_current');
    assert.equal(result.ev_current, 6);
});

test('keeps charging at minimum current through a sustained cloudy dip', () => {
    const now = Date.parse('2026-08-24T15:40:00Z');
    const flow = makeFlow({
        evSolarCloudyUntil: now + 30 * 60 * 1000,
        evSolarRunoffSolarLowSince: now - 2 * 60 * 1000,
        evSolarRunoffSessionActive: true,
    });
    const { result, msg } = runController({
        now,
        flow,
        entities: {
            'sensor.sigen_inverter_pv_power': 1,
            'sensor.sigen_plant_battery_power': -2.5,
        },
    });

    assert.equal(msg.cloud_buffer_mode, true);
    assert.equal(msg.runoff_solar_low_for_too_long, true);
    assert.equal(result, null);
    assert.equal(msg.ev_action, undefined);
});

test('stops before the home battery can cross the 90 percent reserve', () => {
    const now = Date.parse('2026-08-24T16:00:00Z');
    const flow = makeFlow({
        evSolarCloudyUntil: now + 30 * 60 * 1000,
        evSolarRunoffSessionActive: true,
        evSolarStartedAt: now - 60 * 1000,
    });
    const { result, msg } = runController({
        now,
        flow,
        entities: {
            'sensor.sigen_plant_battery_state_of_charge': 90.5,
            'sensor.sigen_plant_battery_power': -1,
        },
    });

    assert.equal(msg.cloud_buffer_mode, true);
    assert.equal(result.ev_action, 'stop');
});

test('waits for 92 percent SOC before restarting a cloud-buffer session', () => {
    const now = Date.parse('2026-08-24T16:00:00Z');
    const makeStartFlow = () => makeFlow({
        evSolarCloudyUntil: now + 30 * 60 * 1000,
        evSolarStartPasses: 1,
    });
    const startEntities = {
        'sensor.sigen_plant_battery_power': 4,
        'sensor.sigen_plant_grid_export_power': 0,
        'switch.tesla_model_y_charge': 'off',
        'sensor.tesla_model_y_charger_power': 0,
    };

    const belowResume = runController({
        now,
        flow: makeStartFlow(),
        entities: {
            ...startEntities,
            'sensor.sigen_plant_battery_state_of_charge': 91.5,
        },
    });
    assert.equal(belowResume.result, null);
    assert.equal(belowResume.msg.ev_action, undefined);

    const atResume = runController({
        now,
        flow: makeStartFlow(),
        entities: {
            ...startEntities,
            'sensor.sigen_plant_battery_state_of_charge': 92,
        },
    });
    assert.equal(atResume.result.ev_action, 'start');
    assert.equal(atResume.result.ev_current, 5);
});

test('requires more than 5 kWh remaining forecast for cloud buffering', () => {
    const now = Date.parse('2026-08-24T16:00:00Z');
    const flow = makeFlow({
        evSolarCloudyUntil: now + 30 * 60 * 1000,
        evSolarRunoffSolarLowSince: now - 2 * 60 * 1000,
        evSolarRunoffSessionActive: true,
    });
    const { result, msg } = runController({
        now,
        flow,
        entities: {
            'sensor.sigen_inverter_pv_power': 1,
            'sensor.meteo_solar_production_forecast_estimate_remaining_today': 5,
        },
    });

    assert.equal(msg.cloud_forecast_eligible, false);
    assert.equal(msg.cloud_buffer_mode, false);
    assert.equal(result.ev_action, 'stop');
});

test('declines by only 1 A and waits two minutes before declining again', () => {
    const now = Date.parse('2026-08-24T16:00:00Z');
    const flow = makeFlow({
        evSolarCloudyUntil: now + 30 * 60 * 1000,
        evSolarRunoffSessionActive: true,
        evSolarCloudFilteredSupportablePower: 6.21,
        evSolarCloudFilteredAt: now - 60 * 1000,
        evSolarCurrentChangedAt: now - 3 * 60 * 1000,
        evSolarCloudLastCurrentDirection: 'up',
        evSolarCloudLastCurrentDirectionAt: now - 10 * 60 * 1000,
    });
    const lowSolarEntities = {
        'sensor.sigen_plant_battery_state_of_charge': 100,
        'sensor.sigen_inverter_pv_power': 1,
        'sensor.sigen_plant_battery_power': -3,
        'number.tesla_model_y_charge_current': 9,
        'sensor.tesla_model_y_charger_power': 6.21,
    };

    const first = runController({ now, flow, entities: lowSolarEntities });
    assert.equal(first.result.ev_action, 'set_current');
    assert.equal(first.result.ev_current, 8);

    const second = runController({
        now: now + 60 * 1000,
        flow,
        entities: {
            ...lowSolarEntities,
            'number.tesla_model_y_charge_current': 8,
            'sensor.tesla_model_y_charger_power': 5.52,
        },
    });
    assert.equal(second.result, null);

    const third = runController({
        now: now + 2 * 60 * 1000,
        flow,
        entities: {
            ...lowSolarEntities,
            'number.tesla_model_y_charge_current': 8,
            'sensor.tesla_model_y_charger_power': 5.52,
        },
    });
    assert.equal(third.result.ev_action, 'set_current');
    assert.equal(third.result.ev_current, 7);
});

test('does not immediately reverse a recent cloudy-mode decrease', () => {
    const now = Date.parse('2026-08-24T16:00:00Z');
    const flow = makeFlow({
        evSolarCloudyUntil: now + 30 * 60 * 1000,
        evSolarRunoffSessionActive: true,
        evSolarCloudFilteredSupportablePower: 8,
        evSolarCloudFilteredAt: now - 60 * 1000,
        evSolarCurrentChangedAt: now - 2 * 60 * 1000,
        evSolarCloudLastCurrentDirection: 'down',
        evSolarCloudLastCurrentDirectionAt: now - 2 * 60 * 1000,
    });
    const { result, statuses } = runController({
        now,
        flow,
        entities: {
            'sensor.sigen_plant_battery_state_of_charge': 100,
            'sensor.sigen_plant_grid_export_power': 5,
            'number.tesla_model_y_charge_current': 8,
            'sensor.tesla_model_y_charger_power': 5.52,
        },
    });

    assert.equal(result, null);
    assert.match(statuses.at(-1).text, /direction lock/);
});
