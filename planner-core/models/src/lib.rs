//! Pure device transitions. No prices, policy, history, storage or clock.
use serde::{Deserialize, Serialize};
use std::cell::Cell;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Battery {
    pub capacity_kwh: f64,
    pub min_soc: f64,
    pub max_soc: f64,
    pub charge_max_w: f64,
    pub discharge_max_w: f64,
    pub charge_efficiency: f64,
    pub discharge_efficiency: f64,
}

impl Battery {
    pub fn available_charge_w(&self, kwh: f64, hours: f64) -> f64 {
        ((self.max_soc * self.capacity_kwh - kwh).max(0.0) * 1000.0
            / hours
            / self.charge_efficiency)
            .min(self.charge_max_w)
    }
    pub fn available_discharge_w(&self, kwh: f64, hours: f64) -> f64 {
        ((kwh - self.min_soc * self.capacity_kwh).max(0.0) * 1000.0 / hours
            * self.discharge_efficiency)
            .min(self.discharge_max_w)
    }
    pub fn step(&self, kwh: f64, charge: f64, discharge: f64, hours: f64) -> f64 {
        kwh + hours / 1000.0
            * (charge * self.charge_efficiency - discharge / self.discharge_efficiency)
    }
}

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

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LossPoint {
    pub at_c: f64,
    pub c_per_h: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StandingLoss {
    Linear {
        kw_per_c: f64,
        surroundings_c: Option<f64>,
    },
    Measured {
        points: Vec<LossPoint>,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ThermalStore {
    pub capacity_kwh_per_c: f64,
    pub response_time_constant_h: f64,
    pub loss: StandingLoss,
}

/// Deterministic 1-exp(-x): platform transcendental functions differ by ulps.
/// The same reduced Taylor series and doubling arithmetic runs in TS/Wasm.
fn pool_response_release(x: f64) -> f64 {
    if x >= 40.0 {
        return 1.0;
    }
    let (mut reduced, mut doublings) = (x, 0);
    while reduced > 0.125 {
        reduced /= 2.0;
        doublings += 1;
    }
    let mut term = -reduced;
    let mut sum = term;
    for n in 2..=16 {
        term *= -reduced / f64::from(n);
        sum += term;
    }
    let mut released = -sum;
    for _ in 0..doublings {
        released *= 2.0 - released;
    }
    released
}

#[derive(Clone, Copy)]
struct ReleaseWeights {
    hours_bits: u64,
    released: f64,
    end_weight: f64,
}
impl ReleaseWeights {
    fn new(hours: f64, tau: f64) -> Self {
        let x = hours / tau;
        let released = pool_response_release(x);
        // Nonnegative endpoint weights avoid cancellation on falling ramps.
        let end_weight = if x < 1e-4 {
            x * (0.5 + x * (-1.0 / 6.0 + x * (1.0 / 24.0 - x / 120.0)))
        } else {
            1.0 - released / x
        };
        Self {
            hours_bits: hours.to_bits(),
            released,
            end_weight,
        }
    }
}

struct ReleaseMemo {
    tau: f64,
    cells: Box<[Cell<ReleaseWeights>]>,
    #[cfg(test)]
    computations: Cell<usize>,
    #[cfg(test)]
    hits: Cell<usize>,
}
impl ReleaseMemo {
    const ENTRIES: usize = 4096;
    fn new(tau: f64) -> Self {
        let zero = ReleaseWeights::new(0.0, tau);
        Self {
            tau,
            cells: vec![Cell::new(zero); Self::ENTRIES].into_boxed_slice(),
            #[cfg(test)]
            computations: Cell::new(0),
            #[cfg(test)]
            hits: Cell::new(0),
        }
    }
    fn index(mut bits: u64) -> usize {
        bits ^= bits >> 32;
        bits = bits.wrapping_mul(0xd6e8feb86659fd93);
        bits ^= bits >> 32;
        bits as usize & (Self::ENTRIES - 1)
    }
    fn weights(&self, hours: f64) -> ReleaseWeights {
        let bits = hours.to_bits();
        let cell = &self.cells[Self::index(bits)];
        let stored = cell.get();
        if stored.hours_bits == bits {
            #[cfg(test)]
            self.hits.set(self.hits.get() + 1);
            return stored;
        }
        let computed = ReleaseWeights::new(hours, self.tau);
        cell.set(computed);
        #[cfg(test)]
        self.computations.set(self.computations.get() + 1);
        computed
    }
}

#[derive(Clone, Copy)]
struct ThermalTransfer<'a> {
    store: &'a ThermalStore,
    weights: Option<&'a ReleaseMemo>,
}
impl ThermalTransfer<'_> {
    /// Exact linear-input reservoir transition with interval-start cooling.
    fn transfer(
        &self,
        water: f64,
        pending: f64,
        heat_w: f64,
        slope_w_per_h: f64,
        hours: f64,
        cooling: f64,
    ) -> (f64, f64) {
        let tau = self.store.response_time_constant_h;
        let supplied = (heat_w * hours + slope_w_per_h * hours * hours / 2.0) / 1000.0;
        let next = if tau > 0.0 {
            let ReleaseWeights {
                released,
                end_weight,
                ..
            } = self.weights.map_or_else(
                || ReleaseWeights::new(hours, tau),
                |memo| memo.weights(hours),
            );
            pending * (1.0 - released)
                + tau / 1000.0
                    * (heat_w * (released - end_weight)
                        + (heat_w + slope_w_per_h * hours) * end_weight)
        } else {
            0.0
        };
        (
            water + (pending + supplied - next) / self.store.capacity_kwh_per_c + cooling * hours,
            next,
        )
    }
    fn step_pool(
        &self,
        water: f64,
        pending: f64,
        heat_start_w: f64,
        heat_end_w: f64,
        outdoor: f64,
        hours: f64,
    ) -> (f64, f64) {
        if hours == 0.0 {
            return (water, pending);
        }
        self.transfer(
            water,
            pending,
            heat_start_w,
            (heat_end_w - heat_start_w) / hours,
            hours,
            self.store.idle_per_hour(water, outdoor),
        )
    }
}

/// Model-owned exact duration arithmetic, reused across startup segments and
/// thermostat searches. Each cell remains canonical for its full duration bits;
/// collisions change only computation, never the supported physical model.
pub struct PoolKernel<'a> {
    heater: &'a Heater,
    store: &'a ThermalStore,
    weights: Option<ReleaseMemo>,
}
impl<'a> PoolKernel<'a> {
    pub const MAX_WEIGHT_MEMO_BYTES: usize =
        ReleaseMemo::ENTRIES * std::mem::size_of::<Cell<ReleaseWeights>>();

    pub fn new(heater: &'a Heater, store: &'a ThermalStore) -> Self {
        Self {
            heater,
            store,
            weights: (store.response_time_constant_h > 0.0)
                .then(|| ReleaseMemo::new(store.response_time_constant_h)),
        }
    }
    pub fn transition(
        &self,
        state: HeaterState,
        on: bool,
        conditions: PoolConditions,
    ) -> PoolTransition {
        self.heater.pool_transition_with_transfer(
            ThermalTransfer {
                store: self.store,
                weights: self.weights.as_ref(),
            },
            state,
            on,
            conditions,
        )
    }
}

impl ThermalStore {
    pub fn inventory_c(&self, water: f64, pending_heat_kwh: f64) -> f64 {
        water + pending_heat_kwh / self.capacity_kwh_per_c
    }
    pub fn step_pool(
        &self,
        water: f64,
        pending: f64,
        heat_start_w: f64,
        heat_end_w: f64,
        outdoor: f64,
        hours: f64,
    ) -> (f64, f64) {
        ThermalTransfer {
            store: self,
            weights: None,
        }
        .step_pool(water, pending, heat_start_w, heat_end_w, outdoor, hours)
    }
    pub fn idle_per_hour(&self, water: f64, outdoor: f64) -> f64 {
        match &self.loss {
            StandingLoss::Linear {
                kw_per_c,
                surroundings_c,
            } => -kw_per_c * (water - surroundings_c.unwrap_or(outdoor)) / self.capacity_kwh_per_c,
            StandingLoss::Measured { points } => {
                let mut rate = if water <= points[0].at_c {
                    points[0].c_per_h
                } else {
                    points.last().unwrap().c_per_h
                };
                for pair in points.windows(2) {
                    if water > pair[0].at_c && water <= pair[1].at_c {
                        rate = pair[0].c_per_h
                            + (pair[1].c_per_h - pair[0].c_per_h) * (water - pair[0].at_c)
                                / (pair[1].at_c - pair[0].at_c);
                        break;
                    }
                }
                rate.min(0.0)
            }
        }
    }
    pub fn step(&self, water: f64, heat_w: f64, outdoor: f64, hours: f64) -> f64 {
        water
            + hours
                * (heat_w / 1000.0 / self.capacity_kwh_per_c + self.idle_per_hour(water, outdoor))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StartupPoint {
    pub elapsed_seconds: f64,
    pub electric_fraction: f64,
    pub heat_fraction: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    Steady,
    Bergvarme { startup: Vec<StartupPoint> },
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunAge {
    Off,
    Running { seconds: f64 },
    Steady,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HeaterState {
    OffUnobserved,
    Off { seconds: f64 },
    Running { seconds: f64 },
    Steady,
}
impl HeaterState {
    pub fn age(self) -> RunAge {
        match self {
            Self::OffUnobserved | Self::Off { .. } => RunAge::Off,
            Self::Running { seconds } => RunAge::Running { seconds },
            Self::Steady => RunAge::Steady,
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct HeaterStart {
    pub off_seconds: Option<f64>,
}
pub struct HeaterTransition {
    pub electric_w: f64,
    pub heat_w: f64,
    pub next: HeaterState,
    pub start: Option<HeaterStart>,
}

fn integral(points: &[StartupPoint], age: f64, seconds: f64, heat: bool) -> f64 {
    let steady_at = points.last().unwrap().elapsed_seconds;
    if age >= steady_at {
        return seconds;
    }
    let end = steady_at.min(age + seconds);
    let mut result = (seconds - (steady_at - age)).max(0.0);
    let value = |p: &StartupPoint| {
        if heat {
            p.heat_fraction
        } else {
            p.electric_fraction
        }
    };
    for pair in points.windows(2) {
        let from = age.max(pair[0].elapsed_seconds);
        let to = end.min(pair[1].elapsed_seconds);
        if to <= from {
            continue;
        }
        let slope = (value(&pair[1]) - value(&pair[0]))
            / (pair[1].elapsed_seconds - pair[0].elapsed_seconds);
        let start = value(&pair[0]) + slope * (from - pair[0].elapsed_seconds);
        result += (2.0 * start + slope * (to - from)) / 2.0 * (to - from);
    }
    result
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Heater {
    pub compressor_w: f64,
    pub auxiliary_w: f64,
    pub heat_w: f64,
    pub response: Response,
}
impl Heater {
    pub fn validate_response(&self) -> Result<(), &'static str> {
        if let Response::Bergvarme { startup } = &self.response {
            if startup.len() < 2
                || startup[0].elapsed_seconds != 0.0
                || startup
                    .windows(2)
                    .any(|a| a[1].elapsed_seconds <= a[0].elapsed_seconds)
                || startup.iter().any(|a| {
                    a.electric_fraction < 0.0
                        || a.heat_fraction < 0.0
                        || a.electric_fraction == 0.0 && a.heat_fraction != 0.0
                })
                || startup.last().unwrap().electric_fraction != 1.0
                || startup.last().unwrap().heat_fraction != 1.0
            {
                return Err("invalid_startup_model");
            }
        }
        Ok(())
    }
    pub fn transition(&self, state: HeaterState, on: bool, seconds: f64) -> HeaterTransition {
        let (electric_w, heat_w, age) = self.step(on, state.age(), seconds);
        let start = if on {
            match state {
                HeaterState::OffUnobserved => Some(HeaterStart { off_seconds: None }),
                HeaterState::Off { seconds } => Some(HeaterStart {
                    off_seconds: Some(seconds),
                }),
                _ => None,
            }
        } else {
            None
        };
        let next = if on {
            match age {
                RunAge::Running { seconds } => HeaterState::Running { seconds },
                RunAge::Steady => HeaterState::Steady,
                RunAge::Off => unreachable!(),
            }
        } else {
            match state {
                HeaterState::OffUnobserved => HeaterState::OffUnobserved,
                HeaterState::Off { seconds: previous } => HeaterState::Off {
                    seconds: previous + seconds,
                },
                _ => HeaterState::Off { seconds },
            }
        };
        HeaterTransition {
            electric_w,
            heat_w,
            next,
            start,
        }
    }
    pub fn step(&self, on: bool, age: RunAge, seconds: f64) -> (f64, f64, RunAge) {
        if !on {
            return (0.0, 0.0, RunAge::Off);
        }
        let (electric, heat, next) = match age {
            RunAge::Steady => (1.0, 1.0, RunAge::Steady),
            _ => {
                let from = match age {
                    RunAge::Running { seconds } => seconds,
                    _ => 0.0,
                };
                let (electric, heat) = match &self.response {
                    Response::Steady => (1.0, 1.0),
                    Response::Bergvarme { startup } => (
                        integral(startup, from, seconds, false) / seconds,
                        integral(startup, from, seconds, true) / seconds,
                    ),
                };
                (
                    electric,
                    heat,
                    RunAge::Running {
                        seconds: from + seconds,
                    },
                )
            }
        };
        (
            self.compressor_w * electric + self.auxiliary_w,
            self.heat_w * heat,
            next,
        )
    }
}

/// Hardware thermostat clips delivered electricity and heat, never the published permit.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct PoolConditions {
    pub water_c: f64,
    pub pending_heat_kwh: f64,
    pub outdoor_c: f64,
    pub seconds: f64,
    pub stop_c: Option<f64>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct PoolTransition {
    pub electric_w: f64,
    pub compressor_w: f64,
    pub auxiliary_w: f64,
    pub heat_w: f64,
    pub water_c: f64,
    pub pending_heat_kwh: f64,
    pub next: HeaterState,
    pub start: Option<HeaterStart>,
}
impl Heater {
    pub fn pool_transition(
        &self,
        store: &ThermalStore,
        state: HeaterState,
        on: bool,
        conditions: PoolConditions,
    ) -> PoolTransition {
        self.pool_transition_with_transfer(
            ThermalTransfer {
                store,
                weights: None,
            },
            state,
            on,
            conditions,
        )
    }

    fn pool_transition_with_transfer(
        &self,
        transfer: ThermalTransfer<'_>,
        state: HeaterState,
        on: bool,
        conditions: PoolConditions,
    ) -> PoolTransition {
        let store = transfer.store;
        if store.response_time_constant_h == 0.0 {
            return self.pool_transition_direct(
                store,
                state,
                on,
                PoolConditions {
                    water_c: store.inventory_c(conditions.water_c, conditions.pending_heat_kwh),
                    pending_heat_kwh: 0.0,
                    ..conditions
                },
            );
        }
        let PoolConditions {
            water_c,
            pending_heat_kwh,
            outdoor_c,
            seconds,
            stop_c,
        } = conditions;
        let permitted = on && stop_c.is_none_or(|stop| water_c < stop);
        if !permitted {
            let off = self.transition(state, false, seconds);
            let (water, pending) = transfer.step_pool(
                water_c,
                pending_heat_kwh,
                0.0,
                0.0,
                outdoor_c,
                seconds / 3600.0,
            );
            return PoolTransition {
                electric_w: 0.0,
                compressor_w: 0.0,
                auxiliary_w: 0.0,
                heat_w: 0.0,
                water_c: water,
                pending_heat_kwh: pending,
                next: off.next,
                start: None,
            };
        }
        let age = match state {
            HeaterState::Steady => f64::INFINITY,
            HeaterState::Running { seconds } => seconds,
            _ => 0.0,
        };
        let startup = match &self.response {
            Response::Bergvarme { startup } if age.is_finite() => startup.as_slice(),
            _ => &[],
        };
        let knots = startup
            .iter()
            .map(|p| p.elapsed_seconds - age)
            .filter(|t| *t > 0.0 && *t < seconds)
            .chain(std::iter::once(seconds));
        let fraction = |elapsed: f64| -> f64 {
            if !age.is_finite() {
                return 1.0;
            }
            if let Response::Bergvarme { startup } = &self.response {
                let at = age + elapsed;
                for pair in startup.windows(2) {
                    if at <= pair[1].elapsed_seconds {
                        return pair[0].heat_fraction
                            + (pair[1].heat_fraction - pair[0].heat_fraction)
                                * (at - pair[0].elapsed_seconds)
                                / (pair[1].elapsed_seconds - pair[0].elapsed_seconds);
                    }
                }
            }
            1.0
        };
        let cooling = store.idle_per_hour(water_c, outdoor_c);
        let (mut water, mut pending) = (water_c, pending_heat_kwh);
        let mut active_seconds = seconds;
        let mut previous = 0.0;
        for end in knots {
            let hours = (end - previous) / 3600.0;
            let start_fraction = fraction(previous);
            let heat = self.heat_w * start_fraction;
            let slope = self.heat_w * (fraction(end) - start_fraction) / hours;
            let (crossing, full) = stop_c.map_or_else(
                || {
                    (
                        None,
                        transfer.transfer(water, pending, heat, slope, hours, cooling),
                    )
                },
                |stop| {
                    first_pool_stop(
                        &transfer,
                        (water, pending),
                        heat,
                        slope,
                        hours,
                        cooling,
                        stop,
                    )
                },
            );
            (water, pending) = crossing.map_or(full, |at| {
                transfer.transfer(water, pending, heat, slope, at, cooling)
            });
            if let Some(at) = crossing {
                active_seconds = previous + at * 3600.0;
                break;
            }
            previous = end;
        }
        let active = self.transition(state, true, active_seconds);
        let share = active_seconds / seconds;
        let next = if active_seconds < seconds {
            (water, pending) = transfer.step_pool(
                water,
                pending,
                0.0,
                0.0,
                outdoor_c,
                (seconds - active_seconds) / 3600.0,
            );
            self.transition(active.next, false, seconds - active_seconds)
                .next
        } else {
            active.next
        };
        PoolTransition {
            electric_w: active.electric_w * share,
            compressor_w: (active.electric_w - self.auxiliary_w) * share,
            auxiliary_w: self.auxiliary_w * share,
            heat_w: active.heat_w * share,
            water_c: water,
            pending_heat_kwh: pending,
            next,
            start: active.start,
        }
    }

    fn pool_transition_direct(
        &self,
        store: &ThermalStore,
        state: HeaterState,
        on: bool,
        conditions: PoolConditions,
    ) -> PoolTransition {
        let PoolConditions {
            water_c,
            pending_heat_kwh: _,
            outdoor_c,
            seconds,
            stop_c,
        } = conditions;
        let permitted = on && stop_c.is_none_or(|stop| water_c < stop);
        let full = self.transition(state, permitted, seconds);
        let end = store.step(water_c, full.heat_w, outdoor_c, seconds / 3600.0);
        let active_seconds = if permitted && stop_c.is_some_and(|stop| end > stop) {
            let stop = stop_c.unwrap();
            // A steady response delivers the same heat at every trial duration.
            // Keep the exact thermostat search, but do not re-run the heater
            // transition 48 times when its heat cannot change.
            let steady =
                matches!(self.response, Response::Steady) || matches!(state, HeaterState::Steady);
            let (mut low, mut high) = (0.0, seconds);
            for _ in 0..48 {
                let mid = (low + high) / 2.0;
                let heat = if steady {
                    full.heat_w
                } else {
                    self.transition(state, true, mid).heat_w
                };
                if store.step(water_c, heat, outdoor_c, mid / 3600.0) < stop {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            (low + high) / 2.0
        } else if permitted {
            seconds
        } else {
            0.0
        };
        if active_seconds == 0.0 {
            return PoolTransition {
                electric_w: 0.0,
                compressor_w: 0.0,
                auxiliary_w: 0.0,
                heat_w: 0.0,
                water_c: end,
                pending_heat_kwh: 0.0,
                next: full.next,
                start: None,
            };
        }
        let active = self.transition(state, true, active_seconds);
        let fraction = active_seconds / seconds;
        let mut water = store.step(water_c, active.heat_w, outdoor_c, active_seconds / 3600.0);
        let next = if active_seconds < seconds {
            water = store.step(
                stop_c.expect("thermostat ended the run"),
                0.0,
                outdoor_c,
                (seconds - active_seconds) / 3600.0,
            );
            self.transition(active.next, false, seconds - active_seconds)
                .next
        } else {
            active.next
        };
        PoolTransition {
            electric_w: active.electric_w * fraction,
            compressor_w: (active.electric_w - self.auxiliary_w) * fraction,
            auxiliary_w: self.auxiliary_w * fraction,
            heat_w: active.heat_w * fraction,
            water_c: water,
            pending_heat_kwh: 0.0,
            next,
            start: active.start,
        }
    }
}

fn bisect_root(f: impl Fn(f64) -> f64, mut low: f64, mut high: f64) -> f64 {
    let mut value = f(low);
    for _ in 0..48 {
        let mid = (low + high) / 2.0;
        let next = f(mid);
        if next == 0.0 {
            return mid;
        }
        if next.signum() == value.signum() {
            low = mid;
            value = next;
        } else {
            high = mid;
        }
    }
    (low + high) / 2.0
}

/// Reservoir input is linear, so its derivative has at most one turning point.
/// Partition there to find all water extrema before searching the first crossing.
/// Return the full interval transfer too: all endpoint queries and an uncut
/// interval use that exact result without repeating the reservoir arithmetic.
fn first_pool_stop(
    transfer: &ThermalTransfer<'_>,
    (water, pending): (f64, f64),
    heat: f64,
    slope: f64,
    hours: f64,
    cooling: f64,
    stop: f64,
) -> (Option<f64>, (f64, f64)) {
    let store = transfer.store;
    let full = transfer.transfer(water, pending, heat, slope, hours, cooling);
    if water >= stop {
        return (Some(0.0), full);
    }
    let tau = store.response_time_constant_h;
    let zero = transfer.transfer(water, pending, heat, slope, 0.0, cooling);
    let at = |h: f64| {
        if h.to_bits() == hours.to_bits() {
            full
        } else if h.to_bits() == 0.0_f64.to_bits() {
            zero
        } else {
            transfer.transfer(water, pending, heat, slope, h, cooling)
        }
    };
    let derivative = |h| {
        if tau > 0.0 {
            at(h).1 / tau / store.capacity_kwh_per_c + cooling
        } else {
            (heat + slope * h) / 1000.0 / store.capacity_kwh_per_c + cooling
        }
    };
    // One pending-derivative root partitions the interval into at most two.
    let mut pieces = [0.0, hours, 0.0];
    let mut pieces_len = 2;
    if tau > 0.0 {
        let pending_derivative = |h| (heat + slope * h) / 1000.0 - at(h).1 / tau;
        if pending_derivative(0.0) * pending_derivative(hours) < 0.0 {
            pieces[2] = bisect_root(pending_derivative, 0.0, hours);
            pieces_len = 3;
        }
    }
    pieces[..pieces_len].sort_by(f64::total_cmp);
    // Each piece adds either a sign-change root or at most two zero endpoints.
    let mut turning = [0.0; 6];
    turning[1] = hours;
    let mut turning_len = 2;
    for pair in pieces[..pieces_len].windows(2) {
        let (a, b) = (derivative(pair[0]), derivative(pair[1]));
        if a == 0.0 {
            turning[turning_len] = pair[0];
            turning_len += 1;
        }
        if a * b < 0.0 {
            turning[turning_len] = bisect_root(derivative, pair[0], pair[1]);
            turning_len += 1;
        }
        if b == 0.0 {
            turning[turning_len] = pair[1];
            turning_len += 1;
        }
    }
    turning[..turning_len].sort_by(f64::total_cmp);
    for pair in turning[..turning_len].windows(2) {
        if at(pair[0]).0 >= stop {
            return (Some(pair[0]), full);
        }
        if at(pair[1]).0 >= stop {
            return (
                Some(bisect_root(|h| at(h).0 - stop, pair[0], pair[1])),
                full,
            );
        }
    }
    (None, full)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn assert_transition_bits(a: PoolTransition, b: PoolTransition) {
        for (a, b) in [
            (a.electric_w, b.electric_w),
            (a.compressor_w, b.compressor_w),
            (a.auxiliary_w, b.auxiliary_w),
            (a.heat_w, b.heat_w),
            (a.water_c, b.water_c),
            (a.pending_heat_kwh, b.pending_heat_kwh),
        ] {
            assert_eq!(a.to_bits(), b.to_bits());
        }
        assert_eq!(
            serde_json::to_vec(&(a.next, a.start)).unwrap(),
            serde_json::to_vec(&(b.next, b.start)).unwrap()
        );
    }

    #[test]
    fn memoized_kernel_preserves_transition_bits_across_models_and_thermostat_roots() {
        let heater = Heater {
            compressor_w: 3000.0,
            auxiliary_w: 764.0,
            heat_w: 12000.0,
            response: Response::Bergvarme {
                startup: vec![
                    StartupPoint {
                        elapsed_seconds: 0.0,
                        electric_fraction: 0.5,
                        heat_fraction: 0.0,
                    },
                    StartupPoint {
                        elapsed_seconds: 300.0,
                        electric_fraction: 0.7,
                        heat_fraction: 0.6,
                    },
                    StartupPoint {
                        elapsed_seconds: 1200.0,
                        electric_fraction: 0.9,
                        heat_fraction: 0.3,
                    },
                    StartupPoint {
                        elapsed_seconds: 1800.0,
                        electric_fraction: 1.0,
                        heat_fraction: 1.0,
                    },
                ],
            },
        };
        let mut seed = 17_u64;
        for tau in [0.0, 1e-12, 0.0001, 0.675, 2.0, 1e8] {
            for loss in [
                StandingLoss::Linear {
                    kw_per_c: 0.13,
                    surroundings_c: None,
                },
                StandingLoss::Measured {
                    points: vec![LossPoint {
                        at_c: 29.0,
                        c_per_h: -0.04,
                    }],
                },
            ] {
                let store = ThermalStore {
                    capacity_kwh_per_c: 63.965,
                    response_time_constant_h: tau,
                    loss,
                };
                let kernel = PoolKernel::new(&heater, &store);
                for i in 0..512 {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    let water_c = 29.0 + (seed % 1000) as f64 / 1000.0;
                    let seconds = [
                        900.0,
                        600.0,
                        900.123,
                        17.031,
                        3600.0,
                        0.00010001 * tau.max(1e-12) * 3600.0,
                    ][i % 6];
                    let state = match i % 4 {
                        0 => HeaterState::OffUnobserved,
                        1 => HeaterState::Off {
                            seconds: if i % 8 == 1 { -0.0 } else { 900.0 },
                        },
                        2 => HeaterState::Running {
                            seconds: (i % 32) as f64 * 150.0,
                        },
                        _ => HeaterState::Steady,
                    };
                    let conditions = PoolConditions {
                        water_c,
                        pending_heat_kwh: if i % 3 == 0 {
                            -0.0
                        } else {
                            (seed % 810) as f64 / 100.0
                        },
                        outdoor_c: 10.0 + (i % 20) as f64,
                        seconds,
                        stop_c: match i % 5 {
                            0 => None,
                            1 => Some(water_c),
                            2 => Some(water_c + 0.00001),
                            3 => Some(water_c + 0.1),
                            _ => Some(water_c + 0.001),
                        },
                    };
                    let on = i % 7 != 0;
                    assert_transition_bits(
                        kernel.transition(state, on, conditions),
                        heater.pool_transition(&store, state, on, conditions),
                    );
                }
            }
        }
    }

    #[test]
    fn coefficient_keys_collisions_eviction_and_models_preserve_exact_arithmetic() {
        let memo = ReleaseMemo::new(0.675);
        let exact = |a: ReleaseWeights, b: ReleaseWeights| {
            assert_eq!(a.hours_bits, b.hours_bits);
            assert_eq!(a.released.to_bits(), b.released.to_bits());
            assert_eq!(a.end_weight.to_bits(), b.end_weight.to_bits());
        };
        let a = 0.25_f64;
        let bucket = ReleaseMemo::index(a.to_bits());
        let b = (1..100_000)
            .map(|i| f64::from_bits(a.to_bits() + i))
            .find(|h| ReleaseMemo::index(h.to_bits()) == bucket)
            .unwrap();
        for hours in [a, b, a, a] {
            exact(memo.weights(hours), ReleaseWeights::new(hours, memo.tau));
        }
        assert_eq!(memo.computations.get(), 3);
        assert_eq!(memo.hits.get(), 1);
        for hours in [0.0, -0.0, 0.00001, 0.25, 0.25000000000000006, 7.0] {
            exact(memo.weights(hours), ReleaseWeights::new(hours, memo.tau));
        }
        let other = ReleaseMemo::new(2.0);
        assert_ne!(
            memo.weights(a).released.to_bits(),
            other.weights(a).released.to_bits()
        );
        assert_eq!(
            memo.cells.len() * std::mem::size_of::<Cell<ReleaseWeights>>(),
            PoolKernel::MAX_WEIGHT_MEMO_BYTES
        );
        let heater = Heater {
            compressor_w: 3000.0,
            auxiliary_w: 764.0,
            heat_w: 0.0,
            response: Response::Steady,
        };
        let mut store = ThermalStore {
            capacity_kwh_per_c: 5.0,
            response_time_constant_h: 0.675,
            loss: StandingLoss::Linear {
                kw_per_c: 0.0,
                surroundings_c: None,
            },
        };
        let kernel = PoolKernel::new(&heater, &store);
        for seconds in [1.0, 17.0, 900.0, 4000.0] {
            let c = PoolConditions {
                water_c: 29.0,
                pending_heat_kwh: 0.0,
                outdoor_c: 20.0,
                seconds,
                stop_c: Some(30.0),
            };
            assert_transition_bits(
                kernel.transition(HeaterState::Steady, true, c),
                heater.pool_transition(&store, HeaterState::Steady, true, c),
            );
        }
        store.response_time_constant_h = 0.0;
        assert!(PoolKernel::new(&heater, &store).weights.is_none());
    }

    #[test]
    fn deterministic_response_agrees_with_exponential_reference() {
        for x in [
            0.0,
            1e-15,
            1e-12,
            1e-8,
            0.0000999,
            0.0001001,
            0.125,
            0.12371042471042472,
            40.0,
            1000.0,
        ]
        .into_iter()
        .chain((0..1024).map(|i| (f64::from(i) + 0.123) / 77.0))
        {
            assert!(
                (pool_response_release(x) + (-x).exp_m1()).abs() < 2e-15,
                "x={x}"
            );
        }
    }

    #[test]
    fn shared_pool_thermal_transition_vectors() {
        #[derive(Deserialize)]
        struct Vector {
            name: String,
            store: ThermalStore,
            heater: Heater,
            state: HeaterState,
            on: bool,
            conditions: PoolConditions,
            expected: PoolTransition,
        }
        let vectors: Vec<Vector> =
            serde_json::from_str(include_str!("../pool-thermal-transitions.json")).unwrap();
        for v in vectors {
            let q = v
                .heater
                .pool_transition(&v.store, v.state, v.on, v.conditions);
            for (field, actual, expected) in [
                ("electric", q.electric_w, v.expected.electric_w),
                ("compressor", q.compressor_w, v.expected.compressor_w),
                ("auxiliary", q.auxiliary_w, v.expected.auxiliary_w),
                ("heat", q.heat_w, v.expected.heat_w),
                ("water", q.water_c, v.expected.water_c),
                ("pending", q.pending_heat_kwh, v.expected.pending_heat_kwh),
            ] {
                assert!(
                    (actual - expected).abs() < 1e-9,
                    "{} {}: {} != {}",
                    v.name,
                    field,
                    actual,
                    expected
                );
            }
            match (q.next, v.expected.next) {
                (HeaterState::Off { seconds: a }, HeaterState::Off { seconds: b })
                | (HeaterState::Running { seconds: a }, HeaterState::Running { seconds: b }) => {
                    assert!((a - b).abs() < 1e-8, "{} state", v.name)
                }
                (a, b) => assert_eq!(a, b, "{} state", v.name),
            }
            assert_eq!(q.start, v.expected.start, "{} start", v.name);
        }
    }

    #[test]
    fn reservoir_conserves_heat_and_composes_for_linear_input() {
        let store = ThermalStore {
            capacity_kwh_per_c: 63.965,
            response_time_constant_h: 0.675,
            loss: StandingLoss::Measured {
                points: vec![LossPoint {
                    at_c: 29.0,
                    c_per_h: -0.0409231,
                }],
            },
        };
        for pending in [0.0, 8.1] {
            for (start, end) in [
                (0.0, 0.0),
                (12000.0, 12000.0),
                (0.0, 12000.0),
                (12000.0, 0.0),
            ] {
                let whole = store.step_pool(29.64, pending, start, end, 12.0, 0.75);
                let middle = start + (end - start) * 0.21 / 0.75;
                let first = store.step_pool(29.64, pending, start, middle, 12.0, 0.21);
                let split = store.step_pool(first.0, first.1, middle, end, 12.0, 0.54);
                assert!((whole.0 - split.0).abs() < 1e-12);
                assert!((whole.1 - split.1).abs() < 1e-12);
                let delivered = (whole.0 - 29.64 + 0.0409231 * 0.75) * store.capacity_kwh_per_c;
                let supplied = (start + end) / 2.0 / 1000.0 * 0.75;
                assert!((delivered + whole.1 - supplied - pending).abs() < 1e-10);
                assert!(
                    (store.inventory_c(whole.0, whole.1)
                        - (29.64 + (pending + supplied) / store.capacity_kwh_per_c
                            - 0.0409231 * 0.75))
                        .abs()
                        < 1e-12
                );
            }
        }
    }
    #[derive(Deserialize)]
    struct VectorSet {
        response: Response,
        vectors: Vec<Vector>,
    }
    #[derive(Deserialize)]
    struct Vector {
        state: HeaterState,
        on: bool,
        seconds: f64,
        electric_w: f64,
        heat_w: f64,
        next: HeaterState,
        start: Option<HeaterStart>,
    }
    #[test]
    fn shared_heater_transition_vectors() {
        let fixture: VectorSet =
            serde_json::from_str(include_str!("../heater-transitions.json")).unwrap();
        let heater = Heater {
            compressor_w: 3000.0,
            auxiliary_w: 0.0,
            heat_w: 12000.0,
            response: fixture.response,
        };
        for v in fixture.vectors {
            let t = heater.transition(v.state, v.on, v.seconds);
            assert!((t.electric_w - v.electric_w).abs() < 1e-9);
            assert!((t.heat_w - v.heat_w).abs() < 1e-9);
            assert_eq!(t.next, v.next);
            assert_eq!(t.start, v.start);
        }
    }
    #[test]
    fn steady_thermostat_preserves_clipped_energy_cooling_and_start_identity() {
        let store = ThermalStore {
            capacity_kwh_per_c: 5.0,
            response_time_constant_h: 0.0,
            loss: StandingLoss::Linear {
                kw_per_c: 0.2,
                surroundings_c: Some(20.0),
            },
        };
        let startup = Response::Bergvarme {
            startup: vec![
                StartupPoint {
                    elapsed_seconds: 0.0,
                    electric_fraction: 0.5,
                    heat_fraction: 0.0,
                },
                StartupPoint {
                    elapsed_seconds: 900.0,
                    electric_fraction: 1.0,
                    heat_fraction: 1.0,
                },
            ],
        };
        for response in [Response::Steady, startup] {
            let heater = Heater {
                compressor_w: 3000.0,
                auxiliary_w: 1000.0,
                heat_w: 20000.0,
                response,
            };
            for state in [
                HeaterState::OffUnobserved,
                HeaterState::Off { seconds: 123.0 },
                HeaterState::Running { seconds: 300.0 },
                HeaterState::Steady,
            ] {
                if !matches!(heater.response, Response::Steady) && state != HeaterState::Steady {
                    continue;
                }
                let q = heater.pool_transition(
                    &store,
                    state,
                    true,
                    PoolConditions {
                        water_c: 30.0,
                        pending_heat_kwh: 0.0,
                        outdoor_c: 20.0,
                        seconds: 900.0,
                        stop_c: Some(30.1),
                    },
                );
                // Heating rises 3.6 C/hour: it reaches the stop in 100 seconds,
                // then cools for 800 seconds with all heater members off.
                assert!((q.electric_w - 4000.0 / 9.0).abs() < 1e-9);
                assert!((q.compressor_w - 3000.0 / 9.0).abs() < 1e-9);
                assert!((q.auxiliary_w - 1000.0 / 9.0).abs() < 1e-9);
                assert!((q.heat_w - 20000.0 / 9.0).abs() < 1e-9);
                assert!((q.water_c - store.step(30.1, 0.0, 20.0, 800.0 / 3600.0)).abs() < 1e-10);
                assert!(
                    matches!(q.next, HeaterState::Off { seconds } if (seconds - 800.0).abs() < 1e-9)
                );
                assert_eq!(
                    q.start,
                    match state {
                        HeaterState::OffUnobserved => Some(HeaterStart { off_seconds: None }),
                        HeaterState::Off { seconds } => Some(HeaterStart {
                            off_seconds: Some(seconds)
                        }),
                        _ => None,
                    }
                );
            }
        }
    }
    #[test]
    fn startup_keeps_auxiliary_draw_and_distinct_heat_integral() {
        let h = Heater {
            compressor_w: 3000.0,
            auxiliary_w: 764.0,
            heat_w: 12000.0,
            response: Response::Bergvarme {
                startup: vec![
                    StartupPoint {
                        elapsed_seconds: 0.0,
                        electric_fraction: 0.5,
                        heat_fraction: 0.0,
                    },
                    StartupPoint {
                        elapsed_seconds: 900.0,
                        electric_fraction: 1.0,
                        heat_fraction: 1.0,
                    },
                ],
            },
        };
        let (draw, heat, age) = h.step(true, RunAge::Off, 900.0);
        assert_eq!(draw, 3014.0);
        assert_eq!(heat, 6000.0);
        assert!(matches!(age, RunAge::Running { seconds: 900.0 }));
        let (draw, heat, _) = h.step(true, age, 900.0);
        assert_eq!((draw, heat), (3764.0, 12000.0));
    }
}
