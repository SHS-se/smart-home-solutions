"""Synthetic delayed EV / battery effects through the pinned app's real gateway.

The caller of this qualification pins and verifies the app checkout first.
Native send ports are inert and the capacity journal is a temporary SQLite file.
"""
from pathlib import Path
import sys
import unittest

APP = Path(sys.argv.pop(1)).resolve()
sys.path.insert(0, str(APP / "tests"))
import test_grid_capacity as capacity_fixtures
import test_capacity_withdrawal as withdrawal_fixtures
from shs_core.device_operations import ControlDeadlineError


class DelayedChargingHandoffs(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = capacity_fixtures.LiveImportTests.asyncSetUp
    configure_ev = capacity_fixtures.LiveImportTests.configure_ev
    native = capacity_fixtures.LiveImportTests.native
    record = withdrawal_fixtures.WithdrawalCompositionTests.record

    async def reports(self, **values):
        for entity, state in values.items():
            self.rows[entity]["state"] = str(state)
            await self.record(entity)
        await self.source.refresh_capacity()

    async def test_battery_waits_for_ev_power_after_off_acknowledgement(self):
        self.configure_ev()
        self.service.import_limit_w = 15000
        await self.native("synthetic-ev-on", "ev", "switch.ev", "turn_on")
        await self.reports(**{"switch.ev": "on", "sensor.ev": 11040, "sensor.house": 12040})
        await self.native("synthetic-ev-off", "ev", "switch.ev", "turn_off")
        await self.reports(**{"switch.ev": "off", "select.mode": "Command Charging (PV First)"})
        with self.assertRaisesRegex(ControlDeadlineError, "house import capacity"):
            await self.native("synthetic-battery-early", "battery", "number.charge", "set_value", 4)
        self.assertEqual(len(self.calls), 2, "ACK without a reduction released capacity")
        await self.reports(**{"sensor.ev": 0, "sensor.house": 1000})
        await self.native("synthetic-battery-ready", "battery", "number.charge", "set_value", 4)
        self.assertEqual(len(self.calls), 3)

    async def test_ev_waits_for_battery_power_after_ceiling_acknowledgement(self):
        self.configure_ev()
        self.service.import_limit_w = 15000
        await self.reports(**{"select.mode": "Command Charging (PV First)", "number.charge": 0,
                              "number.discharge": 0, "sensor.battery": 0})
        await self.native("synthetic-battery-on", "battery", "number.charge", "set_value", 4)
        await self.reports(**{"number.charge": 4, "sensor.battery": 4000})
        await self.native("synthetic-battery-off", "battery", "number.charge", "set_value", 0)
        await self.reports(**{"number.charge": 0})
        with self.assertRaisesRegex(ControlDeadlineError, "house import capacity"):
            await self.native("synthetic-ev-early", "ev", "switch.ev", "turn_on")
        self.assertEqual(len(self.calls), 2, "ceiling acknowledgement released physical demand")
        await self.reports(**{"sensor.battery": 0})
        await self.native("synthetic-ev-ready", "ev", "switch.ev", "turn_on")
        self.assertEqual(len(self.calls), 3)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(DelayedChargingHandoffs)
    suite.addTest(capacity_fixtures.DurableDemandTests(
        "test_never_observed_uncertain_higher_write_survives_later_off_and_restart"))
    suite.addTest(capacity_fixtures.DispatchFenceTests(
        "test_reports_queued_during_prepare_cannot_confirm_a_later_dispatch"))
    sys.exit(0 if unittest.TextTestRunner().run(suite).wasSuccessful() else 1)
