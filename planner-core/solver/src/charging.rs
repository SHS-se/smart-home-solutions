//! Requested charging intent changes, independent of cash and equipment wear.
use crate::{Command, Limits, Operation, Problem};

#[derive(Clone, Copy, Default, PartialEq, PartialOrd)]
pub(crate) struct Settings {
    pub ev: Option<u32>,
    pub battery_grid: Option<f64>,
}
impl Settings {
    pub fn initial(p: &Problem) -> Self {
        Self {
            ev: p.charging_before.ev_amps,
            battery_grid: p.charging_before.battery_grid_w,
        }
    }
    pub fn commanded(command: &Command) -> Self {
        Self {
            ev: Some(command.ev_amps),
            battery_grid: Some(if command.battery == Operation::GridCharge {
                command.charge_limit_w
            } else {
                0.0
            }),
        }
    }
    pub fn grid_active(self) -> bool {
        self.battery_grid.is_some_and(|w| w > 0.0)
    }
    pub fn cost_from(self, previous: Self, limits: &Limits) -> f64 {
        (if previous.ev.is_some() && self.ev != previous.ev {
            limits.ev_change_preference_sek
        } else {
            0.0
        }) + if previous.battery_grid.is_some() && self.battery_grid != previous.battery_grid {
            limits.battery_change_preference_sek
        } else {
            0.0
        }
    }
}
/// Relaxed two-channel battery guide. Exact scoring also counts positive-limit changes.
pub(crate) fn battery_activity_cost(p: &Problem, i: usize, previous: bool, next: bool) -> f64 {
    if i == 0 && p.charging_before.battery_grid_w.is_none() {
        return 0.0;
    }
    if previous != next {
        p.limits.battery_change_preference_sek
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_and_off_gap_have_identical_transition_cost() {
        let mut p = crate::witnesses::tests::problem(4);
        p.limits.battery_change_preference_sek = 0.125;
        let settings = |w| Settings {
            ev: Some(0),
            battery_grid: Some(w),
        };
        for bridge in [0.0, 125.0, 126.0, 1000.0] {
            let cost = settings(bridge).cost_from(settings(2500.0), &p.limits)
                + settings(2500.0).cost_from(settings(bridge), &p.limits);
            assert_eq!(cost, 0.25);
        }
        assert_eq!(settings(2500.0).cost_from(settings(2500.0), &p.limits), 0.0);
        assert_eq!(
            settings(2500.0).cost_from(Settings::default(), &p.limits),
            0.0
        );
    }
}
