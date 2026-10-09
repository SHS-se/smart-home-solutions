//! Time-dependent, relaxed continuation values. These guide proposals only;
//! coupled native projection and the complete audit still earn every point.
use crate::{physics, policy, *};

#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct Value {
    pub points: f64,
    pub cost: f64,
}
impl Value {
    fn blend(self, other: Self, weight: f64) -> Self {
        Self {
            points: self.points + (other.points - self.points) * weight,
            cost: self.cost + (other.cost - self.cost) * weight,
        }
    }
    /// A point is a krona: the better value has the higher points less cost.
    fn better(self, other: Self) -> bool {
        self.points - self.cost > other.points - other.cost
    }
}
#[derive(Clone, Copy)]
enum Device {
    Pool,
    Ev,
    Battery,
}
struct Table {
    device: Device,
    axis: Vec<f64>,
    phases: Vec<HeaterState>,
    options: Vec<Command>,
    values: Vec<Value>,
}
fn bracket(nodes: &[f64], value: f64) -> (usize, usize, f64) {
    let upper = nodes.partition_point(|v| *v < value);
    if upper == 0 {
        return (0, 0, 0.0);
    }
    if upper == nodes.len() {
        return (upper - 1, upper - 1, 0.0);
    }
    let lower = upper - 1;
    (
        lower,
        upper,
        (value - nodes[lower]) / (nodes[upper] - nodes[lower]),
    )
}
fn axis(mut landmarks: Vec<f64>) -> Vec<f64> {
    landmarks.sort_by(f64::total_cmp);
    let low = landmarks[0];
    let high = *landmarks.last().unwrap();
    for i in 0..=32 {
        landmarks.push(low + (high - low) * i as f64 / 32.0);
    }
    landmarks.sort_by(f64::total_cmp);
    landmarks.dedup();
    landmarks
}
fn idle() -> Command {
    Command {
        pool_on: false,
        ev_amps: 0,
        battery: Operation::Idle,
        charge_limit_w: 0.0,
        discharge_limit_w: 0.0,
    }
}
impl Table {
    fn inventory(&self, state: &physics::State) -> f64 {
        match self.device {
            Device::Pool => state.pool,
            Device::Ev => state.ev,
            Device::Battery => state.battery,
        }
    }
    fn phase(&self, heater: HeaterState) -> (usize, usize, f64) {
        if !matches!(self.device, Device::Pool) {
            return (0, 0, 0.0);
        }
        let (same, seconds): (fn(&HeaterState) -> bool, f64) = match heater {
            HeaterState::OffUnobserved => return (0, 0, 0.0),
            HeaterState::Steady => {
                let i = self.phases.len() - 1;
                return (i, i, 0.0);
            }
            HeaterState::Off { seconds } => (|s| matches!(s, HeaterState::Off { .. }), seconds),
            HeaterState::Running { seconds } => {
                (|s| matches!(s, HeaterState::Running { .. }), seconds)
            }
        };
        let mut previous: Option<(usize, f64)> = None;
        for (i, phase) in self.phases.iter().enumerate().filter(|(_, s)| same(s)) {
            let at = match phase {
                HeaterState::Off { seconds } | HeaterState::Running { seconds } => *seconds,
                _ => unreachable!(),
            };
            if at >= seconds {
                return match previous {
                    Some((j, before)) => (j, i, (seconds - before) / (at - before)),
                    None => (i, i, 0.0),
                };
            }
            previous = Some((i, at));
        }
        let (i, _) = previous.unwrap();
        (i, i, 0.0)
    }
    fn at(&self, i: usize, state: &physics::State) -> Value {
        let (a, b, weight) = bracket(&self.axis, self.inventory(state));
        let (pa, pb, phase_weight) = self.phase(state.heater);
        let read = |phase: usize| {
            let from = (i * self.phases.len() + phase) * self.axis.len();
            self.values[from + a].blend(self.values[from + b], weight)
        };
        read(pa).blend(read(pb), phase_weight)
    }
    fn cell(&self, state: &physics::State) -> (usize, usize) {
        let (a, b, w) = bracket(&self.axis, self.inventory(state));
        let (pa, pb, pw) = self.phase(state.heater);
        (if w < 0.5 { a } else { b }, if pw < 0.5 { pa } else { pb })
    }
    fn mask_command(&self, c: &Command) -> Command {
        let mut masked = idle();
        match self.device {
            Device::Pool => masked.pool_on = c.pool_on,
            Device::Ev => masked.ev_amps = c.ev_amps,
            Device::Battery => {
                masked.battery = c.battery;
                masked.charge_limit_w = c.charge_limit_w;
                masked.discharge_limit_w = c.discharge_limit_w;
            }
        }
        masked
    }
    fn mask(&self, p: &Problem) -> Problem {
        let mut m = p.clone();
        if !matches!(self.device, Device::Pool) {
            m.heater = None;
            m.pool_store = None;
            m.pool_stop_c = None;
            m.initial.pool_c = None;
            m.initial.heater_state = None;
            m.targets.pool_c = None;
            m.end_credit.pool = None;
        }
        if !matches!(self.device, Device::Ev) {
            m.car = None;
            m.charger = None;
            m.initial.ev_kwh = None;
            m.targets.ev_km = None;
            m.targets.ev_limit_kwh = None;
            m.end_credit.ev = None;
        }
        if !matches!(self.device, Device::Battery) {
            m.battery = None;
            m.initial.battery_kwh = None;
            m.end_credit.battery = None;
        }
        m.rules
            .retain(|r| !matches!(r.key, RuleKey::PoolBuffer | RuleKey::ArbitrageNotFull));
        m.accepted = p
            .accepted
            .as_ref()
            .map(|cs| cs.iter().map(|c| self.mask_command(c)).collect());
        // Device tables intentionally relax shared power/solar competition. They
        // are optimistic guidance, never an admissibility check or earned score.
        let own = match self.device {
            Device::Pool => p
                .heater
                .as_ref()
                .map_or(0.0, |h| h.compressor_w + h.auxiliary_w),
            Device::Ev => p
                .charger
                .as_ref()
                .map_or(0.0, |c| c.watts(c.max_current_a).unwrap()),
            Device::Battery => p
                .battery
                .as_ref()
                .map_or(0.0, |b| b.charge_max_w.max(b.discharge_max_w)),
        };
        for s in &m.slots {
            m.limits.import_w = m.limits.import_w.max(s.base_w + own);
            m.limits.export_w = m.limits.export_w.max(s.solar_w + own);
        }
        m
    }
}
fn tables(p: &Problem) -> Vec<Table> {
    let mut out = Vec::new();
    let make = |device, axis, phases, options| Table {
        device,
        axis,
        phases,
        options,
        values: Vec::new(),
    };
    if let Some((store, heater)) = p.pool_store.as_ref().zip(p.heater.as_ref()) {
        let target = p.targets.pool_c.unwrap();
        let initial = p.initial.pool_c.unwrap();
        let mut water = initial;
        let mut low = initial;
        for s in &p.slots {
            water = store.step(water, 0.0, s.outdoor_c, physics::projected_hours(s));
            low = low.min(water);
        }
        let mut nodes = vec![low, initial, target];
        for r in &p.rules {
            let threshold = match r.key {
                RuleKey::PoolLow | RuleKey::PoolCold => Some(target - r.threshold),
                RuleKey::PoolHot | RuleKey::PoolBuffer => Some(target + r.threshold),
                _ => None,
            };
            if let Some(t) = threshold {
                nodes.extend([t - 0.001, t, t + 0.001]);
            }
        }
        let top = nodes.iter().copied().max_by(f64::total_cmp).unwrap();
        nodes.push(top + heater.heat_w / 4000.0 / store.capacity_kwh_per_c);
        let mut phases = vec![HeaterState::OffUnobserved];
        let rest = policy::rule(p, RuleKey::PoolRestart).map_or(0.0, |r| r.threshold * 3600.0);
        let steps = ((rest / 3600.0).ceil() as usize).min(12);
        for i in 0..=steps {
            phases.push(HeaterState::Off {
                seconds: if rest <= 43200.0 {
                    (i as f64 * 3600.0).min(rest)
                } else {
                    rest * i as f64 / steps as f64
                },
            });
        }
        let startup = match &heater.response {
            shs_planner_models::Response::Steady => 0.0,
            shs_planner_models::Response::Bergvarme { startup } => {
                startup.last().unwrap().elapsed_seconds
            }
        };
        // Running ages use quarter resolution plus the final measured startup
        // point; known stop ages interpolate by hour. Actual labels stay exact.
        let steps = ((startup / 900.0).ceil() as usize).min(8);
        for i in 0..=steps {
            phases.push(HeaterState::Running {
                seconds: if startup <= 7200.0 {
                    (i as f64 * 900.0).min(startup)
                } else {
                    startup * i as f64 / steps as f64
                },
            });
        }
        phases.push(HeaterState::Steady);
        out.push(make(
            Device::Pool,
            axis(nodes),
            phases,
            vec![
                idle(),
                Command {
                    pool_on: true,
                    ..idle()
                },
            ],
        ));
    }
    if let Some((car, charger)) = p.car.as_ref().zip(p.charger.as_ref()) {
        let mut nodes = vec![
            0.0,
            p.initial.ev_kwh.unwrap(),
            p.targets.ev_limit_kwh.unwrap(),
            (p.targets.ev_km.unwrap() * car.kwh_per_km).min(p.targets.ev_limit_kwh.unwrap()),
        ];
        for r in &p.rules {
            if matches!(r.key, RuleKey::EvLow | RuleKey::EvShort) {
                let t = (p.targets.ev_km.unwrap() - r.threshold) * car.kwh_per_km;
                nodes.extend([t - 0.01 * car.kwh_per_km, t, t + 0.01 * car.kwh_per_km]);
            }
        }
        let mut options = vec![idle()];
        for amps in
            (charger.min_current_a..=charger.max_current_a).step_by(charger.current_step_a as usize)
        {
            options.push(Command {
                ev_amps: amps,
                ..idle()
            });
        }
        out.push(make(
            Device::Ev,
            axis(nodes),
            vec![HeaterState::OffUnobserved],
            options,
        ));
    }
    if let Some(b) = &p.battery {
        let nodes = vec![
            0.0,
            p.initial.battery_kwh.unwrap(),
            b.min_soc * b.capacity_kwh,
            b.max_soc * b.capacity_kwh,
            p.limits.battery_export_reserve_kwh,
        ];
        let mut options = vec![
            idle(),
            Command {
                battery: Operation::Hold,
                charge_limit_w: b.charge_max_w,
                ..idle()
            },
            Command {
                battery: Operation::SelfConsumption,
                charge_limit_w: b.charge_max_w,
                discharge_limit_w: b.discharge_max_w,
                ..idle()
            },
        ];
        for watts in [b.charge_max_w * 0.25, b.charge_max_w * 0.5, b.charge_max_w] {
            options.push(Command {
                battery: Operation::GridCharge,
                charge_limit_w: watts,
                ..idle()
            });
        }
        if p.limits.battery_export_enabled {
            options.push(Command {
                battery: Operation::Export,
                discharge_limit_w: b.discharge_max_w,
                ..idle()
            });
        }
        out.push(make(
            Device::Battery,
            axis(nodes),
            vec![HeaterState::OffUnobserved],
            options,
        ));
    }
    out
}
fn bound(p: &Problem, specs: &[Table], unit: u64) -> Option<u64> {
    let n = p.slots.len() as u64;
    specs
        .iter()
        .try_fold(n.checked_mul(unit)?.checked_mul(6)?, |sum, t| {
            let cells = (t.axis.len() as u64).checked_mul(t.phases.len() as u64)?;
            let prepare = (n + 1).checked_mul(cells)?.checked_mul(16)?;
            let transitions = n
                .checked_mul(cells)?
                .checked_mul(t.options.len() as u64)?
                .checked_mul(unit)?;
            sum.checked_add(prepare)?.checked_add(transitions)
        })
}
pub(crate) fn work_bound(p: &Problem, unit: u64) -> Option<u64> {
    bound(p, &tables(p), unit)
}

pub(crate) struct Opportunity {
    tables: Vec<Table>,
}
impl Opportunity {
    pub(crate) fn prepare(
        p: &Problem,
        index: &policy::Index,
        work: &mut Work,
    ) -> Result<Self, String> {
        let mut specs = tables(p);
        let allocation = bound(p, &specs, work.unit_cost).ok_or("work_recipe_overflow")?;
        if !work.spend(allocation) {
            return Err("work_grant_cannot_prepare_opportunity".into());
        }
        for t in &mut specs {
            let m = t.mask(p);
            let cells = t.axis.len() * t.phases.len();
            t.values = vec![Value::default(); (p.slots.len() + 1) * cells];
            // The horizon ends on what the device's own store is credited for.
            let n = p.slots.len();
            for phase in 0..t.phases.len() {
                for node in 0..t.axis.len() {
                    let level = t.axis[node];
                    let credit = match t.device {
                        Device::Pool => {
                            policy::store_credit(p, &p.end_credit.pool, p.initial.pool_c, level)
                        }
                        Device::Ev => {
                            policy::store_credit(p, &p.end_credit.ev, p.initial.ev_kwh, level)
                        }
                        Device::Battery => policy::store_credit(
                            p,
                            &p.end_credit.battery,
                            p.initial.battery_kwh,
                            level,
                        ),
                    };
                    t.values[(n * t.phases.len() + phase) * t.axis.len() + node].cost = -credit;
                }
            }
            for i in (0..p.slots.len()).rev() {
                for phase in 0..t.phases.len() {
                    for node in 0..t.axis.len() {
                        let mut state = physics::initial(&m);
                        match t.device {
                            Device::Pool => state.pool = t.axis[node],
                            Device::Ev => state.ev = t.axis[node],
                            Device::Battery => state.battery = t.axis[node],
                        }
                        state.heater = t.phases[phase];
                        let options = if physics::locked(&m, i) {
                            &m.accepted.as_ref().unwrap()[i..i + 1]
                        } else {
                            &t.options
                        };
                        let mut best: Option<Value> = None;
                        for command in options {
                            let mut next = state.clone();
                            let Ok(q) = physics::step(&m, i, command, &mut next) else {
                                continue;
                            };
                            let future = t.at(i + 1, &next);
                            let v = Value {
                                points: f64::from(policy::guidance_quarter(
                                    &m, index, i, &q, state.pool,
                                )) + future.points,
                                cost: q.cost + q.wear + future.cost,
                            };
                            if best.is_none_or(|old| v.better(old)) {
                                best = Some(v);
                            }
                        }
                        t.values[(i * t.phases.len() + phase) * t.axis.len() + node] =
                            best.ok_or("opportunity_has_no_native_transition")?;
                    }
                }
            }
        }
        Ok(Self { tables: specs })
    }
    pub(crate) fn to_go(&self, i: usize, state: &physics::State) -> Value {
        self.tables.iter().fold(Value::default(), |mut sum, t| {
            let v = t.at(i, state);
            sum.points += v.points;
            sum.cost += v.cost;
            sum
        })
    }
    pub(crate) fn cell(&self, state: &physics::State) -> Vec<(usize, usize)> {
        self.tables.iter().map(|t| t.cell(state)).collect()
    }
}
