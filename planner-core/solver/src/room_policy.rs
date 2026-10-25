//! Existing room-first, comfort-first objective. Numerical priorities are unchanged.
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
