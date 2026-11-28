//! Existing room-first, comfort-first objective. Numerical priorities are unchanged.
/// A price premium is justified by strictly lower comfort exposure, including
/// partial recovery. Preserve quarters the literal schedule already satisfies.
pub(crate) fn prefer_proposal(
    shortfall_difference: f64,
    cost_difference: f64,
    new_miss: bool,
) -> bool {
    !new_miss
        && shortfall_difference <= 1e-8
        && (cost_difference <= 1e-8 || shortfall_difference < -1e-8)
}

pub(crate) struct RoomObjective {
    pub hours: f64,
    pub surplus_w: f64,
    pub export_price: f64,
    pub import_price: f64,
    pub required: f64,
    pub maximum: f64,
}
impl RoomObjective {
    pub fn cost(&self, next: f64, watts: f64, future: f64) -> f64 {
        let Self {
            hours,
            surplus_w,
            export_price,
            import_price,
            required,
            maximum,
        } = *self;
        let covered = watts.min(surplus_w.max(0.));
        let energy = hours / 1000. * (export_price * covered + import_price * (watts - covered));

        energy + 10_000. * (required - next).max(0.) + 1_000. * (next - maximum).max(0.) + future
    }
}

#[cfg(test)]
mod tests {
    use super::prefer_proposal;

    #[test]
    fn savings_never_buy_a_new_cold_quarter() {
        for cost in [-0.1, 0., 0.1] {
            assert!(!prefer_proposal(-0.25, cost, true));
            assert!(prefer_proposal(-0.25, cost, false));
        }
        assert!(!prefer_proposal(0.25, -1., false));
        assert!(!prefer_proposal(0., 0.1, false));
    }
}
