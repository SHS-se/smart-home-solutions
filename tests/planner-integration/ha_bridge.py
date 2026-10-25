"""Real HA producer/consumer with independently authored synthetic external ports.

No household capture, recorded plan, or generated expected result is used here.
The bridge imports production modules exclusively from the explicitly pinned checkout.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

if sys.version_info < (3, 12):
    raise RuntimeError("Qualification requires Python >=3.12")

HA_REPO = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(HA_REPO / "custom_components/shs_energy"))
from shs_core.api_contract import INTEGRATION_VERSION  # noqa: E402
from shs_core.household import Household  # noqa: E402
from shs_core.household_ports import HomeFacts, HouseholdPorts  # noqa: E402
from shs_core.durable_record import DurableRecord  # noqa: E402

START = datetime(2026, 1, 12, tzinfo=timezone.utc)


class Store:
    def __init__(self):
        self.value = None

    async def async_load(self):
        return deepcopy(self.value)

    async def async_save(self, value):
        self.value = deepcopy(value)

    def async_delay_save(self, callback, _delay):
        self.value = deepcopy(callback())


def state(value, **attributes):
    return SimpleNamespace(state=str(value), attributes=attributes,
                           last_updated=START, last_reported=START)


def scenario(amps, connected):
    options = {
        "planning_mode": "live", "device_modes": {"$pool": "controlling", "$ev": "controlling"},
        "battery_enabled": False, "ev_enabled": True, "pool_enabled": True,
        "ev_connected_entity": "binary_sensor.synthetic_cable",
        "ev_soc_entity": "sensor.synthetic_soc", "ev_target_soc_entity": "number.synthetic_charge_limit",
        "ev_energy_remaining_entity": "sensor.synthetic_remaining", "ev_charge_switch_entity": "switch.synthetic_charge",
        "ev_charge_efficiency": .92, "ev_kwh_per_km": .16,
        "pool_water_temperature_entity": "sensor.synthetic_water", "pool_volume_m3": 40,
        "pool_start_temperature_entity": "number.synthetic_start", "pool_stop_temperature_entity": "number.synthetic_stop",
        "house_consumption_power_entity": "sensor.synthetic_house_power",
        "grid_import_limit_w": 500 + 3600 + 690 * amps, "grid_export_limit_w": 15000,
        "device_control_mappings": {
            "synthetic_pool": {"control_type": "switch_schedule", "actuator_entity_ids": ["switch.synthetic_pool"], "power": "sensor.synthetic_pool_power"},
            "synthetic_ev": {"control_type": "variable_power", "control_entity_id": "number.synthetic_current", "minimum_value": 5, "maximum_value": 16},
        },
    }
    states = {
        "binary_sensor.synthetic_cable": state("on" if connected else "off"),
        "sensor.synthetic_soc": state(5, unit_of_measurement="%"),
        "number.synthetic_charge_limit": state(80, unit_of_measurement="%"),
        "sensor.synthetic_remaining": state(3.75, unit_of_measurement="kWh"),
        "number.synthetic_current": state(5, min=5, max=16, step=1, unit_of_measurement="A"),
        "switch.synthetic_charge": state("off"), "switch.synthetic_pool": state("on"),
        "sensor.synthetic_water": state(26, unit_of_measurement="°C"),
        "number.synthetic_start": state(28, unit_of_measurement="°C"),
        "number.synthetic_stop": state(34, unit_of_measurement="°C"),
        "sensor.synthetic_house_power": state(1700, unit_of_measurement="W"),
        "sensor.synthetic_pool_power": state(1200, unit_of_measurement="W"),
    }
    devices = [{"key": key, "name": key, "statistic_id": "sensor." + key,
        "category": category, "planning_role": "controllable", "control_type": control,
        "suggested_load_type": load, "load_type": load, "active_power_w": None,
        "profile_sample_count": 0, "inference": {}, "mapping_status": "ready"}
        for key, category, control, load in [
            ("synthetic_pool", "pool_heating", "switch_schedule", "fixed_full_load"),
            ("synthetic_ev", "ev_charging", "variable_power", "variable_full_load")]]
    return options, states, devices


def room_scenario(thermostat=False):
    options, states, devices = scenario(12, True)
    options.update(ev_enabled=False, pool_enabled=False, device_modes={"synthetic_relay": "controlling"})
    options["device_control_mappings"] = {"synthetic_relay": {"control_type": "switch_schedule",
        "actuator_entity_ids": ["switch.synthetic_relay"], "power": 1000,
        "room_key": "synthetic_room", "room_name": "Synthetic room",
        "temperature_entity_id": "sensor.synthetic_room"}}
    states["switch.synthetic_relay"] = state("off")
    states["sensor.synthetic_room"] = state(18, unit_of_measurement="°C")
    states["sensor.synthetic_house_power"].state = "800"
    relay = {**devices[0], "key": "synthetic_relay", "name": "Synthetic relay", "statistic_id": "sensor.synthetic_relay",
        "category": "heating"}
    if thermostat:
        options["device_control_mappings"]["synthetic_relay"].update(control_type="setpoint",
            actuator_entity_ids=["climate.synthetic_room"], power="sensor.synthetic_room_power")
        relay["control_type"] = "setpoint"
        states["sensor.synthetic_room_power"] = state(3, unit_of_measurement="W")
        states["climate.synthetic_room"] = state("heat", hvac_action="idle", temperature=16,
            current_temperature=18, min_temp=5, max_temp=30, target_temp_step=.5)
    return options, states, [relay]


class History:
    """A complete synthetic meter history: base500 W, pool quarter average1200 W."""
    def __init__(self, room=False, pool_w=1200):
        self.room = room
        self.pool_w = pool_w

    async def statistics(self, start, end, entities, period, units, kinds):
        assert period == "5minute"
        if kinds == {"mean"}:
            if set(entities) == {"sensor.synthetic_soc"}:
                return {"sensor.synthetic_soc": [{"start": (start+timedelta(minutes=5*i)).timestamp(), "mean": 5}
                    for i in range(int((end-start).total_seconds()/300))]}
            assert units == {"power":"W"}
            # Two independently authored complete ON buckets, then low idle.
            return {"sensor.synthetic_room_power":[{"start":(end-timedelta(minutes=15)).timestamp(),"mean":1180},
                {"start":(end-timedelta(minutes=10)).timestamp(),"mean":1220},
                {"start":(end-timedelta(minutes=5)).timestamp(),"mean":3}]}
        watts = {"sensor.synthetic_grid": 800 if self.room else 500 + self.pool_w, "sensor.synthetic_pool": self.pool_w,
                 "sensor.synthetic_ev": 0, "sensor.synthetic_relay": 300}
        return {entity: [{"start": (start + timedelta(minutes=5*i)).timestamp(),
                          "change": watts.get(entity, 0)/12000}
                         for i in range(int((end-start).total_seconds()/300))]
                for entity in entities}

    async def states(self, start, end, entities, *, with_attributes):
        if "sensor.synthetic_pool" in entities:
            attrs = {"unit_of_measurement": "kWh", "state_class": "total_increasing"}
            return {"sensor.synthetic_pool": [(start, "100", attrs),
                (end, str(100 + self.pool_w * (end-start).total_seconds()/3_600_000), attrs)]}
        if "climate.synthetic_room" in entities:
            assert with_attributes
            return {"climate.synthetic_room":[(start,"heat",{"hvac_action":"idle"}),
                (end-timedelta(minutes=15),"heat",{"hvac_action":"heating"}),
                (end-timedelta(minutes=5),"heat",{"hvac_action":"idle"})]}
        return {entity: [(start, "on", {})] if entity == "switch.synthetic_pool" else [] for entity in entities}

    async def hourly_forecast(self, _entity):
        return []


def tariff():
    return {"schema_version": 3, "calculation_version": 3, "timezone": "UTC",
        "configuration": {"profile_id": "synthetic", "connection_type": "three_phase", "fuse_a": 20,
            "include_vat": False, "energy_tax_reduced": False, "production_enabled": False,
            "fuse_periods": [{"valid_from": None, "fuse_a": 20}]}, "missing_inputs": [],
        "profiles": [{"id": "synthetic", "provider_key": "synthetic", "tariff_key": "synthetic",
            "provider_name": "Synthetic", "display_name": "Synthetic", "currency": "SEK", "versions": [{
                "id": "synthetic", "profile_id": "synthetic", "revision": "synthetic", "valid_from": "2025-01-01", "valid_to": None,
                "calculation_model": "se_grid_v1", "definition": {"schema_version": 1, "vat_rate": 0,
                    "energy_tax": {"ore_per_kwh_ex_vat": 0, "reduction_ore_per_kwh": 0},
                    "plans": {"three_phase": {"selector": "fuse_a", "fixed_monthly_sek_ex_vat": {"20": 0},
                        "transfer": {"mode": "flat", "ore_per_kwh_ex_vat": 0}}},
                    "export_credit": {"schedule": "swedish_winter_weekday_06_22_v1", "ore_per_kwh_ex_vat_by_area": {}}}}]}]}


async def produce(amps, connected, room=False, electrical="retained", manual_pool_w=None):
    assert electrical in ("retained", "missing", "configured")
    options, states, devices = room_scenario(room == "thermostat") if room else scenario(amps, connected)
    if electrical == "configured":
        options["device_control_mappings"]["synthetic_pool"]["power"] = 3600
    async def admit(_old, _new):
        raise AssertionError("capture must not mutate configuration")
    async def inventory():
        return deepcopy(devices)
    def spawn(coroutine, _name):
        coroutine.close()
        raise AssertionError("capture must not start background jobs")
    async def electrical_power_bounds(mappings):
        from shs_core.grid_capacity import device_power_bound
        # Independently specified 3.6 kW compressor, measured at full ON in
        # retained electrical evidence. Current and quarter mean are 1.2 kW.
        peaks = {"sensor.synthetic_pool_power":3600, "sensor.synthetic_room_power":4800} if electrical == "retained" else {}
        return {key:device_power_bound(mapping, peaks,
                getattr(states.get(mapping.get("power_setting_entity_id")), "state", None))
                for key,mapping in mappings.items()}
    captured = START if manual_pool_w is None else START + timedelta(minutes=7)
    ports = HouseholdPorts(home=lambda: HomeFacts(0, 0, "en", ZoneInfo("UTC")), options=lambda: deepcopy(options),
        admit=admit, read_state=states.get, entity_ids=lambda: set(states), entity_names=lambda: {}, area_names=lambda: {},
        entity_areas=lambda: {}, inventory=inventory, battery_report=lambda _entity: None,
        history=History(room, 1200 if manual_pool_w is None else manual_pool_w),
        utcnow=lambda: captured, recovering=lambda: False, repair=lambda *_args: None, publish=lambda: None, spawn=spawn,
        electrical_power_bounds=electrical_power_bounds)
    household = Household(ports, SimpleNamespace(), store=DurableRecord(Store(), json.dumps, json.loads),
                          battery_inputs_store=Store(), connection_store=Store(), control_authority=True)
    household.tariff_catalog = tariff()
    household.supplier_prices = {"schema_version": 1, "configuration": {"supplier": "synthetic", "price_area": "SE3"},
        "issued_at": START.isoformat(), "missing_inputs": [], "forecast": [
            {"start": (START+timedelta(minutes=15*i)).isoformat(), "end": (START+timedelta(minutes=15*(i+1))).isoformat(),
             "spot_price_sek_per_kwh": .2, "supplier_import_price_sek_per_kwh": .2, "supplier_export_price_sek_per_kwh": .1}
            for i in range(288)]}
    categories = {key: [] for key in ("total_consumption", "grid_import", "grid_export", "solar_production", "battery_charge", "battery_discharge")}
    categories["grid_import"] = ["sensor.synthetic_grid"]
    categories["pool_heating"] = ["sensor.synthetic_pool"]
    categories["ev_charging"] = ["sensor.synthetic_ev"]
    if room:
        categories["pool_heating"] = []
        categories["ev_charging"] = []
        categories["heating"] = ["sensor.synthetic_relay"]
    actuals = None
    if manual_pool_w is None:
        snapshot = await household._build_optimisation_snapshot(options, categories, [], {}, devices)
    else:
        # Exercise the exchange that previously omitted observations on manual
        # requests. Only cloud/configuration side effects are inert; recorder
        # aggregation, upload acquisition and snapshot production are real.
        for category, entities in categories.items():
            options["entities_" + category] = entities
        household._optimisation_options = lambda: deepcopy(options)
        household.async_report_runtime = AsyncMock()
        household.async_battery_inputs_refresh = AsyncMock()
        household._record_device_exchange = AsyncMock()
        household.client.push_optimisation = AsyncMock(return_value={})
        await household._store.async_save({"optimisation_actuals_accepted_until":
            (START - timedelta(minutes=30)).isoformat(),
            "optimisation_device_configuration": {device["key"]: deepcopy(device) for device in devices}})
        await household.async_optimisation_push(force_plan=True, replan_request_id="synthetic-manual")
        assert household.client.push_optimisation.await_count == 1, household.last_optimisation_error
        actuals, snapshot = household.client.push_optimisation.call_args.args[:2]
        assert snapshot is not None, household.last_optimisation_error
    return {"integration_version": INTEGRATION_VERSION,
            "app_version": json.loads((HA_REPO / "web/package.json").read_text())["version"], "provenance": "independently_generated_synthetic",
            "snapshot": snapshot, "options": options, **({"actuals": actuals} if actuals is not None else {})}


class Operations:
    """Operation persistence port; the actual native command journal is sqlite."""
    async def begin(self, _value):
        return {"state": "new"}

    async def finish(self, _value, _result):
        pass


class ScenarioClock(datetime):
    current = START + timedelta(seconds=30)

    @classmethod
    def now(cls, tz=None):
        return cls.current.astimezone(tz)


async def consume(payload):
    from shs_core.optimisation import validate_plan_contract
    from shs_core.operating_modes import scoped_plan
    from shs_core.device_port import device_intent
    from shs_core.device_gateway import DeviceGateway
    from shs_core.controller_inputs import ControllerInputs
    from shs_core.command_journal import CommandJournal
    from shs_core.command_transport import CommandTransport
    from shs_core.native_commands import NativeExecutor

    plan = payload["plan"]
    validate_plan_contract(plan, START)
    room = payload.get("room", False)
    options, states, _devices = room_scenario(room == "thermostat") if room else scenario(payload["amps"], payload["connected"])
    assert options == payload["options"], "consumer uses the exact producer configuration"
    states["switch.synthetic_pool"].state = "off"
    # Force both physical paths to emit a command, including a disconnected EV.
    states["switch.synthetic_charge"].state = "on" if not payload.get("connected", True) else "off"
    calls = []
    async def send(domain, service, data):
        entity = data["entity_id"]
        value = data.get("value", data.get("temperature", data.get("option", service.removeprefix("turn_"))))
        calls.append({"domain": domain, "service": service, "entity": entity, "value": value})
        if domain == "climate" and service == "set_temperature":
            states[entity].attributes["temperature"] = data["temperature"]
        else:
            states[entity].state = str(value)
    with tempfile.TemporaryDirectory(prefix="shs-synthetic-execution-") as directory:
        journal = CommandJournal(Path(directory) / "commands.sqlite").open("synthetic-qualification")
        executor = NativeExecutor(CommandTransport(journal, asyncio.to_thread), states.get, lambda: "°C", send)
        gateway = DeviceGateway(ControllerInputs(states.get, lambda: "°C", lambda _entity: None),
            lambda: deepcopy(options), Store(), executor, authorize=lambda _intent: None,
            before_external=lambda _device, **_command: True, operations=Operations())
        await gateway.load()
        await gateway.synchronize(plan["device_models"])
        outcomes = {}
        relay_states = []
        with patch("shs_core.device_gateway.datetime", ScenarioClock):
            for device in (("device:synthetic_relay",) if room else ("pool", "ev")):
                selected = scoped_plan(plan, options, device)
                assert selected is not None
                slots = selected["plans"]["priority"]["slots"] if room is True else selected["plans"]["priority"]["slots"][:1]
                for slot in slots:
                    ScenarioClock.current = datetime.fromisoformat(slot["start"].replace("Z", "+00:00")) + timedelta(seconds=30)
                    intent = device_intent(device, "apply", selected, slot, configuration_revision=1, policy_revision=1)
                    # Grid admission is exercised by the planner's full reservation;
                    # this port says that reservation was acquired before execution.
                    intent["headroom_reserved"] = True
                    outcome = await gateway.perform(intent)
                    assert outcome["error"] is None, outcome
                    outcomes[device] = outcome["result"]
                    if room:
                        relay_states.append(states["switch.synthetic_relay"].state)
        if room:
            return {"admitted": True, "commands": calls, "relay_states": relay_states}
        return {"admitted": True, "commands": calls,
                "pool_switch": states["switch.synthetic_pool"].state,
                "ev_switch": states["switch.synthetic_charge"].state,
                "ev_current": float(states["number.synthetic_current"].state),
                "ev_condition": outcomes["ev"].get("execution_condition")}


async def main():
    if sys.argv[2] == "produce":
        result = await produce(int(sys.argv[3]), sys.argv[4] == "connected", electrical=sys.argv[5] if len(sys.argv) > 5 else "retained")
    elif sys.argv[2] == "produce-room":
        result = await produce(12, True, room=True)
    elif sys.argv[2] == "produce-thermostat":
        result = await produce(12, True, room="thermostat")
    elif sys.argv[2] == "produce-manual-pool":
        result = await produce(12, True, manual_pool_w=float(sys.argv[3]))
    elif sys.argv[2] == "consume":
        result = await consume(json.load(sys.stdin))
    else:
        raise ValueError("unknown operation")
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    asyncio.run(main())
