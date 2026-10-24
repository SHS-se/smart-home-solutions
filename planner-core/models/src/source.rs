use super::*;
use std::cell::Cell;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct SourceModel {
    pub recovery_rate_per_h: f64,
    pub heat_loss_per_kwh: f64,
}
const N: usize = 7;
type Matrix = [f64; N * N];
fn identity() -> Matrix {
    std::array::from_fn(|i| if i % (N + 1) == 0 { 1.0 } else { 0.0 })
}
fn multiply(a: &Matrix, b: &Matrix) -> Matrix {
    let mut out = [0.0; N * N];
    for i in 0..N {
        for k in 0..N {
            for j in 0..N {
                out[i * N + j] += a[i * N + k] * b[k * N + j];
            }
        }
    }
    out
}
fn exponential(m: &Matrix, hours: f64) -> Matrix {
    let norm = m.iter().map(|v| v.abs()).fold(0.0, f64::max);
    let (mut scale, mut squares) = (hours, 0);
    while norm * scale > 0.125 {
        scale /= 2.0;
        squares += 1;
    }
    let a = m.map(|v| v * scale);
    let (mut result, mut term) = (identity(), identity());
    for n in 1..=16 {
        term = multiply(&term, &a).map(|v| v / f64::from(n));
        for i in 0..result.len() {
            result[i] += term[i];
        }
    }
    for _ in 0..squares {
        result = multiply(&result, &result);
    }
    result
}
pub fn source_decay(rate: f64, hours: f64) -> f64 {
    let (mut x, mut squares) = (rate * hours, 0);
    if x >= 40.0 {
        return 0.0;
    }
    while x > 0.125 {
        x /= 2.0;
        squares += 1;
    }
    let (mut term, mut sum) = (-x, -x);
    for n in 2..=16 {
        term *= -x / f64::from(n);
        sum += term;
    }
    let mut released = -sum;
    for _ in 0..squares {
        released *= 2.0 - released;
    }
    1.0 - released
}
#[derive(Clone, Copy)]
struct Weights {
    hours: u64,
    slope: u64,
    matrix: Matrix,
}
#[derive(Clone, Copy)]
struct Piece {
    water: f64,
    pending: f64,
    depletion: f64,
    heat: f64,
}
pub struct SourceKernel<'a> {
    heater: &'a Heater,
    store: &'a ThermalStore,
    source: SourceModel,
    cop: f64,
    weights: Option<Box<[Cell<Option<Weights>>]>>,
}
impl<'a> SourceKernel<'a> {
    const ENTRIES: usize = 512;
    pub const MAX_MEMO_BYTES: usize = Self::ENTRIES * std::mem::size_of::<Cell<Option<Weights>>>();
    pub fn new(heater: &'a Heater, store: &'a ThermalStore, cached: bool) -> Self {
        Self {
            heater,
            store,
            source: heater.source.unwrap(),
            cop: heater.heat_w / heater.compressor_w,
            weights: cached.then(|| vec![Cell::new(None); Self::ENTRIES].into_boxed_slice()),
        }
    }
    fn matrix(&self, hours: f64, slope: f64) -> Matrix {
        let key = hours.to_bits() ^ slope.to_bits().rotate_left(17);
        let index = (key ^ (key >> 32)) as usize & (Self::ENTRIES - 1);
        if let Some(cells) = &self.weights {
            if let Some(w) = cells[index].get() {
                if w.hours == hours.to_bits() && w.slope == slope.to_bits() {
                    return w.matrix;
                }
            }
        }
        let mut m = [0.0; N * N];
        let rate = self.source.recovery_rate_per_h;
        m[0] = -rate;
        m[3] = 1.0;
        m[N] = slope;
        m[N + 1] = -rate;
        m[N + 2] = 1.0;
        m[2 * N + 3] = 2.0 * slope;
        m[3 * N + 4] = slope;
        m[5 * N + 1] = -self.cop * self.source.heat_loss_per_kwh;
        m[5 * N + 3] = self.cop;
        m[5 * N + 5] = if self.store.response_time_constant_h > 0.0 {
            -1.0 / self.store.response_time_constant_h
        } else {
            0.0
        };
        m[6 * N + 1] = m[5 * N + 1];
        m[6 * N + 3] = self.cop;
        let matrix = exponential(&m, hours);
        if let Some(cells) = &self.weights {
            cells[index].set(Some(Weights {
                hours: hours.to_bits(),
                slope: slope.to_bits(),
                matrix,
            }));
        }
        matrix
    }
    fn piece(
        &self,
        water: f64,
        pending: f64,
        depletion: f64,
        power: f64,
        slope: f64,
        hours: f64,
        cooling: f64,
    ) -> Piece {
        let v = [
            depletion,
            power * depletion,
            power * power,
            power,
            1.0,
            pending,
            0.0,
        ];
        let m = self.matrix(hours, slope);
        let mut out = [0.0; N];
        for i in 0..N {
            for j in 0..N {
                out[i] += m[i * N + j] * v[j];
            }
        }
        let next = if self.store.response_time_constant_h > 0.0 {
            out[5]
        } else {
            0.0
        };
        Piece {
            water: water
                + (pending + out[6] - next) / self.store.capacity_kwh_per_c
                + cooling * hours,
            pending: next,
            depletion: out[0].max(0.0),
            heat: out[6],
        }
    }
    fn first_stop(
        &self,
        water: f64,
        pending: f64,
        depletion: f64,
        power: f64,
        slope: f64,
        hours: f64,
        cooling: f64,
        stop: f64,
    ) -> Option<f64> {
        if water >= stop {
            return Some(0.0);
        }
        let at = |t| self.piece(water, pending, depletion, power, slope, t, cooling);
        let full = at(hours);
        if water + (pending + full.heat) / self.store.capacity_kwh_per_c + cooling.max(0.0) * hours
            < stop
        {
            return None;
        }
        let rate = self.source.recovery_rate_per_h;
        let beta = self.source.heat_loss_per_kwh;
        let tau = self.store.response_time_constant_h;
        let derivative = |t, order| {
            let q = at(t);
            let p = power + slope * t;
            let d1 = p - rate * q.depletion;
            let heat = self.cop * p * (1.0 - beta * q.depletion);
            match order {
                1 => self.cop * (slope * (1.0 - beta * q.depletion) - beta * p * d1),
                2 => -self.cop * beta * (2.0 * slope * d1 + p * (slope - rate * d1)),
                3 => heat - if tau > 0.0 { q.pending / tau } else { 0.0 },
                _ => {
                    if tau > 0.0 {
                        q.pending / tau / self.store.capacity_kwh_per_c + cooling
                    } else {
                        heat / self.store.capacity_kwh_per_c + cooling
                    }
                }
            }
        };
        let roots = |f: &dyn Fn(f64) -> f64, boundaries: &[f64]| {
            let mut found = vec![0.0, hours];
            for pair in boundaries.windows(2) {
                let a = f(pair[0]);
                let b = f(pair[1]);
                if a == 0.0 {
                    found.push(pair[0]);
                }
                if a * b < 0.0 {
                    found.push(bisect_root(f, pair[0], pair[1]));
                }
                if b == 0.0 {
                    found.push(pair[1]);
                }
            }
            found.sort_by(f64::total_cmp);
            found.dedup_by(|a, b| *a == *b);
            found
        };
        let mut turning = vec![0.0, hours];
        if rate > 0.0 && slope != 0.0 {
            let t = (3.0 * slope - rate * power) / (rate * slope);
            if t > 0.0 && t < hours {
                turning.insert(1, t);
            }
        }
        let second = roots(&|t| derivative(t, 2), &turning);
        let first = roots(&|t| derivative(t, 1), &second);
        let pending_turning = if tau > 0.0 {
            roots(&|t| derivative(t, 3), &first)
        } else {
            first
        };
        let water_turning = roots(&|t| derivative(t, 4), &pending_turning);
        for pair in water_turning.windows(2) {
            if at(pair[0]).water >= stop {
                return Some(pair[0]);
            }
            if at(pair[1]).water >= stop {
                return Some(bisect_root(|t| at(t).water - stop, pair[0], pair[1]));
            }
        }
        None
    }
    pub fn transition(&self, state: HeaterState, on: bool, c: PoolConditions) -> PoolTransition {
        let tau = self.store.response_time_constant_h;
        let mut water = if tau == 0.0 {
            self.store.inventory_c(c.water_c, c.pending_heat_kwh)
        } else {
            c.water_c
        };
        let mut pending = if tau == 0.0 { 0.0 } else { c.pending_heat_kwh };
        let mut depletion = c.source_depletion_kwh;
        if !on || c.stop_c.is_some_and(|stop| water >= stop) {
            (water, pending) =
                self.store
                    .step_pool(water, pending, 0.0, 0.0, c.outdoor_c, c.seconds / 3600.0);
            return PoolTransition {
                electric_w: 0.0,
                compressor_w: 0.0,
                auxiliary_w: 0.0,
                heat_w: 0.0,
                water_c: water,
                pending_heat_kwh: pending,
                source_depletion_kwh: depletion
                    * source_decay(self.source.recovery_rate_per_h, c.seconds / 3600.0),
                next: self.heater.transition(state, false, c.seconds).next,
                start: None,
            };
        }
        let age = match state {
            HeaterState::Steady => f64::INFINITY,
            HeaterState::Running { seconds } => seconds,
            _ => 0.0,
        };
        let curve = match &self.heater.response {
            Response::Bergvarme { startup } => startup.as_slice(),
            _ => &[],
        };
        let mut knots = vec![0.0];
        knots.extend(
            curve
                .iter()
                .map(|p| p.elapsed_seconds - age)
                .filter(|t| *t > 0.0 && *t < c.seconds),
        );
        knots.push(c.seconds);
        let fraction = |elapsed| {
            if !age.is_finite() || curve.is_empty() {
                return 1.0;
            }
            for pair in curve.windows(2) {
                if age + elapsed <= pair[1].elapsed_seconds {
                    return pair[0].electric_fraction
                        + (pair[1].electric_fraction - pair[0].electric_fraction)
                            * (age + elapsed - pair[0].elapsed_seconds)
                            / (pair[1].elapsed_seconds - pair[0].elapsed_seconds);
                }
            }
            1.0
        };
        let cooling = self.store.idle_per_hour(water, c.outdoor_c);
        let mut active_seconds = c.seconds;
        let mut heat = 0.0;
        for pair in knots.windows(2) {
            let hours = (pair[1] - pair[0]) / 3600.0;
            let power = self.heater.compressor_w / 1000.0 * fraction(pair[0]);
            let slope =
                self.heater.compressor_w / 1000.0 * (fraction(pair[1]) - fraction(pair[0])) / hours;
            let crossing = c.stop_c.and_then(|stop| {
                self.first_stop(
                    water, pending, depletion, power, slope, hours, cooling, stop,
                )
            });
            let q = self.piece(
                water,
                pending,
                depletion,
                power,
                slope,
                crossing.unwrap_or(hours),
                cooling,
            );
            heat += q.heat;
            water = q.water;
            pending = q.pending;
            depletion = q.depletion;
            if let Some(at) = crossing {
                active_seconds = pair[0] + at * 3600.0;
                break;
            }
        }
        let active = self.heater.transition(state, true, active_seconds);
        let share = active_seconds / c.seconds;
        let mut next = active.next;
        if active_seconds < c.seconds {
            let hours = (c.seconds - active_seconds) / 3600.0;
            (water, pending) = self
                .store
                .step_pool(water, pending, 0.0, 0.0, c.outdoor_c, hours);
            depletion *= source_decay(self.source.recovery_rate_per_h, hours);
            next = self
                .heater
                .transition(next, false, c.seconds - active_seconds)
                .next;
        }
        PoolTransition {
            electric_w: active.electric_w * share,
            compressor_w: (active.electric_w - self.heater.auxiliary_w) * share,
            auxiliary_w: self.heater.auxiliary_w * share,
            heat_w: heat * 3_600_000.0 / c.seconds,
            water_c: water,
            pending_heat_kwh: pending,
            source_depletion_kwh: depletion,
            next,
            start: active.start,
        }
    }
}
