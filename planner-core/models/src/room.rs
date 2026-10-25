//! Room thermal/actuator projection only; tariffs, comfort and search live in solver.
use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
pub struct Transition {
    pub decay: f64,
    pub offset_c: f64,
    pub delivered_gain_c_per_w: f64,
    pub gain_c_per_w: f64,
    pub carry: f64,
}
#[derive(Deserialize)]
pub struct Thermostat {
    pub minimum_c: f64,
    pub maximum_c: f64,
    pub step_c: f64,
    pub power_w: f64,
    pub sensor_offset_c: f64,
    pub hvac_action: String,
}
#[derive(Clone, Copy, Deserialize)]
pub struct Interval {
    pub hours: f64,
    pub steps: usize,
    pub step: Transition,
}
#[derive(Clone, Copy)]
pub struct State {
    pub temperature: f64,
    pub delivered: f64,
    pub mask: usize,
}
pub struct Projection {
    pub state: State,
    pub power: Vec<f64>,
    pub peak: f64,
}
impl Projection {
    pub fn new(count: usize) -> Self {
        Self {
            state: State {
                temperature: 0.,
                delivered: 0.,
                mask: 0,
            },
            power: vec![0.; count],
            peak: 0.,
        }
    }
}
pub fn temperature(s: Transition, state: State, watts: f64) -> f64 {
    s.decay * state.temperature
        + s.offset_c
        + s.delivered_gain_c_per_w * state.delivered
        + s.gain_c_per_w * watts
}
pub fn project(
    q: &Interval,
    thermostats: &[Thermostat],
    initial: State,
    targets: &[f64],
    relay: f64,
    out: &mut Projection,
) {
    // The fixed-size iterator lets Wasm unroll the common single-thermostat
    // inner loop; both cases compile from the same minute physics below.
    if let [single] = thermostats {
        project_kernel(q, [single], initial, targets, relay, out);
    } else {
        project_kernel(q, thermostats.iter(), initial, targets, relay, out);
    }
}
fn project_kernel<'a, I>(
    q: &Interval,
    thermostats: I,
    initial: State,
    targets: &[f64],
    relay: f64,
    out: &mut Projection,
) where
    I: IntoIterator<Item = &'a Thermostat> + Clone,
{
    out.state = initial;
    out.power.fill(0.);
    out.peak = relay;
    let hours = if q.steps > 0 {
        q.hours / q.steps as f64
    } else {
        0.
    };
    for _ in 0..q.steps {
        let mut mask = 0;
        let mut watts = relay;
        for (j, t) in thermostats.clone().into_iter().enumerate() {
            let own = out.state.temperature + t.sensor_offset_c;
            let on = if own >= targets[j] - 1e-9 {
                false
            } else if targets[j] - own >= 0.5 - 1e-9 {
                true
            } else {
                out.state.mask & (1 << j) != 0
            };
            if on {
                mask += 1 << j;
                watts += t.power_w;
                out.power[j] += t.power_w * hours;
            }
        }
        out.peak = out.peak.max(watts);
        out.state.temperature = temperature(q.step, out.state, watts);
        out.state.delivered = q.step.carry * out.state.delivered + (1. - q.step.carry) * watts;
        out.state.mask = mask;
    }
    for w in &mut out.power {
        *w = if q.hours > 0. { *w / q.hours } else { 0. };
    }
}
