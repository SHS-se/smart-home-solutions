//! Room thermal/actuator projection only; tariffs, comfort and search live in solver.
use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
pub struct Transition {
    pub decay: f64,
    pub offset_c: f64,
    pub stored_heat_release: f64,
    pub gain_c_per_w: f64,
    pub stored_heat_gain_c_per_w: f64,
    pub carry: f64,
}
#[derive(Clone, Deserialize)]
pub struct Thermostat {
    pub minimum_c: f64,
    pub maximum_c: f64,
    pub step_c: f64,
    pub power_w: f64,
    #[serde(default)]
    pub reservation_w: Option<f64>,
    pub sensor_offset_c: f64,
    pub hvac_action: String,
    #[serde(default)]
    pub relay: bool,
}
#[derive(Clone, Copy, Deserialize)]
pub struct Interval {
    pub hours: f64,
    pub steps: usize,
    /// Convert delayed response coordinates once at an interval boundary.
    #[serde(default)]
    pub memory_scale: Option<f64>,
    pub step: Transition,
    pub relay_budget_w: Option<f64>,
}
#[derive(Clone, Copy)]
pub struct State {
    pub temperature: f64,
    pub stored_heat: f64,
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
                stored_heat: 0.,
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
        + s.stored_heat_release * state.stored_heat
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
    if q.steps > 0 {
        if let Some(scale) = q.memory_scale {
            out.state.stored_heat *= scale;
        }
    }
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
        let mut reserved = relay;
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
                    if reserved + t.reservation_w.unwrap_or(t.power_w).max(t.power_w)
                        > q.relay_budget_w.unwrap() + 1e-6
                    {
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
                reserved += t.reservation_w.unwrap_or(t.power_w).max(t.power_w);
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
                    let bound = t.reservation_w.unwrap_or(t.power_w).max(t.power_w);
                    if calls & (1 << j) != 0 && reserved + bound <= budget + 1e-6 {
                        mask |= 1 << j;
                        watts += t.power_w;
                        reserved += bound;
                        out.power[j] += t.power_w * hours;
                    }
                }
            }
        }
        out.peak = out.peak.max(reserved);
        out.state.temperature = temperature(q.step, out.state, watts);
        out.state.stored_heat =
            q.step.carry * out.state.stored_heat + q.step.stored_heat_gain_c_per_w * watts;
        out.state.mask = mask;
    }
    for w in &mut out.power {
        *w = if q.hours > 0. { *w / q.hours } else { 0. };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_coordinate_scale_applies_once_before_all_minutes() {
        let mut q = Interval {
            hours: 0.25,
            steps: 15,
            memory_scale: Some(0.5),
            step: Transition {
                decay: 1.,
                offset_c: 0.,
                stored_heat_release: 0.1,
                gain_c_per_w: 0.,
                stored_heat_gain_c_per_w: 0.,
                carry: 1.,
            },
            relay_budget_w: None,
        };
        let initial = State {
            temperature: 20.,
            stored_heat: 4.,
            mask: 0,
        };
        let mut out = Projection::new(0);
        project(&q, &[], initial, &[], 0., &mut out);
        assert_eq!(out.state.stored_heat, 2.);
        assert!((out.state.temperature - 23.).abs() < 1e-12);
        q.steps = 0;
        q.hours = 0.;
        project(&q, &[], initial, &[], 0., &mut out);
        assert_eq!(out.state.stored_heat, initial.stored_heat);
        assert_eq!(out.state.temperature, initial.temperature);
    }

    #[test]
    fn temperature_band_draw_does_not_reduce_the_running_reservation() {
        let thermostat = Thermostat {
            minimum_c: 5.,
            maximum_c: 35.,
            step_c: 1.,
            power_w: 500.,
            reservation_w: Some(800.),
            sensor_offset_c: 0.,
            hvac_action: "idle".into(),
            relay: false,
        };
        let interval = Interval {
            hours: 0.25,
            steps: 1,
            memory_scale: None,
            step: Transition {
                decay: 1.,
                offset_c: 0.,
                stored_heat_release: 0.,
                stored_heat_gain_c_per_w: 0.,
                gain_c_per_w: 0.001,
                carry: 0.,
            },
            relay_budget_w: None,
        };
        let mut out = Projection::new(1);
        project(
            &interval,
            &[thermostat],
            State {
                temperature: 19.,
                stored_heat: 0.,
                mask: 0,
            },
            &[21.],
            0.,
            &mut out,
        );
        assert_eq!(out.peak, 800.);
        assert_eq!(out.power, vec![500.]);
        assert_eq!(out.state.temperature, 19.5);
    }

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
                reservation_w: None,
                sensor_offset_c: 0.,
                hvac_action: "idle".into(),
                relay: false,
            },
            Thermostat {
                minimum_c: 5.,
                maximum_c: 35.,
                step_c: 0.5,
                power_w: 400.,
                reservation_w: None,
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
                                memory_scale: None,
                                relay_budget_w: None,
                                step: Transition {
                                    decay: 0.999,
                                    offset_c: -0.004,
                                    stored_heat_release: if carry > 0. { 0.00001 } else { 0. },
                                    stored_heat_gain_c_per_w: 1. - carry,
                                    gain_c_per_w: 0.000015,
                                    carry,
                                },
                            };
                            let initial = State {
                                temperature: start,
                                stored_heat: 300.,
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
                                        traced.state.stored_heat.to_bits(),
                                        independent.state.stored_heat.to_bits()
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
