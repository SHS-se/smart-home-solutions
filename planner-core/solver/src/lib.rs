//! One complete causal solve. Search owns no persistence or historical inputs.
use serde::{Deserialize, Serialize};
use shs_planner_models::{Battery, CarBattery, Charger, Heater, RunAge, ThermalStore};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Slot {
    pub start_seconds: f64,
    pub hours: f64,
    pub base_w: f64,
    pub solar_w: f64,
    pub outdoor_c: f64,
    pub import_price: f64,
    pub export_price: f64,
    pub published: bool,
    pub cheap_rank: f64,
    pub dear_rank: f64,
    pub next_day_buffer: Option<bool>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Hold,
    SelfConsumption,
    GridCharge,
    SupplyHouse,
    Export,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Command {
    pub pool_on: bool,
    pub ev_amps: u32,
    pub battery: Operation,
    pub charge_limit_w: f64,
    pub discharge_limit_w: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Initial {
    pub battery_kwh: f64,
    pub ev_kwh: f64,
    pub pool_c: f64,
    pub heater_age: RunAge,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Targets {
    pub pool_c: f64,
    pub ev_km: f64,
    pub ev_limit_kwh: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Limits {
    pub import_w: f64,
    pub export_w: f64,
    pub battery_export_enabled: bool,
    pub battery_export_reserve_kwh: f64,
    pub battery_export_min_price: f64,
    pub wear_per_kwh: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuleKey {
    PoolLow,
    PoolCold,
    PoolHot,
    PoolBuffer,
    EvLow,
    EvShort,
    CheapBuy,
    CheapestBuy,
    DearLoad,
    DearestLoad,
    BaseLoadDearImport,
    BaseLoadDearestImport,
    MissedCheapQuarter,
    ArbitrageNoExport,
    ArbitrageNotFull,
    EvFromHomeBattery,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Rule {
    pub key: RuleKey,
    pub threshold: f64,
    pub points: i32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Recipe {
    pub max_passes: u32,
    pub coupled_masks: Vec<u32>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Problem {
    pub abi: u32,
    pub work_grant: u64,
    pub recipe: Recipe,
    pub slots: Vec<Slot>,
    pub battery: Battery,
    pub car: CarBattery,
    pub charger: Charger,
    pub pool_store: ThermalStore,
    pub heater: Heater,
    pub initial: Initial,
    pub targets: Targets,
    pub limits: Limits,
    pub rules: Vec<Rule>,
    /// None means first-ever plan. A partial accepted prefix is never silently filled.
    pub accepted: Option<Vec<Command>>,
    /// Relative to capture; every intersecting slot remains committed.
    pub locked_through_seconds: f64,
}
#[derive(Clone, Debug, Serialize)]
pub struct Quarter {
    pub pool_command_w: f64,
    pub pool_w: f64,
    pub ev_w: f64,
    pub charge_w: f64,
    pub discharge_w: f64,
    pub net_w: f64,
    pub battery_kwh: f64,
    pub ev_kwh: f64,
    pub pool_c: f64,
    pub heater_age: RunAge,
    pub cost: f64,
    pub wear: f64,
    pub spare_battery_cover_w: f64,
}
#[derive(Clone, Debug, Serialize)]
pub struct Account {
    pub points: i32,
    pub cash_sek: f64,
    pub wear_sek: f64,
    /// Contributions retain individual signs, including net-zero quarters.
    pub contributions: Vec<Vec<i32>>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Selection {
    pub commands: Vec<Command>,
    pub quarters: Vec<Quarter>,
    pub account: Account,
    pub work_used: u64,
    pub evaluations: u64,
    pub termination: &'static str,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Selected { selection: Selection },
    Failed { issue: String },
}

fn validate(p: &Problem) -> Result<(), String> {
    let bad = |s: &str| Err(s.to_owned());
    if p.abi != 1 || p.slots.is_empty() {
        return bad("unsupported_abi_or_empty_problem");
    }
    if p.battery.capacity_kwh <= 0.0
        || p.battery.charge_efficiency <= 0.0
        || p.battery.discharge_efficiency <= 0.0
        || p.car.capacity_kwh <= 0.0
        || p.car.kwh_per_km <= 0.0
        || p.car.charge_efficiency <= 0.0
        || p.pool_store.capacity_kwh_per_c <= 0.0
        || p.battery.charge_efficiency > 1.0
        || p.battery.discharge_efficiency > 1.0
        || p.car.charge_efficiency > 1.0
        || p.battery.min_soc < 0.0
        || p.battery.max_soc > 1.0
        || p.battery.min_soc >= p.battery.max_soc
        || p.battery.charge_max_w <= 0.0
        || p.battery.discharge_max_w <= 0.0
        || p.heater.compressor_w <= 0.0
        || p.heater.heat_w <= 0.0
        || p.heater.auxiliary_w < 0.0
    {
        return bad("invalid_model_parameters");
    }
    if p.charger.min_current_a == 0
        || p.charger.current_step_a == 0
        || p.charger.min_current_a > p.charger.max_current_a
        || p.charger.phase_count == 0
        || p.charger.voltage_v <= 0.0
        || !(p.charger.max_current_a - p.charger.min_current_a)
            .is_multiple_of(p.charger.current_step_a)
    {
        return bad("invalid_charger_commands");
    }
    if matches!(p.initial.heater_age, RunAge::Running{seconds} if seconds<0.0) {
        return bad("invalid_initial_heater_age");
    }
    if p.rules
        .iter()
        .enumerate()
        .any(|(i, r)| p.rules[..i].iter().any(|a| a.key == r.key))
    {
        return bad("duplicate_measurement_key");
    }
    if p.slots.iter().any(|s| s.hours <= 0.0) {
        return bad("invalid_slot_duration");
    }
    for pair in p.slots.windows(2) {
        if (pair[0].start_seconds + pair[0].hours * 3600.0 - pair[1].start_seconds).abs() > 1e-6 {
            return bad("noncontiguous_command_intervals");
        }
    }
    match &p.pool_store.loss {
        shs_planner_models::StandingLoss::Measured { points } => {
            if points.is_empty() || points.windows(2).any(|a| a[1].at_c <= a[0].at_c) {
                return bad("invalid_measured_loss_model");
            }
        }
        shs_planner_models::StandingLoss::Linear { kw_per_c, .. } => {
            if *kw_per_c < 0.0 {
                return bad("invalid_linear_loss_model");
            }
        }
    }
    if let shs_planner_models::Response::Bergvarme { startup } = &p.heater.response {
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
            return bad("invalid_startup_model");
        }
    }
    if p.recipe.coupled_masks.iter().any(|m| *m == 0 || *m > 7) {
        return bad("unsupported_coupled_mask");
    }
    if p.slots[0].start_seconds > 0.0 || p.slots[0].start_seconds + p.slots[0].hours * 3600.0 <= 0.0
    {
        return bad("missing_capture_interval");
    }
    if p.locked_through_seconds != 0.0 && p.accepted.is_none() {
        return bad("commitment_unavailable");
    }
    if let Some(accepted) = &p.accepted {
        if accepted.len() != p.slots.len()
            || p.locked_through_seconds != 3600.0
            || p.slots.last().unwrap().start_seconds + p.slots.last().unwrap().hours * 3600.0
                < 3600.0
        {
            return bad("commitment_unavailable");
        }
    }
    Ok(())
}

#[derive(Clone)]
struct State {
    battery: f64,
    ev: f64,
    pool: f64,
    age: RunAge,
}
fn initial(p: &Problem) -> State {
    State {
        battery: p.initial.battery_kwh,
        ev: p.initial.ev_kwh,
        pool: p.initial.pool_c,
        age: p.initial.heater_age,
    }
}
fn locked(p: &Problem, i: usize) -> bool {
    p.accepted.is_some() && p.slots[i].start_seconds < p.locked_through_seconds
}

// Keep interval identity for locking; fresh state starts at capture, never before it.
fn projected_hours(s: &Slot) -> f64 {
    s.hours + s.start_seconds.min(0.0) / 3600.0
}

fn step(p: &Problem, i: usize, command: &Command, state: &mut State) -> Result<Quarter, String> {
    let s = &p.slots[i];
    let hours = projected_hours(s);
    let seconds = hours * 3600.0;
    if command.charge_limit_w < 0.0 || command.discharge_limit_w < 0.0 {
        return Err("negative_native_power_limit".into());
    }
    let (pool_w, heat_w, age) = p.heater.step(command.pool_on, state.age, seconds);
    let nominal_ev = p
        .charger
        .watts(command.ev_amps)
        .ok_or("non_native_ev_command")?;
    let ev_room_w =
        (p.targets.ev_limit_kwh - state.ev).max(0.0) * 1000.0 / hours / p.car.charge_efficiency;
    // Ordinary saturation preserves a committed command. New proposals must be executable.
    if nominal_ev > ev_room_w + 1e-7 && !locked(p, i) {
        return Err("ev_command_beyond_charge_limit".into());
    }
    let ev_w = nominal_ev.min(ev_room_w);
    let demand = s.base_w + pool_w + ev_w - s.solar_w;
    let charge_cap = command
        .charge_limit_w
        .max(0.0)
        .min(p.battery.available_charge_w(state.battery, hours));
    let discharge_cap = command
        .discharge_limit_w
        .max(0.0)
        .min(p.battery.available_discharge_w(state.battery, hours));
    let (charge, discharge) = match command.battery {
        Operation::Hold => (0.0, 0.0),
        Operation::SelfConsumption => (
            (-demand).max(0.0).min(charge_cap),
            demand.max(0.0).min(discharge_cap),
        ),
        Operation::SupplyHouse => (0.0, demand.max(0.0).min(discharge_cap)),
        Operation::GridCharge => (charge_cap.min((p.limits.import_w - demand).max(0.0)), 0.0),
        Operation::Export => {
            if !p.limits.battery_export_enabled
                || s.export_price < p.limits.battery_export_min_price
            {
                return Err("export_without_permission".into());
            }
            let reserve = (state.battery - p.limits.battery_export_reserve_kwh).max(0.0) * 1000.0
                / hours
                * p.battery.discharge_efficiency;
            (
                0.0,
                discharge_cap
                    .min(reserve)
                    .min((p.limits.export_w + demand).max(0.0)),
            )
        }
    };
    let net = demand + charge - discharge;
    if net > p.limits.import_w + 1e-7 || -net > p.limits.export_w + 1e-7 {
        return Err("shared_grid_limit".into());
    }
    let cost = (net.max(0.0) * s.import_price - (-net).max(0.0) * s.export_price) * hours / 1000.0;
    let wear = (charge + discharge) * hours / 1000.0 * p.limits.wear_per_kwh;
    state.pool = p.pool_store.step(state.pool, heat_w, s.outdoor_c, hours);
    state.ev += ev_w * hours / 1000.0 * p.car.charge_efficiency;
    state.battery = p.battery.step(state.battery, charge, discharge, hours);
    state.age = age;
    Ok(Quarter {
        pool_command_w: if command.pool_on {
            p.heater.compressor_w + p.heater.auxiliary_w
        } else {
            0.0
        },
        pool_w,
        ev_w,
        charge_w: charge,
        discharge_w: discharge,
        net_w: net,
        battery_kwh: state.battery,
        ev_kwh: state.ev,
        pool_c: state.pool,
        heater_age: age,
        cost,
        wear,
        spare_battery_cover_w: if charge > 0.0 {
            0.0
        } else {
            (p.battery.discharge_max_w - discharge).max(0.0).min(
                (state.battery - p.battery.min_soc * p.battery.capacity_kwh).max(0.0) * 1000.0
                    / hours
                    * p.battery.discharge_efficiency,
            )
        },
    })
}

fn projection(p: &Problem, commands: &[Command]) -> Result<Vec<Quarter>, String> {
    let mut state = initial(p);
    commands
        .iter()
        .enumerate()
        .map(|(i, c)| step(p, i, c, &mut state))
        .collect()
}

fn eligibility(p: &Problem) -> [usize; 4] {
    let mut reach_pool = p.initial.pool_c;
    let mut reach_ev = p.initial.ev_kwh;
    let mut age = p.initial.heater_age;
    let keys = [
        RuleKey::PoolLow,
        RuleKey::PoolCold,
        RuleKey::EvLow,
        RuleKey::EvShort,
    ];
    let thresholds = keys.map(|key| {
        p.rules
            .iter()
            .find(|r| r.key == key)
            .map_or(0.0, |r| r.threshold)
    });
    let mut due = [usize::MAX; 4];
    for (k, threshold) in thresholds.iter().enumerate() {
        let (start, target) = if k < 2 {
            (reach_pool, p.targets.pool_c)
        } else {
            (measured(reach_ev / p.car.kwh_per_km, 10.0), p.targets.ev_km)
        };
        if start >= target - threshold {
            due[k] = 0;
        }
    }
    for (i, s) in p.slots.iter().enumerate() {
        let hours = projected_hours(s);
        let (_, heat, next) = p.heater.step(true, age, hours * 3600.0);
        age = next;
        reach_pool = p.pool_store.step(reach_pool, heat, s.outdoor_c, hours);
        reach_ev = (reach_ev
            + p.charger.watts(p.charger.max_current_a).unwrap() * hours / 1000.0
                * p.car.charge_efficiency)
            .min(p.targets.ev_limit_kwh.max(p.initial.ev_kwh));
        for (k, threshold) in thresholds.iter().enumerate() {
            let (now, target) = if k < 2 {
                (measured(reach_pool, 100.0), p.targets.pool_c)
            } else {
                (measured(reach_ev / p.car.kwh_per_km, 10.0), p.targets.ev_km)
            };
            if due[k] == usize::MAX && now >= target - threshold {
                due[k] = i + 96;
            }
        }
    }
    due
}

// Match the declared stored measurement precision, without rounding physics.
fn measured(value: f64, scale: f64) -> f64 {
    (value * scale + 0.5).floor() / scale
}
fn account(p: &Problem, q: &[Quarter], due: [usize; 4]) -> Account {
    let first_sale = p
        .rules
        .iter()
        .find(|r| r.key == RuleKey::ArbitrageNotFull)
        .and_then(|r| {
            p.slots
                .iter()
                .position(|s| measured(s.export_price, 10000.0) > r.threshold)
        });
    let prepared = first_sale.is_some_and(|sale| {
        let soc = q[..sale]
            .iter()
            .rev()
            .find(|v| measured(v.charge_w, 10.0) > 0.0)
            .map_or(p.initial.battery_kwh, |v| v.battery_kwh);
        measured(soc / p.battery.capacity_kwh * 100.0, 10.0) >= 100.0
    });
    let mut contributions = Vec::with_capacity(q.len());
    let mut points = 0;
    for (i, v) in q.iter().enumerate() {
        let s = &p.slots[i];
        let pool_w = measured(v.pool_w, 10.0);
        let ev_w = measured(v.ev_w, 10.0);
        let charge = measured(v.charge_w, 10.0);
        let discharge = measured(v.discharge_w, 10.0);
        let pool_c = measured(v.pool_c, 1000.0);
        let ev_km = measured(v.ev_kwh / p.car.kwh_per_km, 10.0);
        let soc = measured(v.battery_kwh / p.battery.capacity_kwh * 100.0, 10.0);
        let imported = measured(v.net_w.max(0.0), 10.0);
        let export = measured((-v.net_w).max(0.0), 10.0);
        let load = measured(s.base_w + v.pool_w + v.ev_w, 10.0);
        let flexible = pool_w + ev_w + charge;
        let house_battery = (discharge - export).max(0.0);
        let flexible_grid = measured((flexible - house_battery).max(0.0).min(imported), 10.0);
        let base_grid = measured(
            (imported - flexible_grid)
                .max(0.0)
                .min((load - pool_w - ev_w).max(0.0)),
            10.0,
        );
        let ev_battery = measured(
            (house_battery - charge - (load - ev_w).max(0.0))
                .max(0.0)
                .min(ev_w),
            10.0,
        );
        let spare = (v.spare_battery_cover_w * 10.0).floor() / 10.0;
        let rule_fires = |r: &Rule| {
            use RuleKey::*;
            let t = r.threshold;
            match r.key {
                PoolLow => i >= due[0] && pool_c < p.targets.pool_c - t,
                PoolCold => i >= due[1] && pool_c < p.targets.pool_c - t,
                PoolHot => pool_c > p.targets.pool_c + t && s.next_day_buffer == Some(false),
                PoolBuffer => pool_c > p.targets.pool_c + t && s.next_day_buffer == Some(true),
                EvLow => i >= due[2] && ev_km < p.targets.ev_km - t,
                EvShort => i >= due[3] && ev_km < p.targets.ev_km - t,
                CheapBuy | CheapestBuy => flexible >= 500.0 && s.cheap_rank < t,
                DearLoad | DearestLoad => flexible_grid >= 500.0 && s.dear_rank < t,
                BaseLoadDearImport | BaseLoadDearestImport => {
                    base_grid >= 500.0 && spare >= base_grid && s.dear_rank < t
                }
                MissedCheapQuarter => {
                    measured(s.import_price, 10000.0) < t
                        && (soc < 100.0 || ev_km < p.targets.ev_km || pool_c < p.targets.pool_c)
                        && charge < 500.0
                        && ev_w < 500.0
                        && pool_w < 500.0
                }
                ArbitrageNoExport => measured(s.export_price, 10000.0) > t && export <= 0.0,
                ArbitrageNotFull => measured(s.export_price, 10000.0) > t && !prepared,
                EvFromHomeBattery => ev_battery > t,
            }
        };
        let fired: Vec<bool> = p.rules.iter().map(rule_fires).collect();
        let active = |key| p.rules.iter().zip(&fired).any(|(r, f)| r.key == key && *f);
        let row: Vec<i32> = p
            .rules
            .iter()
            .zip(&fired)
            .map(|(r, f)| {
                let superseded = match r.key {
                    RuleKey::CheapBuy => active(RuleKey::CheapestBuy),
                    RuleKey::DearLoad => active(RuleKey::DearestLoad),
                    RuleKey::BaseLoadDearImport => active(RuleKey::BaseLoadDearestImport),
                    _ => false,
                };
                if *f && !superseded {
                    r.points
                } else {
                    0
                }
            })
            .collect();
        points += row.iter().sum::<i32>();
        contributions.push(row);
    }
    Account {
        points,
        cash_sek: q.iter().map(|v| v.cost).sum(),
        wear_sek: q.iter().map(|v| v.wear).sum(),
        contributions,
    }
}

fn better(a: &Account, b: &Account) -> bool {
    a.points > b.points
        || a.points == b.points && a.cash_sek + a.wear_sek < b.cash_sek + b.wear_sek - 1e-9
}
fn base_command(p: &Problem) -> Command {
    Command {
        pool_on: false,
        ev_amps: 0,
        battery: Operation::SelfConsumption,
        charge_limit_w: p.battery.charge_max_w,
        discharge_limit_w: p.battery.discharge_max_w,
    }
}

/// Proposal construction is deliberately separate from authoritative selection.
fn construct(p: &Problem, profile: u32) -> Result<Vec<Command>, String> {
    let mut state = initial(p);
    let mut commands = Vec::with_capacity(p.slots.len());
    for (i, s) in p.slots.iter().enumerate() {
        let mut c = base_command(p);
        if locked(p, i) {
            c = p.accepted.as_ref().unwrap()[i].clone();
        } else {
            let buffer = if s.next_day_buffer == Some(true) && profile == 2 {
                2.2
            } else {
                0.0
            };
            let desired = p.targets.pool_c + buffer;
            c.pool_on = state.pool < desired - 0.5 || s.cheap_rank < 0.25 && state.pool < desired;
            let remaining = (p.targets.ev_km * p.car.kwh_per_km - state.ev).max(0.0);
            let ev_w = remaining * 1000.0 / projected_hours(s) / p.car.charge_efficiency;
            if s.cheap_rank < if profile == 0 { 0.5 } else { 0.25 } || s.solar_w > s.base_w + 3000.0
            {
                c.ev_amps = p.charger.fitting_amps(ev_w.min(
                    p.limits.import_w + s.solar_w
                        - s.base_w
                        - if c.pool_on {
                            p.heater.compressor_w + p.heater.auxiliary_w
                        } else {
                            0.0
                        },
                ));
            }
            c.battery = if s.export_price >= p.limits.battery_export_min_price
                && p.limits.battery_export_enabled
                && state.battery > p.limits.battery_export_reserve_kwh
            {
                Operation::Export
            } else if s.cheap_rank < 0.1 && profile != 0 {
                Operation::GridCharge
            } else if s.cheap_rank < 0.5 {
                Operation::Hold
            } else {
                Operation::SelfConsumption
            };
            if s.solar_w > s.base_w {
                c.battery = Operation::SelfConsumption;
                c.discharge_limit_w = 0.0;
            }
            if c.battery == Operation::Hold {
                c.charge_limit_w = 0.0;
                c.discharge_limit_w = 0.0;
            }
        }
        step(p, i, &c, &mut state)?;
        commands.push(c);
    }
    Ok(commands)
}

pub fn solve(p: &Problem) -> Outcome {
    let run = || -> Result<Selection, String> {
        validate(p)?;
        let n = p.slots.len();
        let startup = match &p.heater.response {
            shs_planner_models::Response::Steady => 0,
            shs_planner_models::Response::Bergvarme { startup } => startup.len() * 2,
        };
        let loss = match &p.pool_store.loss {
            shs_planner_models::StandingLoss::Linear { .. } => 0,
            shs_planner_models::StandingLoss::Measured { points } => points.len(),
        };
        let evaluation_work = (n * (64 + startup * 2 + loss + p.rules.len() * 6)) as u64;
        // Charge preparation/construction too, and reserve one complete final certification.
        let mut used = evaluation_work;
        let minimum_evaluations = if p.accepted.is_some() { 3 } else { 4 };
        if p.work_grant < evaluation_work * minimum_evaluations {
            return Err("work_grant_cannot_construct_and_certify".into());
        }
        let due = eligibility(p);
        let mut best: Option<Selection> = None;
        let mut evaluations = 0;
        let evaluate = |commands: Vec<Command>,
                        best: &mut Option<Selection>,
                        used: &mut u64,
                        evaluations: &mut u64| {
            if *used + evaluation_work * 2 > p.work_grant {
                return false;
            }
            *used += evaluation_work;
            *evaluations += 1;
            if let Ok(quarters) = projection(p, &commands) {
                let a = account(p, &quarters, due);
                if best.as_ref().is_none_or(|b| better(&a, &b.account)) {
                    *best = Some(Selection {
                        commands,
                        quarters,
                        account: a,
                        work_used: 0,
                        evaluations: 0,
                        termination: "pass_exhausted",
                    });
                }
            }
            true
        };
        if let Some(seed) = &p.accepted {
            evaluate(seed.clone(), &mut best, &mut used, &mut evaluations);
        }
        for profile in 0..3 {
            // Construction is bounded and explicitly charged before entering it.
            if used + evaluation_work * 3 > p.work_grant {
                break;
            }
            used += evaluation_work;
            if let Ok(commands) = construct(p, profile) {
                evaluate(commands, &mut best, &mut used, &mut evaluations);
            }
        }
        let mut best = best.ok_or("no_complete_candidate")?;
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by(|a, b| {
            p.slots[*a]
                .import_price
                .total_cmp(&p.slots[*b].import_price)
                .then(a.cmp(b))
        });
        let mut exhausted = false;
        'passes: for _ in 0..p.recipe.max_passes {
            let mut improved = false;
            // Move whole coupled command pairs, not just individually winning devices.
            for from in 0..n {
                if locked(p, from) {
                    continue;
                }
                for &to in order.iter().take(n) {
                    if used + evaluation_work * 2 >= p.work_grant {
                        exhausted = true;
                        break 'passes;
                    }
                    used += 1;
                    if to == from
                        || locked(p, to)
                        || p.slots[to].import_price >= p.slots[from].import_price
                    {
                        continue;
                    }
                    for &mask in &p.recipe.coupled_masks {
                        if used + 1 + evaluation_work * 2 > p.work_grant {
                            exhausted = true;
                            break 'passes;
                        }
                        used += 1;
                        let a = &best.commands[from];
                        let b = &best.commands[to];
                        let differs = mask & 1 != 0 && a.pool_on != b.pool_on
                            || mask & 2 != 0 && a.ev_amps != b.ev_amps
                            || mask & 4 != 0
                                && (a.battery != b.battery
                                    || a.charge_limit_w != b.charge_limit_w
                                    || a.discharge_limit_w != b.discharge_limit_w);
                        if !differs {
                            continue;
                        }
                        if used + evaluation_work * 2 > p.work_grant {
                            exhausted = true;
                            break 'passes;
                        }
                        // Charge the whole-vector copy before entering it.
                        used += evaluation_work;
                        let mut commands = best.commands.clone();
                        let a = commands[from].clone();
                        let b = commands[to].clone();
                        if mask & 1 != 0 {
                            commands[from].pool_on = b.pool_on;
                            commands[to].pool_on = a.pool_on;
                        }
                        if mask & 2 != 0 {
                            commands[from].ev_amps = b.ev_amps;
                            commands[to].ev_amps = a.ev_amps;
                        }
                        if mask & 4 != 0 {
                            commands[from].battery = b.battery;
                            commands[to].battery = a.battery;
                            commands[from].charge_limit_w = b.charge_limit_w;
                            commands[to].charge_limit_w = a.charge_limit_w;
                            commands[from].discharge_limit_w = b.discharge_limit_w;
                            commands[to].discharge_limit_w = a.discharge_limit_w;
                        }
                        evaluations += 1;
                        if let Ok(quarters) = projection(p, &commands) {
                            let a = account(p, &quarters, due);
                            if better(&a, &best.account) {
                                best.commands = commands;
                                best.quarters = quarters;
                                best.account = a;
                                improved = true;
                            }
                        }
                    }
                }
            }
            if !improved {
                break;
            }
        }
        used += evaluation_work;
        let certified = projection(p, &best.commands)?;
        let certified_account = account(p, &certified, due);
        if certified_account.points != best.account.points
            || certified_account.cash_sek != best.account.cash_sek
            || certified_account.contributions != best.account.contributions
        {
            return Err("account_parity".into());
        }
        best.quarters = certified;
        best.account = certified_account;
        best.work_used = used;
        best.evaluations = evaluations;
        best.termination = if exhausted {
            "grant_exhausted"
        } else {
            "pass_exhausted"
        };
        Ok(best)
    };
    match run() {
        Ok(selection) => Outcome::Selected { selection },
        Err(issue) => Outcome::Failed { issue },
    }
}

pub fn solve_json(bytes: &[u8]) -> Vec<u8> {
    let result = match serde_json::from_slice::<Problem>(bytes) {
        Ok(p) => solve(&p),
        Err(error) => Outcome::Failed {
            issue: format!("invalid_ready_problem: {error}"),
        },
    };
    serde_json::to_vec(&result).expect("finite typed solver result")
}

// One input allocation and one batch call. Every exported allocation has one owner.
#[no_mangle]
pub extern "C" fn planner_alloc(length: usize) -> *mut u8 {
    Box::into_raw(vec![0_u8; length].into_boxed_slice()) as *mut u8
}
/// # Safety
/// The pointer/length must name one live allocation returned by this module.
#[no_mangle]
pub unsafe extern "C" fn planner_free(pointer: *mut u8, length: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
        pointer, length,
    )));
}
/// # Safety
/// Input must name a live, initialized module allocation. Caller owns both buffers.
#[no_mangle]
pub unsafe extern "C" fn planner_solve(pointer: *const u8, length: usize) -> u64 {
    let output = solve_json(std::slice::from_raw_parts(pointer, length));
    let length = output.len() as u64;
    let pointer = Box::into_raw(output.into_boxed_slice()) as *mut u8 as usize as u64;
    (length << 32) | pointer
}
