//! Stationary battery: terminal DC ratings, stored inventory and installation AC conversion.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Curve {
    pub gain: f64,
    pub overhead_w: f64,
}
impl Curve {
    pub fn output(&self, input: f64) -> f64 {
        if input > 0.0 {
            (self.gain * input - self.overhead_w).max(0.0)
        } else {
            0.0
        }
    }
    pub fn input(&self, output: f64) -> f64 {
        if output > 0.0 {
            (output + self.overhead_w) / self.gain
        } else {
            0.0
        }
    }
    fn valid(&self) -> bool {
        self.gain.is_finite()
            && self.gain > 0.0
            && self.gain <= 1.0
            && self.overhead_w.is_finite()
            && self.overhead_w >= 0.0
            && self.overhead_w <= 10000.0
    }
}

/// The same directional conversion and installation-overhead floor used by the controller.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Conversion {
    pub revision: String,
    pub grid_charge: Curve,
    pub surplus_charge: Curve,
    pub discharge: Curve,
    pub idle_loss_w: f64,
}
impl Conversion {
    pub fn valid(&self) -> bool {
        !self.revision.is_empty()
            && self.revision.len() <= 128
            && self.grid_charge.valid()
            && self.surplus_charge.valid()
            && self.discharge.valid()
            && self.idle_loss_w.is_finite()
            && self.idle_loss_w >= 0.0
            && self.idle_loss_w <= 10000.0
    }
    pub fn solar_capacity(&self, pv: f64, house: f64) -> f64 {
        self.surplus_charge.output((pv - house).max(0.0))
    }
    pub fn charge_inputs(&self, dc: f64, pv: f64, house: f64) -> (f64, f64) {
        let solar = dc.min(self.solar_capacity(pv, house));
        (
            self.surplus_charge.input(solar),
            self.grid_charge.input((dc - solar).max(0.0)),
        )
    }
    fn charge_fixed(&self, solar: bool, grid: bool) -> f64 {
        (if solar {
            self.surplus_charge.overhead_w / self.surplus_charge.gain
        } else {
            0.0
        }) + if grid {
            self.grid_charge.overhead_w / self.grid_charge.gain
        } else {
            0.0
        }
    }
    pub fn discharge_idle_w(&self) -> f64 {
        (self.idle_loss_w - self.discharge.overhead_w).max(0.0)
    }
    /// Greatest terminal charge whose AC input plus persistent overhead fits this budget.
    pub fn charge_dc_for_grid_room(&self, room: f64, pv: f64, house: f64) -> f64 {
        let surplus = (pv - house).max(0.0);
        let cap = self.solar_capacity(pv, house);
        if cap <= 0.0 {
            let idle = (self.idle_loss_w - self.charge_fixed(false, true)).max(0.0);
            return self.grid_charge.output((room - idle).max(0.0));
        }
        let solar_idle = (self.idle_loss_w - self.charge_fixed(true, false)).max(0.0);
        let solar = self
            .surplus_charge
            .output((room - solar_idle).max(0.0).min(surplus));
        let mixed_idle = (self.idle_loss_w - self.charge_fixed(true, true)).max(0.0);
        let grid = self
            .grid_charge
            .output((room - mixed_idle - surplus).max(0.0));
        if grid > 0.0 {
            cap + grid
        } else {
            solar
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Battery {
    pub capacity_kwh: f64,
    pub min_soc: f64,
    pub max_soc: f64,
    /// Battery-terminal DC power rating, not an AC command ceiling.
    pub charge_max_w: f64,
    /// Battery-terminal DC power rating, not delivered AC power.
    pub discharge_max_w: f64,
    /// Stored energy gained per terminal DC charging energy.
    pub charge_efficiency: f64,
    /// Terminal DC discharge energy per stored energy spent.
    pub discharge_efficiency: f64,
    pub conversion: Conversion,
}
#[derive(Clone, Copy, Debug)]
pub struct BatteryFlow {
    pub charge_ac_w: f64,
    pub discharge_ac_w: f64,
    pub charge_dc_w: f64,
    pub discharge_dc_w: f64,
    pub idle_ac_w: f64,
    pub stored_end_kwh: f64,
}
impl Battery {
    pub fn charge_ac_w(&self, dc: f64, pv: f64, house: f64) -> f64 {
        let (solar, grid) = self.conversion.charge_inputs(dc, pv, house);
        solar + grid
    }
    /// Exact inverse of charge_inputs, including inactive surplus and mixed-branch dead zones.
    pub fn charge_dc_w(&self, ac: f64, pv: f64, house: f64) -> f64 {
        let c = &self.conversion;
        let surplus = (pv - house).max(0.0);
        if c.solar_capacity(pv, house) <= 0.0 {
            c.grid_charge.output(ac)
        } else {
            c.surplus_charge.output(ac.min(surplus)) + c.grid_charge.output((ac - surplus).max(0.0))
        }
    }
    pub fn discharge_ac_w(&self, dc: f64) -> f64 {
        self.conversion.discharge.output(dc)
    }
    pub fn discharge_dc_w(&self, ac: f64) -> f64 {
        self.conversion.discharge.input(ac)
    }
    pub fn available_charge_dc_w(&self, kwh: f64, hours: f64) -> f64 {
        ((self.max_soc * self.capacity_kwh - kwh).max(0.0) * 1000.0
            / hours
            / self.charge_efficiency)
            .min(self.charge_max_w)
    }
    pub fn available_discharge_dc_w(&self, kwh: f64, hours: f64) -> f64 {
        ((kwh - self.min_soc * self.capacity_kwh).max(0.0) * 1000.0 / hours
            * self.discharge_efficiency)
            .min(self.discharge_max_w)
    }
    pub fn available_charge_w(&self, kwh: f64, hours: f64, pv: f64, house: f64) -> f64 {
        self.charge_ac_w(self.available_charge_dc_w(kwh, hours), pv, house)
    }
    pub fn available_discharge_w(&self, kwh: f64, hours: f64) -> f64 {
        self.discharge_ac_w(self.available_discharge_dc_w(kwh, hours))
    }
    pub fn charge_for_inventory_w(&self, delta: f64, hours: f64, pv: f64, house: f64) -> f64 {
        self.charge_ac_w(
            delta.max(0.0) * 1000.0 / hours / self.charge_efficiency,
            pv,
            house,
        )
    }
    pub fn discharge_for_inventory_w(&self, delta: f64, hours: f64) -> f64 {
        self.discharge_ac_w(delta.max(0.0) * 1000.0 / hours * self.discharge_efficiency)
    }
    pub fn charge_grid_room_w(&self, room: f64, pv: f64, house: f64) -> f64 {
        self.charge_ac_w(
            self.conversion.charge_dc_for_grid_room(room, pv, house),
            pv,
            house,
        )
    }
    /// Source-independent AC ceiling for automatic permissions; projection enforces the DC rating.
    pub fn maximum_charge_ac_w(&self) -> f64 {
        let c = &self.conversion;
        (c.grid_charge.input(self.charge_max_w)
            + c.surplus_charge.overhead_w / c.surplus_charge.gain)
            .max(
                c.surplus_charge.input(self.charge_max_w)
                    + c.grid_charge.overhead_w / c.grid_charge.gain,
            )
    }
    pub fn maximum_discharge_ac_w(&self) -> f64 {
        self.discharge_ac_w(self.discharge_max_w)
    }
    pub fn step(&self, kwh: f64, charge_dc: f64, discharge_dc: f64, hours: f64) -> f64 {
        kwh + hours / 1000.0
            * (charge_dc * self.charge_efficiency - discharge_dc / self.discharge_efficiency)
    }
    pub fn project_ac(
        &self,
        kwh: f64,
        hours: f64,
        charge: f64,
        discharge: f64,
        pv: f64,
        house: f64,
    ) -> BatteryFlow {
        self.project_dc(
            kwh,
            hours,
            self.charge_dc_w(charge, pv, house),
            self.discharge_dc_w(discharge),
            pv,
            house,
        )
    }
    /// The terminal-power binding of the same physical transition (for controller conformance).
    pub fn project_dc(
        &self,
        kwh: f64,
        hours: f64,
        charge: f64,
        discharge: f64,
        pv: f64,
        house: f64,
    ) -> BatteryFlow {
        // Quarter-average observations may contain both directions. Allow the
        // opposite flow's real storage movement to provide inventory room, while
        // never worsening a measured state outside the configured SOC bounds.
        let wanted_charge = charge.min(self.charge_max_w);
        let wanted_discharge = discharge.min(self.discharge_max_w);
        let ceiling = (self.max_soc * self.capacity_kwh).max(kwh);
        let floor = (self.min_soc * self.capacity_kwh).min(kwh);
        let charge_dc = wanted_charge.min(
            (ceiling - kwh) * 1000.0 / hours / self.charge_efficiency
                + wanted_discharge / (self.charge_efficiency * self.discharge_efficiency),
        );
        let discharge_dc = wanted_discharge.min(
            (kwh - floor) * 1000.0 / hours * self.discharge_efficiency
                + charge_dc * self.charge_efficiency * self.discharge_efficiency,
        );
        let c = &self.conversion;
        let (solar, grid) = c.charge_inputs(charge_dc, pv, house);
        let charge_fixed = c.charge_fixed(solar > 0.0, grid > 0.0);
        let discharge_fixed = if discharge_dc > 0.0 {
            c.discharge.overhead_w
        } else {
            0.0
        };
        let represented = charge_fixed + discharge_fixed.min(c.discharge.gain * discharge_dc);
        BatteryFlow {
            charge_ac_w: solar + grid,
            discharge_ac_w: self.discharge_ac_w(discharge_dc),
            charge_dc_w: charge_dc,
            discharge_dc_w: discharge_dc,
            idle_ac_w: c.idle_loss_w.max(charge_fixed + discharge_fixed) - represented,
            stored_end_kwh: self.step(kwh, charge_dc, discharge_dc, hours),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model() -> Battery {
        Battery {
            capacity_kwh: 20.0,
            min_soc: 0.05,
            max_soc: 1.0,
            charge_max_w: 5000.0,
            discharge_max_w: 5000.0,
            charge_efficiency: 0.98,
            discharge_efficiency: 0.97,
            conversion: Conversion {
                revision: "synthetic-affine".into(),
                grid_charge: Curve {
                    gain: 0.9,
                    overhead_w: 90.0,
                },
                surplus_charge: Curve {
                    gain: 0.95,
                    overhead_w: 95.0,
                },
                discharge: Curve {
                    gain: 0.96,
                    overhead_w: 120.0,
                },
                idle_loss_w: 150.0,
            },
        }
    }
    fn near(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-8, "{a} != {b}");
    }
    #[test]
    fn refined_model_is_required_while_extra_snapshot_telemetry_is_preserved() {
        let mut wire = serde_json::to_value(model()).unwrap();
        wire["soc"] = serde_json::json!(0.5);
        assert!(serde_json::from_value::<Battery>(wire.clone()).is_ok());
        wire.as_object_mut().unwrap().remove("conversion");
        assert!(serde_json::from_value::<Battery>(wire).is_err());
    }
    #[test]
    fn shared_independent_installation_physics_conformance() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../contracts/battery-physics-v1.json"))
                .unwrap();
        let battery: Battery = serde_json::from_value(fixture["battery"].clone()).unwrap();
        let number = |row: &serde_json::Value, key: &str| row[key].as_f64().unwrap();
        for row in fixture["forward"].as_array().unwrap() {
            let f = battery.project_dc(
                number(row, "stored_kwh"),
                number(row, "hours"),
                number(row, "charge_dc_w"),
                number(row, "discharge_dc_w"),
                number(row, "pv_w"),
                number(row, "house_w"),
            );
            let expected = &row["expected"];
            near(f.charge_ac_w, number(expected, "charge_w"));
            near(f.discharge_ac_w, number(expected, "discharge_w"));
            near(f.idle_ac_w, number(expected, "battery_idle_w"));
            near(f.stored_end_kwh, number(expected, "battery_kwh"));
            near(
                number(row, "house_w") - number(row, "pv_w") + f.charge_ac_w - f.discharge_ac_w
                    + f.idle_ac_w,
                number(expected, "net_w"),
            );
        }
        for row in fixture["charge_inverse"].as_array().unwrap() {
            near(
                battery.charge_dc_w(
                    number(row, "ac_w"),
                    number(row, "pv_w"),
                    number(row, "house_w"),
                ),
                number(row, "expected_dc_w"),
            );
        }
        for row in fixture["projection"].as_array().unwrap() {
            let f = battery.project_ac(
                number(row, "stored_kwh"),
                number(row, "hours"),
                number(row, "charge_w"),
                number(row, "discharge_w"),
                number(row, "pv_w"),
                number(row, "house_w"),
            );
            let expected = &row["expected"];
            near(f.charge_ac_w, number(expected, "charge_w"));
            near(f.discharge_ac_w, number(expected, "discharge_w"));
            near(f.charge_dc_w, number(expected, "charge_dc_w"));
            near(f.discharge_dc_w, number(expected, "discharge_dc_w"));
            near(f.idle_ac_w, number(expected, "battery_idle_w"));
            near(f.stored_end_kwh, number(expected, "battery_kwh"));
        }
    }
    #[test]
    fn exact_charge_source_inverse_retains_inactive_solar_and_mixed_dead_zone() {
        let b = model();
        for (pv, house) in [(0.0, 1000.0), (1050.0, 1000.0), (2000.0, 1000.0)] {
            for dc in [0.0, 10.0, 500.0, 855.0, 856.0, 2000.0] {
                near(b.charge_dc_w(b.charge_ac_w(dc, pv, house), pv, house), dc);
            }
        }
        near(b.charge_dc_w(1050.0, 2000.0, 1000.0), 855.0);
        near(
            b.charge_ac_w(b.charge_dc_w(1050.0, 2000.0, 1000.0), 2000.0, 1000.0),
            1000.0,
        );
    }
    #[test]
    fn idle_floor_and_fixed_overhead_are_counted_once() {
        let b = model();
        let idle = b.project_ac(10.0, 0.25, 0.0, 0.0, 0.0, 1000.0);
        near(idle.idle_ac_w, 150.0);
        near(idle.stored_end_kwh, 10.0);
        let charge = b.project_ac(10.0, 0.25, 1000.0, 0.0, 0.0, 1000.0);
        near(charge.charge_dc_w, 810.0);
        near(charge.charge_ac_w, 1000.0);
        near(charge.idle_ac_w, 50.0);
        let discharge = b.project_ac(10.0, 0.25, 0.0, 1000.0, 0.0, 1000.0);
        near(discharge.discharge_dc_w, 1120.0 / 0.96);
        near(discharge.idle_ac_w, 30.0);
    }
    #[test]
    fn dc_ratings_and_inventory_are_independent_of_ac_conversion() {
        let b = model();
        let charge = b.project_ac(19.9, 0.25, 10000.0, 0.0, 0.0, 1000.0);
        near(charge.stored_end_kwh, 20.0);
        near(charge.charge_dc_w, 0.1 * 4000.0 / 0.98);
        let discharge = b.project_ac(1.01, 0.25, 0.0, 10000.0, 0.0, 1000.0);
        near(discharge.stored_end_kwh, 1.0);
        near(discharge.discharge_ac_w, 0.0);
        near(discharge.idle_ac_w, 150.0 - 0.96 * discharge.discharge_dc_w);
        for ac in [0.0, 100.0, 500.0, 1000.0, 5000.0, 10000.0] {
            let f = b.project_ac(10.0, 0.25, ac, 0.0, 2000.0, 1000.0);
            assert!(f.charge_dc_w <= b.charge_max_w);
            near(
                (f.stored_end_kwh - 10.0) * 4000.0,
                f.charge_dc_w * b.charge_efficiency,
            );
        }
    }
    #[test]
    fn simultaneous_quarter_flows_share_inventory_room_outside_soc_bounds() {
        let b = model();
        for initial in [0.0, 0.5, 19.9, 20.5] {
            let f = b.project_dc(initial, 0.25, 5000.0, 5000.0, 0.0, 1000.0);
            assert!(f.charge_dc_w <= 5000.0 && f.discharge_dc_w <= 5000.0);
            assert!(f.stored_end_kwh >= initial.min(b.min_soc * b.capacity_kwh) - 1e-9);
            assert!(f.stored_end_kwh <= initial.max(b.max_soc * b.capacity_kwh) + 1e-9);
            near(
                f.stored_end_kwh,
                initial + (f.charge_dc_w * 0.98 - f.discharge_dc_w / 0.97) / 4000.0,
            );
        }
        let low = b.project_dc(0.0, 0.25, 5000.0, 5000.0, 0.0, 1000.0);
        near(low.charge_dc_w, 5000.0);
        near(low.discharge_dc_w, 5000.0 * 0.98 * 0.97);
        near(low.stored_end_kwh, 0.0);
    }
    #[test]
    fn grid_room_inverse_includes_idle_and_source_activation() {
        let b = model();
        for (pv, house) in [(0.0, 1000.0), (1050.0, 1000.0), (2000.0, 1000.0)] {
            for room in [0.0, 50.0, 150.0, 250.0, 1000.0, 1050.0, 1200.0, 3000.0] {
                let ac = b.charge_grid_room_w(room, pv, house);
                let f = b.project_ac(10.0, 0.25, ac, 0.0, pv, house);
                assert!(f.charge_ac_w + f.idle_ac_w <= room.max(b.conversion.idle_loss_w) + 1e-8);
            }
        }
    }
}
