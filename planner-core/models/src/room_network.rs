//! Simultaneous receiving-room dynamics. No controls, comfort or fitting policy.
use crate::room::Transition;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Default)]
pub struct NetworkKernels {
    stiff: HashMap<Vec<u64>, Vec<f64>>,
}

#[derive(Clone, Deserialize)]
pub struct Edge {
    pub node: usize,
    /// Predictive mean rates, by slot and native actuator step.
    pub rates: Vec<Vec<f64>>,
}
impl Edge {
    pub fn rate(&self, slot: usize, step: usize) -> f64 {
        if self.rates.len() == 1 && self.rates[0].len() == 1 {
            self.rates[0][0]
        } else {
            self.rates[slot][step]
        }
    }
}

#[derive(Clone, Deserialize)]
pub struct LegacyStep {
    pub step: Transition,
    pub memory_scale: Option<f64>,
}

#[derive(Clone, Deserialize)]
pub struct Node {
    pub key: String,
    pub start_c: f64,
    pub start_stored_heat_c: f64,
    pub outdoor_per_h: f64,
    pub gain_c_per_wh: Vec<f64>,
    pub lag_h: f64,
    pub forcing_c_per_h: Vec<f64>,
    pub incoming: Vec<Edge>,
    /// Existing disconnected thermal owner, with its exact already-compiled steps.
    #[serde(default)]
    pub legacy_steps: Option<Vec<LegacyStep>>,
}

/// One physical interval in the captured room forcing/rate series.
#[derive(Clone, Copy)]
pub struct NetworkInterval {
    pub slot: usize,
    pub step: usize,
    pub hours: f64,
}
struct ThermalCoefficients<'a> {
    losses: &'a [f64],
    lags: &'a [f64],
}

/// Exponential action by uniformization of the positive thermal generator.
/// All receiving temperatures use the same vector. Heater storage remains a
/// separate state, so changes in room exchange do not rescale stored heat.
pub fn advance(
    nodes: &[Node],
    slot: usize,
    step: usize,
    hours: f64,
    temperatures: &mut [f64],
    heat: &mut [f64],
    watts: &[f64],
) {
    advance_cached(
        nodes,
        NetworkInterval { slot, step, hours },
        temperatures,
        heat,
        watts,
        &mut NetworkKernels::default(),
    );
}

/// Select an exact representation with a well-conditioned Neumann inverse.
/// This changes neither the fitted lag nor the known stored heat. The interval
/// condition also bounds the signed power-dependent shift and avoids subtracting
/// enormous nearly equal states for a slow heater in an integrating room.
pub fn use_fast_memory_transform(lag: f64, hours: f64, thermal_norm: f64) -> bool {
    hours > 0. && lag > 0. && lag / hours <= 0.5 && lag * thermal_norm <= 0.5
}

/// The return value corrects only the fast-memory contribution to the caller's
/// existing endpoint trapezoid. Ordinary temperature integration is unchanged.
pub fn advance_cached(
    nodes: &[Node],
    interval: NetworkInterval,
    temperatures: &mut [f64],
    heat: &mut [f64],
    watts: &[f64],
    kernels: &mut NetworkKernels,
) -> Vec<f64> {
    let NetworkInterval { slot, step, hours } = interval;
    let n = nodes.len();
    let mut lags: Vec<_> = nodes.iter().map(|n| n.lag_h).collect();
    let losses: Vec<f64> = nodes
        .iter()
        .map(|node| {
            node.outdoor_per_h
                + node
                    .incoming
                    .iter()
                    .map(|e| e.rate(slot, step))
                    .sum::<f64>()
        })
        .collect();
    let norm = nodes
        .iter()
        .enumerate()
        .map(|(i, node)| {
            losses[i]
                + node
                    .incoming
                    .iter()
                    .map(|e| e.rate(slot, step))
                    .sum::<f64>()
        })
        .fold(0., f64::max);
    let mut shift = vec![0.; n];
    let mut endpoint = vec![0.; n];
    let mut integral = vec![0.; n];
    let mut restored = Vec::new();
    if hours > 0. {
        for i in 0..n {
            let lag = lags[i];
            if !use_fast_memory_transform(lag, hours, norm) || nodes[i].legacy_steps.is_some() {
                continue;
            }
            let power = nodes[i].gain_c_per_wh[slot] * watts[i];
            let rho = lag * norm;
            let mut term = vec![0.; n];
            term[i] = heat[i] - lag * power;
            let mut v = term.clone();
            if rho > 0. {
                loop {
                    let mut next = vec![0.; n];
                    for j in 0..n {
                        next[j] = lag
                            * (losses[j] * term[j]
                                - nodes[j]
                                    .incoming
                                    .iter()
                                    .map(|e| e.rate(slot, step) * term[e.node])
                                    .sum::<f64>());
                        v[j] += next[j];
                    }
                    let remaining =
                        rho / (1. - rho) * next.iter().map(|x| x.abs()).fold(0., f64::max);
                    let scale = v.iter().map(|x| x.abs()).fold(0., f64::max);
                    term = next;
                    if remaining <= 32. * f64::EPSILON * scale {
                        break;
                    }
                }
            }
            let decay = (-hours / lag).exp();
            let released = -lag * (-hours / lag).exp_m1();
            for j in 0..n {
                shift[j] += v[j];
                endpoint[j] += decay * v[j];
                integral[j] += released * v[j];
            }
            restored.push((i, decay * heat[i] + released * power));
            heat[i] = 0.;
            lags[i] = 0.;
        }
    }
    for i in 0..n {
        temperatures[i] += shift[i];
    }
    advance_core(nodes, &lags, interval, temperatures, heat, watts, kernels);
    for i in 0..n {
        temperatures[i] -= endpoint[i];
    }
    for &(i, q) in &restored {
        heat[i] = q;
    }
    if restored.is_empty() {
        return vec![];
    }
    if shift.iter().all(|v| *v == 0.) {
        return (0..n)
            .map(|i| -integral[i] + 0.5 * hours * endpoint[i])
            .collect();
    }
    let (end, mean) = thermal_moments(nodes, &losses, slot, step, hours, &shift, kernels);
    (0..n)
        .map(|i| mean[i] - integral[i] - 0.5 * hours * (end[i] - endpoint[i]))
        .collect()
}
fn thermal_moments(
    nodes: &[Node],
    losses: &[f64],
    slot: usize,
    step: usize,
    hours: f64,
    value: &[f64],
    kernels: &mut NetworkKernels,
) -> (Vec<f64>, Vec<f64>) {
    let n = nodes.len();
    let lambda = losses.iter().copied().fold(0., f64::max);
    let x = lambda * hours;
    if lambda == 0. {
        return (value.to_vec(), value.iter().map(|v| v * hours).collect());
    }
    if x > 16. {
        let size = 2 * n;
        let mut key = vec![u64::MAX - 1, hours.to_bits()];
        for (i, node) in nodes.iter().enumerate() {
            key.push(losses[i].to_bits());
            for e in &node.incoming {
                key.push(e.node as u64);
                key.push(e.rate(slot, step).to_bits());
            }
            key.push(u64::MAX);
        }
        let op = kernels.stiff.entry(key).or_insert_with(|| {
            let mut a = vec![0.; size * size];
            for (i, node) in nodes.iter().enumerate() {
                a[i * size + i] = -losses[i];
                for e in &node.incoming {
                    a[i * size + e.node] += e.rate(slot, step);
                }
                a[i * size + n + i] = 1.;
            }
            matrix_exponential(a, size, hours)
        });
        return (
            (0..n)
                .map(|i| (0..n).map(|j| op[i * size + j] * value[j]).sum())
                .collect(),
            (0..n)
                .map(|i| (0..n).map(|j| op[i * size + n + j] * value[j]).sum())
                .collect(),
        );
    }
    let mut weights = vec![(-x).exp()];
    let mut k = 0;
    loop {
        k += 1;
        weights.push(weights[k - 1] * x / k as f64);
        if k as f64 > x && weights[k] * x / (k as f64 + 1. - x) < 2e-16 {
            break;
        }
    }
    let mut tail = vec![0.; weights.len()];
    let mut sum = 0.;
    for k in (0..weights.len()).rev() {
        tail[k] = sum / lambda;
        sum += weights[k];
    }
    let mut term = value.to_vec();
    let mut end = vec![0.; n];
    let mut mean = vec![0.; n];
    for k in 0..weights.len() {
        for i in 0..n {
            end[i] += weights[k] * term[i];
            mean[i] += tail[k] * term[i];
        }
        term = nodes
            .iter()
            .enumerate()
            .map(|(i, node)| {
                (1. - losses[i] / lambda) * term[i]
                    + node
                        .incoming
                        .iter()
                        .map(|e| e.rate(slot, step) * term[e.node])
                        .sum::<f64>()
                        / lambda
            })
            .collect();
    }
    (end, mean)
}
fn advance_core(
    nodes: &[Node],
    lags: &[f64],
    interval: NetworkInterval,
    temperatures: &mut [f64],
    heat: &mut [f64],
    watts: &[f64],
    kernels: &mut NetworkKernels,
) {
    let NetworkInterval { slot, step, hours } = interval;
    if hours == 0. {
        return;
    }
    let legacy: Vec<_> = nodes
        .iter()
        .enumerate()
        .filter_map(|(i, node)| {
            node.legacy_steps
                .as_ref()
                .map(|_| (i, temperatures[i], heat[i]))
        })
        .collect();
    let n = nodes.len();
    let losses: Vec<f64> = nodes
        .iter()
        .map(|node| {
            node.outdoor_per_h
                + node
                    .incoming
                    .iter()
                    .map(|edge| edge.rate(slot, step))
                    .sum::<f64>()
        })
        .collect();
    let lambda = nodes
        .iter()
        .enumerate()
        .map(|(i, _node)| losses[i].max(if lags[i] > 0. { 1. / lags[i] } else { 0. }))
        .fold(0., f64::max);
    // A zero-lag row has no memory coordinate; any received storage is released
    // at the initial instant, matching the scalar thermal owner.
    for (i, node) in nodes.iter().enumerate() {
        if lags[i] == 0. && node.legacy_steps.is_none() {
            temperatures[i] += heat[i];
            heat[i] = 0.;
        }
    }
    if lambda == 0. {
        for (i, node) in nodes.iter().enumerate() {
            temperatures[i] +=
                hours * (node.forcing_c_per_h[slot] + node.gain_c_per_wh[slot] * watts[i]);
        }
        apply_legacy(nodes, slot, step, &legacy, temperatures, heat, watts);
        return;
    }
    if lambda * hours > 16. {
        exponential(
            nodes,
            interval,
            temperatures,
            heat,
            watts,
            ThermalCoefficients {
                losses: &losses,
                lags,
            },
            kernels,
        );
        apply_legacy(nodes, slot, step, &legacy, temperatures, heat, watts);
        return;
    }
    let pieces = 1;
    let x = lambda * hours;
    let mut term = vec![0.; 2 * n];
    let mut next = term.clone();
    let mut sum = term.clone();
    for _ in 0..pieces {
        term[..n].copy_from_slice(temperatures);
        term[n..].copy_from_slice(heat);
        let mut weight = (-x).exp();
        for (s, t) in sum.iter_mut().zip(&term) {
            *s = weight * t;
        }
        let mut order = 0;
        loop {
            order += 1;
            for (i, node) in nodes.iter().enumerate() {
                let delivered = node.gain_c_per_wh[slot] * watts[i];
                let release = if lags[i] > 0. {
                    term[n + i] / lags[i]
                } else {
                    delivered
                };
                let peers = node
                    .incoming
                    .iter()
                    .map(|e| e.rate(slot, step) * term[e.node])
                    .sum::<f64>();
                next[i] = (1. - losses[i] / lambda) * term[i]
                    + (peers + release + node.forcing_c_per_h[slot]) / lambda;
                next[n + i] = if lags[i] > 0. {
                    (1. - 1. / lags[i] / lambda) * term[n + i] + delivered / lambda
                } else {
                    0.
                };
            }
            std::mem::swap(&mut term, &mut next);
            weight *= x / order as f64;

            for (s, t) in sum.iter_mut().zip(&term) {
                let addition = weight * t;
                *s += addition;
            }
            // The remaining Poisson tail, independent of cancellation in any
            // signed thermal coordinate, bounds all omitted matrix terms.
            if order as f64 > x && weight * x / (order as f64 + 1. - x) < 2e-16 {
                break;
            }
        }
        temperatures.copy_from_slice(&sum[..n]);
        heat.copy_from_slice(&sum[n..]);
    }
    apply_legacy(nodes, slot, step, &legacy, temperatures, heat, watts);
}
fn apply_legacy(
    nodes: &[Node],
    slot: usize,
    minute: usize,
    previous: &[(usize, f64, f64)],
    temperatures: &mut [f64],
    heat: &mut [f64],
    watts: &[f64],
) {
    for &(i, t, q) in previous {
        let legacy = &nodes[i].legacy_steps.as_ref().unwrap()[slot];
        let q = q * if minute == 0 {
            legacy.memory_scale.unwrap_or(1.)
        } else {
            1.
        };
        let step = &legacy.step;
        temperatures[i] = step.decay * t
            + step.offset_c
            + step.stored_heat_release * q
            + step.gain_c_per_w * watts[i];
        heat[i] = step.carry * q + step.stored_heat_gain_c_per_w * watts[i];
    }
}

fn multiply(a: &[f64], b: &[f64], n: usize) -> Vec<f64> {
    let mut c = vec![0.; n * n];
    for i in 0..n {
        for k in 0..n {
            let value = a[i * n + k];
            if value != 0. {
                for j in 0..n {
                    c[i * n + j] += value * b[k * n + j];
                }
            }
        }
    }
    c
}
/// Scaling and squaring bounds work logarithmically for stiff, valid models.
fn matrix_exponential(mut a: Vec<f64>, n: usize, hours: f64) -> Vec<f64> {
    let norm = a
        .chunks(n)
        .map(|row| row.iter().map(|v| v.abs()).sum::<f64>())
        .fold(0., f64::max)
        * hours;
    let squares = if norm > 0.5 {
        (norm / 0.5).log2().ceil() as u32
    } else {
        0
    };
    let scale = hours * 2_f64.powi(-(squares as i32));
    for value in &mut a {
        *value *= scale;
    }
    let mut result = vec![0.; n * n];
    for i in 0..n {
        result[i * n + i] = 1.;
    }
    let mut term = result.clone();
    for order in 1..=24 {
        term = multiply(&term, &a, n);
        for value in &mut term {
            *value /= order as f64;
        }
        for (r, t) in result.iter_mut().zip(&term) {
            *r += t;
        }
    }
    for _ in 0..squares {
        result = multiply(&result, &result, n);
    }
    result
}
fn exponential(
    nodes: &[Node],
    interval: NetworkInterval,
    temperatures: &mut [f64],
    heat: &mut [f64],
    watts: &[f64],
    coefficients: ThermalCoefficients<'_>,
    kernels: &mut NetworkKernels,
) {
    let NetworkInterval { slot, step, hours } = interval;
    let ThermalCoefficients { losses, lags } = coefficients;
    let count = nodes.len();
    // Zero-lag heaters have no stored state. Omitting those coordinates keeps
    // stiff observed-only and instantaneous networks small without changing physics.
    let mut states = count;
    let storage: Vec<Option<usize>> = nodes
        .iter()
        .enumerate()
        .map(|(i, _node)| {
            if lags[i] > 0. {
                let index = states;
                states += 1;
                Some(index)
            } else {
                None
            }
        })
        .collect();
    let n = 2 * states;
    // Thermal coefficients define the operator. Weather and electrical input
    // enter the independent constant forcing coordinates, so identical physics
    // can share one exponential across all command replays.
    let mut key = vec![hours.to_bits(), count as u64];
    for (i, node) in nodes.iter().enumerate() {
        key.push(losses[i].to_bits());
        key.push(lags[i].to_bits());
        for edge in &node.incoming {
            key.push(edge.node as u64);
            key.push(edge.rate(slot, step).to_bits());
        }
        key.push(u64::MAX);
    }
    if !kernels.stiff.contains_key(&key)
        && kernels.stiff.len() * (n * n + key.len()) * 8 > 4 * 1024 * 1024
    {
        kernels.stiff.clear();
    }
    let operator = kernels.stiff.entry(key).or_insert_with(|| {
        let mut a = vec![0.; n * n];
        for (i, node) in nodes.iter().enumerate() {
            a[i * n + i] = -losses[i];
            for edge in &node.incoming {
                a[i * n + edge.node] += edge.rate(slot, step);
            }
            if let Some(q) = storage[i] {
                a[i * n + q] = 1. / lags[i];
                a[q * n + q] = -1. / lags[i];
            }
        }
        for i in 0..states {
            a[i * n + states + i] = 1.;
        }
        matrix_exponential(a, n, hours)
    });
    let mut state = temperatures.to_vec();
    state.resize(n, 0.);
    for (i, q) in storage.iter().enumerate() {
        if let Some(q) = q {
            state[*q] = heat[i];
        }
    }
    for (i, node) in nodes.iter().enumerate() {
        state[states + i] = node.forcing_c_per_h[slot];
        let delivered = node.gain_c_per_wh[slot] * watts[i];
        if let Some(q) = storage[i] {
            state[states + q] = delivered;
        } else {
            state[states + i] += delivered;
        }
    }
    let out: Vec<f64> = operator
        .chunks(n)
        .take(states)
        .map(|row| row.iter().zip(&state).map(|(a, b)| a * b).sum())
        .collect();
    temperatures.copy_from_slice(&out[..count]);
    for (i, q) in storage.iter().enumerate() {
        heat[i] = q.map_or(0., |q| out[q]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn node(key: &str, temperature: f64, peer: usize) -> Node {
        Node {
            key: key.into(),
            start_c: temperature,
            start_stored_heat_c: 0.,
            outdoor_per_h: 0.,
            gain_c_per_wh: vec![0.],
            lag_h: 0.,
            forcing_c_per_h: vec![0.],
            legacy_steps: None,
            incoming: vec![Edge {
                node: peer,
                rates: vec![vec![2.]],
            }],
        }
    }
    #[test]
    fn simultaneous_exchange_matches_independent_closed_solution() {
        let nodes = vec![
            node("synthetic-cold", 10., 1),
            node("synthetic-warm", 30., 0),
        ];
        let mut t = vec![10., 30.];
        let mut q = vec![0., 0.];
        advance(&nodes, 0, 0, 2., &mut t, &mut q, &[0., 0.]);
        assert!((t[0] - (20. - 10. * (-8_f64).exp())).abs() < 1e-11);
        assert!((t[0] + t[1] - 40.).abs() < 1e-11);
    }
    #[test]
    fn delayed_injection_conserves_unreleased_heat() {
        for lag in [2., 0.000001] {
            let mut n = node("synthetic-slab", 20., 0);
            n.incoming.clear();
            n.lag_h = lag;
            n.gain_c_per_wh[0] = 0.001;
            let mut t = vec![20.];
            let mut q = vec![0.];
            advance(&[n], 0, 0, 1., &mut t, &mut q, &[1000.]);
            assert!((q[0] - lag * -(-1. / lag).exp_m1()).abs() < 1e-9);
            assert!((t[0] + q[0] - 21.).abs() < 1e-9);
        }
    }
    #[test]
    fn negative_forcing_and_stiff_decay_match_analytic_solution() {
        for loss in [0., 0.2, 1000000.] {
            let mut n = node("synthetic-signed", 2., 0);
            n.incoming.clear();
            n.outdoor_per_h = loss;
            n.forcing_c_per_h[0] = -5.;
            let mut t = vec![2.];
            let mut q = vec![0.];
            advance(&[n], 0, 0, 0.25, &mut t, &mut q, &[0.]);
            let expected = if loss == 0. {
                0.75
            } else {
                2. * (-loss * 0.25).exp() - 5. * -(-loss * 0.25).exp_m1() / loss
            };
            assert!(
                (t[0] - expected).abs() < 1e-9,
                "loss={loss}: {} vs {expected}",
                t[0]
            );
        }
    }
}

#[cfg(test)]
mod fast_memory_tests {
    use super::*;
    fn pair(rates: [f64; 2], losses: [f64; 2], lags: [f64; 2], forcing: [f64; 2]) -> Vec<Node> {
        (0..2)
            .map(|i| Node {
                key: i.to_string(),
                start_c: 0.,
                start_stored_heat_c: 0.,
                outdoor_per_h: losses[i],
                gain_c_per_wh: vec![1.],
                lag_h: lags[i],
                forcing_c_per_h: vec![forcing[i]],
                legacy_steps: None,
                incoming: vec![Edge {
                    node: 1 - i,
                    rates: vec![vec![rates[i]]],
                }],
            })
            .collect()
    }
    fn run(
        nodes: &[Node],
        start: [f64; 2],
        initial: [f64; 2],
        power: [f64; 2],
        hours: f64,
    ) -> ([f64; 2], [f64; 2], [f64; 2]) {
        let mut t = start;
        let mut q = initial;
        let correction = advance_cached(
            nodes,
            NetworkInterval {
                slot: 0,
                step: 0,
                hours,
            },
            &mut t,
            &mut q,
            &power,
            &mut NetworkKernels::default(),
        );
        let mean = std::array::from_fn(|i| {
            0.5 * (start[i] + t[i]) + correction.get(i).copied().unwrap_or(0.) / hours
        });
        (t, q, mean)
    }
    fn near(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "{actual} != {expected}"
        );
    }
    #[test]
    fn exact_known_fast_heat_and_mean_survive_even_subnormal_lag() {
        // Independent binary stress grid, spanning normal and subnormal scales.
        for lag in [
            2f64.powi(-40),
            2f64.powi(-48),
            2f64.powi(-60),
            f64::from_bits(1 << 14),
        ] {
            assert!(lag > 0.);
            let nodes = pair([0., 0.], [0.2, 0.1], [lag, 0.], [0., 0.]);
            let (t, q, mean) = run(&nodes, [20., 18.], [2., 0.], [0., 0.], 0.25);
            let (base, _, base_mean) = run(&nodes, [20., 18.], [0., 0.], [0., 0.], 0.25);
            let v = 2. / (1. - 0.2 * lag);
            let decay = (-0.05f64).exp();
            near(t[0], decay * (20. + v), 1e-12);
            near(q[0], 0., 0.);
            near(t[0] - base[0], decay * v, 1e-12);
            near(
                mean[0] - base_mean[0],
                v * ((-(-0.05f64).exp_m1()) / 0.05 - lag / 0.25),
                1e-12,
            );
            near(t[1], base[1], 0.);
            near(mean[1], base_mean[1], 0.);
        }
    }
    #[test]
    fn signed_power_shift_matches_independent_high_precision_network() {
        // Independently generated 80-digit augmented-exponential reference.
        let nodes = pair([0.1, 0.05], [0.2, 0.15], [0.005, 0.5], [1., 0.8]);
        let (t, q, mean) = run(&nodes, [19., 20.], [0.002, 0.2], [3., 0.6], 1. / 60.);
        let (_, _, base_mean) = run(&nodes, [19., 20.], [0.015, 0.2], [3., 0.6], 1. / 60.);
        for i in 0..2 {
            near(t[i], [18.992471788640916, 19.969267277734676][i], 1e-12);
            near(q[i], [0.01453623808648572, 0.20327838995179942][i], 1e-13);
            near(
                mean[i] - base_mean[i],
                [-0.009220514894861273, -3.0996156833413477e-6][i],
                1e-12,
            );
        }
    }
    #[test]
    fn stiff_directional_exchange_retains_fast_and_slow_memory() {
        // The thermal generator remains stiff after the fast memory is removed;
        // this exercises the shared scaled exponential and its integral block.
        let nodes = pair([1000., 700.], [0.1, 0.2], [1e-10, 0.5], [0.1, 0.2]);
        let (t, q, mean) = run(&nodes, [19., 25.], [0.2, 0.3], [0.4, 0.6], 0.25);
        let (_, _, base_mean) = run(&nodes, [19., 25.], [4e-11, 0.3], [0.4, 0.6], 0.25);
        for i in 0..2 {
            near(t[i], [21.89792075440094, 21.89680914584917][i], 1e-10);
            near(q[i], [4e-11, 0.3][i], 1e-12);
            near(
                mean[i] - base_mean[i],
                [0.0810218010352678, 0.08054651368304483][i],
                1e-11,
            );
        }
    }
    #[test]
    fn representation_selector_bounds_inverse_and_power_shift_without_changing_lag() {
        assert!(use_fast_memory_transform(0.5, 1., 1.));
        assert!(!use_fast_memory_transform(0.5, 0.25, 2.)); // resonant slow coordinate
        assert!(!use_fast_memory_transform(1e12, 1. / 60., 0.)); // integrating room, huge L*b
        let nodes = pair([0., 0.], [0., 0.], [1e12, 0.], [0., 0.]);
        let (t, q, _) = run(&nodes, [20., 18.], [0.01, 0.], [0.7, 0.], 1. / 60.);
        near(t[0], 20., 1e-12);
        near(q[0], 0.01 + 0.7 / 60., 1e-12);
    }
}
