//! Stationary battery electrical transition.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Battery {
    pub capacity_kwh: f64,
    pub min_soc: f64,
    pub max_soc: f64,
    pub charge_max_w: f64,
    pub discharge_max_w: f64,
    pub charge_efficiency: f64,
    pub discharge_efficiency: f64,
}

impl Battery {
    pub fn available_charge_w(&self, kwh: f64, hours: f64) -> f64 {
        ((self.max_soc * self.capacity_kwh - kwh).max(0.0) * 1000.0
            / hours
            / self.charge_efficiency)
            .min(self.charge_max_w)
    }
    pub fn available_discharge_w(&self, kwh: f64, hours: f64) -> f64 {
        ((kwh - self.min_soc * self.capacity_kwh).max(0.0) * 1000.0 / hours
            * self.discharge_efficiency)
            .min(self.discharge_max_w)
    }
    pub fn step(&self, kwh: f64, charge: f64, discharge: f64, hours: f64) -> f64 {
        kwh + hours / 1000.0
            * (charge * self.charge_efficiency - discharge / self.discharge_efficiency)
    }
}
