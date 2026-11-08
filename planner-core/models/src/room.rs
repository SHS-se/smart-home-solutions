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
    #[serde(default)]
    pub relay: bool,
}
#[derive(Clone, Copy, Deserialize)]
pub struct Interval {
    pub hours: f64,
    pub steps: usize,
    pub step: Transition,
    pub relay_budget_w: Option<f64>,
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
    target_trace: Vec<TargetTrace>,
}
/// Extremal sensor readings for each (previous latch, resulting latch) pair.
/// The thermostat comparisons are monotone in the sensor reading, so these
/// four extrema prove the same complete minute trajectory for another target.
#[derive(Clone, Copy)]
struct TargetTrace {
    readings: [f64; 4],
    seen: u8,
}
impl TargetTrace {
    const EMPTY: Self = Self {
        readings: [
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ],
        seen: 0,
    };
    fn observe(&mut self, own: f64, previous: bool, on: bool) {
        let group = usize::from(previous) * 2 + usize::from(on);
        self.seen |= 1 << group;
        if own.is_nan() {
            self.seen |= 16;
        }
        self.readings[group] = if on {
            self.readings[group].max(own)
        } else {
            self.readings[group].min(own)
        };
    }
    fn accepts(&self, target: f64, relay: bool) -> bool {
        if self.seen & 16 != 0 || target.is_nan() {
            return false;
        }
        for group in 0..4 {
            if self.seen & (1 << group) == 0 {
                continue;
            }
            let own = self.readings[group];
            // Keep the original subtraction order and strict comparisons.
            let on = heating_on(own, target, group >= 2, relay);
            if on != (group % 2 == 1) {
                return false;
            }
        }
        true
    }
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
            target_trace: vec![TargetTrace::EMPTY; count],
        }
    }
    /// Only valid after project_traced and for unchanged initial state,
    /// interval, thermostats and relay power. The caller owns that scope.
    pub fn reproduces_targets(
        &self,
        targets: &[f64],
        thermostats: &[Thermostat],
        room_relays: bool,
    ) -> bool {
        if targets.len() != self.target_trace.len() {
            return false;
        }
        let mut traces = self.target_trace.iter().zip(targets);
        if room_relays {
            traces
                .zip(thermostats)
                .all(|((trace, target), thermostat)| trace.accepts(*target, thermostat.relay))
        } else {
            traces.all(|(trace, target)| trace.accepts(*target, false))
        }
    }
}
fn thermostat_on(own: f64, target: f64, previous: bool) -> bool {
    if own >= target - 1e-9 {
        false
    } else if target - own >= 0.5 - 1e-9 {
        true
    } else {
        previous
    }
}
fn heating_on(own: f64, target: f64, previous: bool, relay: bool) -> bool {
    if relay {
        own < target + if previous { 0.25 } else { 0. }
    } else {
        thermostat_on(own, target, previous)
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
    project_dispatch::<false>(q, thermostats, initial, targets, relay, out);
}
/// Project and retain an exact proof for target-only trajectory reuse.
pub fn project_traced(
    q: &Interval,
    thermostats: &[Thermostat],
    initial: State,
    targets: &[f64],
    relay: f64,
    out: &mut Projection,
) {
    out.target_trace.fill(TargetTrace::EMPTY);
    project_dispatch::<true>(q, thermostats, initial, targets, relay, out);
}
fn project_dispatch<const TRACE: bool>(
    q: &Interval,
    thermostats: &[Thermostat],
    initial: State,
    targets: &[f64],
    relay: f64,
    out: &mut Projection,
) {
    // The fixed-size iterator lets Wasm unroll the common single-thermostat
    // inner loop; both cases compile from the same minute physics below.
    match (thermostats, q.relay_budget_w.is_some()) {
        ([single], false) => {
            project_kernel::<_, TRACE, false, true>(q, [single], initial, targets, relay, out)
        }
        ([single], true) => {
            project_kernel::<_, TRACE, true, true>(q, [single], initial, targets, relay, out)
        }
        (_, false) => project_kernel::<_, TRACE, false, false>(
            q,
            thermostats.iter(),
            initial,
            targets,
            relay,
            out,
        ),
        (_, true) => project_kernel::<_, TRACE, true, false>(
            q,
            thermostats.iter(),
            initial,
            targets,
            relay,
            out,
        ),
    }
}
fn project_kernel<'a, I, const TRACE: bool, const ROOM_RELAYS: bool, const SINGLE: bool>(
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
        let mut relay_calls = 0;
        for (j, t) in thermostats.clone().into_iter().enumerate() {
            let own = out.state.temperature + t.sensor_offset_c;
            let previous = out.state.mask & (1 << j) != 0;
            let on = heating_on(own, targets[j], previous, ROOM_RELAYS && t.relay);
            if TRACE {
                out.target_trace[j].observe(own, previous, on);
            }
            if ROOM_RELAYS && t.relay && targets[j] != f64::MAX {
                if SINGLE {
                    if watts + t.power_w > q.relay_budget_w.unwrap() + 1e-6 {
                        continue;
                    }
                } else {
                    if on {
                        relay_calls |= 1 << j;
                    }
                    continue;
                }
            }
            if on {
                mask += 1 << j;
                watts += t.power_w;
                out.power[j] += t.power_w * hours;
            }
        }
        if ROOM_RELAYS && !SINGLE {
            let budget = q.relay_budget_w.unwrap();
            // Keep running room relays before admitting new calls. Native
            // thermostats and retained switch-on commands can draw on their own.
            for calls in [relay_calls & out.state.mask, relay_calls & !out.state.mask] {
                if calls == 0 {
                    continue;
                }
                for (j, t) in thermostats.clone().into_iter().enumerate() {
                    if calls & (1 << j) != 0 && watts + t.power_w <= budget + 1e-6 {
                        mask |= 1 << j;
                        watts += t.power_w;
                        out.power[j] += t.power_w * hours;
                    }
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn original_latch(own: f64, target: f64, previous: bool) -> bool {
        if own >= target - 1e-9 {
            false
        } else if target - own >= 0.5 - 1e-9 {
            true
        } else {
            previous
        }
    }

    #[test]
    fn target_trace_retains_exact_strict_and_half_degree_boundaries() {
        for own in [-5., 0., 19.5, 20., 20.5, 90.] {
            let centers = [own, own + 1e-9, own + 0.5 - 1e-9, own + 0.5];
            let targets: Vec<f64> = centers
                .into_iter()
                .flat_map(|v: f64| [v.next_down(), v, v.next_up()])
                .collect();
            for previous in [false, true] {
                for target in &targets {
                    let on = original_latch(own, *target, previous);
                    let mut trace = TargetTrace::EMPTY;
                    trace.observe(own, previous, on);
                    for candidate in &targets {
                        assert_eq!(
                            trace.accepts(*candidate, false),
                            original_latch(own, *candidate, previous) == on,
                            "own={own} previous={previous} target={target} candidate={candidate}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn target_trace_reuse_is_bit_exact_for_coupled_thermostats_and_delayed_heat() {
        let thermostats = [
            Thermostat {
                minimum_c: 5.,
                maximum_c: 35.,
                step_c: 0.5,
                power_w: 800.,
                sensor_offset_c: 0.,
                hvac_action: "idle".into(),
                relay: false,
            },
            Thermostat {
                minimum_c: 5.,
                maximum_c: 35.,
                step_c: 0.5,
                power_w: 400.,
                sensor_offset_c: 0.5,
                hvac_action: "idle".into(),
                relay: false,
            },
        ];
        let targets = [19.5, 20. - 1e-9, 20., 20. + 1e-9, 20.5 - 1e-9, 20.5, 21.];
        let actions: Vec<_> = targets
            .iter()
            .flat_map(|a| targets.iter().map(move |b| [*a, *b]))
            .collect();
        let mut reused = 0;
        for count in [1, 2] {
            for carry in [0., 0.98] {
                for relay in [0., 600.] {
                    for mask in 0..(1 << count) {
                        for start in [19.5, 20., 20.5] {
                            let q = Interval {
                                hours: 0.25,
                                steps: 15,
                                relay_budget_w: None,
                                step: Transition {
                                    decay: 0.999,
                                    offset_c: -0.004,
                                    delivered_gain_c_per_w: if carry > 0. { 0.00001 } else { 0. },
                                    gain_c_per_w: 0.000015,
                                    carry,
                                },
                            };
                            let initial = State {
                                temperature: start,
                                delivered: 300.,
                                mask,
                            };
                            for target in &actions {
                                let mut traced = Projection::new(count);
                                project_traced(
                                    &q,
                                    &thermostats[..count],
                                    initial,
                                    &target[..count],
                                    relay,
                                    &mut traced,
                                );
                                for candidate in &actions {
                                    if !traced.reproduces_targets(
                                        &candidate[..count],
                                        &thermostats,
                                        false,
                                    ) {
                                        continue;
                                    }
                                    reused += 1;
                                    let mut independent = Projection::new(count);
                                    project(
                                        &q,
                                        &thermostats[..count],
                                        initial,
                                        &candidate[..count],
                                        relay,
                                        &mut independent,
                                    );
                                    assert_eq!(
                                        traced.state.temperature.to_bits(),
                                        independent.state.temperature.to_bits()
                                    );
                                    assert_eq!(
                                        traced.state.delivered.to_bits(),
                                        independent.state.delivered.to_bits()
                                    );
                                    assert_eq!(traced.state.mask, independent.state.mask);
                                    assert_eq!(traced.peak.to_bits(), independent.peak.to_bits());
                                    assert_eq!(traced.power, independent.power);
                                }
                            }
                        }
                    }
                }
            }
        }
        assert!(reused > 10_000);
    }
}
