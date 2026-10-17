//! A soft scheduling preference, independent of cash and equipment wear.
use crate::{Command, Limits, Operation};

#[derive(Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Activity {
    pub ev: bool,
    pub battery_grid: bool,
}
impl Activity {
    pub fn observed(command: &Command, ev_w: f64, charge_w: f64) -> Self {
        Self {
            ev: ev_w > 0.0,
            battery_grid: command.battery == Operation::GridCharge && charge_w > 0.0,
        }
    }
    pub fn cost_from(self, previous: Self, limits: &Limits) -> f64 {
        (if self.ev && !previous.ev {
            limits.ev_start_preference_sek
        } else {
            0.0
        }) + battery_start_cost(previous.battery_grid, self.battery_grid, limits)
    }
}
pub(crate) fn battery_start_cost(previous: bool, next: bool, limits: &Limits) -> f64 {
    if next && !previous {
        limits.battery_start_preference_sek
    } else {
        0.0
    }
}
