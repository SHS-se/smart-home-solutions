//! Vehicle energy storage and native charger electrical capabilities.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CarBattery {
    pub capacity_kwh: f64,
    pub kwh_per_km: f64,
    pub charge_efficiency: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Charger {
    pub voltage_v: f64,
    pub phase_count: u32,
    pub min_current_a: u32,
    pub max_current_a: u32,
    pub current_step_a: u32,
}
impl Charger {
    pub fn watts(&self, amps: u32) -> Option<f64> {
        if amps != 0
            && (amps < self.min_current_a
                || amps > self.max_current_a
                || !(amps - self.min_current_a).is_multiple_of(self.current_step_a))
        {
            return None;
        }
        Some(f64::from(amps) * f64::from(self.phase_count) * self.voltage_v)
    }
    pub fn fitting_amps(&self, limit_w: f64) -> u32 {
        let raw = (limit_w / self.voltage_v / f64::from(self.phase_count)).floor();
        if raw < f64::from(self.min_current_a) {
            return 0;
        }
        let capped = raw.min(f64::from(self.max_current_a)) as u32;
        self.min_current_a
            + (capped - self.min_current_a) / self.current_step_a * self.current_step_a
    }
}
