//! One complete causal rule-led solve. No persistence, history or external I/O.
mod builder;
mod move_resize;
mod physics;
mod policy;
mod thermal_buffer;
mod witnesses;
use serde::{Deserialize, Serialize};
use shs_planner_models::{
    Battery, CarBattery, Charger, Heater, HeaterStart, HeaterState, ThermalStore,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Slot {
    pub local_month: u8,
    pub start_seconds: f64,
    pub hours: f64,
    pub base_w: f64,
    pub solar_w: f64,
    pub outdoor_c: f64,
    pub import_price: f64,
    pub export_price: f64,
    pub published: bool,
    pub ev_available: bool,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Idle,
    SolarCharge,
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
    pub battery_kwh: Option<f64>,
    pub ev_kwh: Option<f64>,
    pub pool_c: Option<f64>,
    pub heater_state: Option<HeaterState>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Targets {
    pub pool_c: Option<f64>,
    pub ev_km: Option<f64>,
    pub ev_limit_kwh: Option<f64>,
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
    PoolRestart,
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
    LargeLoadOverlap,
    PoolShortGap,
    EvShortGap,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Rule {
    pub key: RuleKey,
    pub threshold: f64,
    pub points: i32,
    pub required: bool,
    pub unless: Option<RuleKey>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ServiceGuard {
    pub pool: [f64; 2],
    pub ev: [f64; 2],
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Recipe {
    pub beam_width: usize,
    pub max_actions: usize,
    pub finalists: usize,
    pub witness_trials: usize,
    pub repair_trials: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Problem {
    pub abi: u32,
    pub pool_cycle_seconds: f64,
    pub work_grant: u64,
    pub recipe: Recipe,
    pub slots: Vec<Slot>,
    pub battery: Option<Battery>,
    pub car: Option<CarBattery>,
    pub charger: Option<Charger>,
    pub pool_store: Option<ThermalStore>,
    pub heater: Option<Heater>,
    pub initial: Initial,
    pub pool_stop_c: Option<f64>,
    pub targets: Targets,
    pub limits: Limits,
    pub rules: Vec<Rule>,
    pub service_guard: ServiceGuard,
    /// None means first-ever plan. A partial accepted prefix is never silently filled.
    pub accepted: Option<Vec<Command>>,
    /// Relative to capture; every intersecting slot remains committed.
    pub locked_through_seconds: f64,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Quarter {
    pub pool_command_w: f64,
    pub pool_w: f64,
    pub pool_compressor_w: f64,
    pub pool_auxiliary_w: f64,
    pub pool_heat_w: f64,
    pub ev_w: f64,
    pub charge_w: f64,
    pub discharge_w: f64,
    pub net_w: f64,
    pub curtailed_w: f64,
    pub battery_kwh: Option<f64>,
    pub ev_kwh: Option<f64>,
    pub pool_c: Option<f64>,
    pub heater_state: Option<HeaterState>,
    pub pool_start: Option<HeaterStart>,
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
    pub witness_coverage: Vec<WitnessCoverage>,
    pub economic: Vec<EconomicHit>,
    pub runs: Vec<RunPurpose>,
    pub work: Work,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Selected { selection: Box<Selection> },
    Failed { issue: String },
}

fn validate(p: &Problem) -> Result<(), String> {
    let bad = |s: &str| Err(s.to_owned());
    if p.abi != 5 || p.slots.is_empty() {
        return bad("unsupported_abi_or_empty_problem");
    }
    if !p.pool_cycle_seconds.is_finite()
        || p.pool_cycle_seconds < 0.0
        || p.slots.iter().any(|s| !(1..=12).contains(&s.local_month))
    {
        return bad("invalid_pool_cycle_or_calendar");
    }
    if p.battery.is_some() != p.initial.battery_kwh.is_some()
        || p.car.is_some() != p.charger.is_some()
        || p.car.is_some() != p.initial.ev_kwh.is_some()
        || p.car.is_some() != p.targets.ev_km.is_some()
        || p.car.is_some() != p.targets.ev_limit_kwh.is_some()
        || p.heater.is_some() != p.pool_store.is_some()
        || p.heater.is_some() != p.initial.pool_c.is_some()
        || p.heater.is_some() != p.initial.heater_state.is_some()
        || p.heater.is_some() != p.targets.pool_c.is_some()
        || p.heater.is_none() && p.pool_stop_c.is_some()
    {
        return bad("inconsistent_device_presence");
    }
    if let Some(b) = &p.battery {
        if b.capacity_kwh <= 0.0
            || b.charge_efficiency <= 0.0
            || b.charge_efficiency > 1.0
            || b.discharge_efficiency <= 0.0
            || b.discharge_efficiency > 1.0
            || b.min_soc < 0.0
            || b.max_soc > 1.0
            || b.min_soc >= b.max_soc
            || b.charge_max_w <= 0.0
            || b.discharge_max_w <= 0.0
        {
            return bad("invalid_model_parameters");
        }
    }
    if let Some(c) = &p.car {
        if c.capacity_kwh <= 0.0
            || c.kwh_per_km <= 0.0
            || c.charge_efficiency <= 0.0
            || c.charge_efficiency > 1.0
        {
            return bad("invalid_model_parameters");
        }
    }
    if let Some(c) = &p.charger {
        if c.min_current_a == 0
            || c.current_step_a == 0
            || c.min_current_a > c.max_current_a
            || c.phase_count == 0
            || c.voltage_v <= 0.0
            || !(c.max_current_a - c.min_current_a).is_multiple_of(c.current_step_a)
        {
            return bad("invalid_charger_commands");
        }
    }
    if let Some(h) = &p.heater {
        if h.compressor_w <= 0.0 || h.heat_w <= 0.0 || h.auxiliary_w < 0.0 {
            return bad("invalid_model_parameters");
        }
        h.validate_response().map_err(str::to_owned)?;
    }
    if matches!(p.initial.heater_state, Some(HeaterState::Running{seconds} | HeaterState::Off{seconds}) if seconds<0.0)
    {
        return bad("invalid_initial_heater_state");
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
    if let Some(store) = &p.pool_store {
        if store.capacity_kwh_per_c <= 0.0 {
            return bad("invalid_model_parameters");
        }
        match &store.loss {
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
    }
    if p.recipe.beam_width == 0 || p.recipe.max_actions < 4 || p.recipe.finalists == 0 {
        return bad("invalid_builder_recipe");
    }
    if p.slots[0].start_seconds > 0.0 || p.slots[0].start_seconds + p.slots[0].hours * 3600.0 <= 0.0
    {
        return bad("missing_capture_interval");
    }
    if p.locked_through_seconds != 0.0 && p.accepted.is_none() {
        return bad("commitment_unavailable");
    }
    if let Some(accepted) = &p.accepted {
        if accepted.len()
            != p.slots
                .iter()
                .take_while(|s| s.start_seconds < p.locked_through_seconds)
                .count()
            || p.locked_through_seconds != 3600.0
            || p.slots.last().unwrap().start_seconds + p.slots.last().unwrap().hours * 3600.0
                < 3600.0
        {
            return bad("commitment_unavailable");
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
pub struct WitnessCoverage {
    pub family: String,
    pub trials: usize,
    pub proven: usize,
    pub quota_exhausted: bool,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EconomicKey {
    ExportBeforeImport,
    BatteryHeadroomSolar,
    PoolSolarPreheat,
    PoolWaitForSun,
    ImportAvoidableByStorage,
    BatteryPriceSpread,
    BatteryPreserve,
    HighValueExport,
    PoolCheaperHeating,
    EvTiming,
    UneconomicCycling,
}
#[derive(Clone, Debug, Serialize)]
pub struct EconomicHit {
    pub published: bool,
    pub rule: EconomicKey,
    pub quarters: Vec<usize>,
    pub saving_sek: f64,
}
#[derive(Clone)]
pub(crate) struct Repair {
    pub commands: Vec<Command>,
    pub family: String,
    pub expected_points: i32,
}
#[derive(Default)]
pub(crate) struct WitnessAudit {
    pub gaps: Vec<[bool; 2]>,
    pub overlap: Vec<bool>,
    pub economic: Vec<EconomicHit>,
    pub repairs: Vec<Repair>,
    pub coverage: Vec<WitnessCoverage>,
}
#[derive(Clone, Debug, Serialize)]
pub struct RunPurpose {
    pub device: &'static str,
    pub from: usize,
    pub to: usize,
    pub purpose: &'static str,
}
#[derive(Clone, Debug, Serialize)]
pub struct Work {
    pub used: u64,
    pub limit: u64,
    pub reserved: u64,
    pub unit_cost: u64,
    pub expansions: u64,
    pub evaluations: u64,
    pub witness_trials: u64,
    pub repairs: u64,
    pub move_resize_trials: u64,
    pub move_resize_passes: u64,
    pub move_resize_improvements: u64,
}
impl Work {
    pub(crate) fn spend(&mut self, amount: u64) -> bool {
        if amount
            > self
                .limit
                .saturating_sub(self.used)
                .saturating_sub(self.reserved)
        {
            return false;
        }
        self.used += amount;
        true
    }
}
pub fn solve(p: &Problem) -> Outcome {
    match builder::solve(p) {
        Ok(selection) => Outcome::Selected {
            selection: Box::new(selection),
        },
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

#[derive(Deserialize)]
pub struct ProjectionInput {
    pub problem: Problem,
    pub commands: Vec<Command>,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectionOutcome {
    Projected { quarters: Vec<Quarter> },
    Failed { issue: String },
}
pub fn project(p: &Problem, commands: &[Command]) -> ProjectionOutcome {
    match validate(p).and_then(|()| physics::project_external(p, commands)) {
        Ok(quarters) => ProjectionOutcome::Projected { quarters },
        Err(issue) => ProjectionOutcome::Failed { issue },
    }
}
pub fn project_json(bytes: &[u8]) -> Vec<u8> {
    let outcome = match serde_json::from_slice::<ProjectionInput>(bytes) {
        Ok(input) => project(&input.problem, &input.commands),
        Err(e) => ProjectionOutcome::Failed {
            issue: format!("invalid_projection: {e}"),
        },
    };
    serde_json::to_vec(&outcome).expect("finite model projection")
}
/// # Safety
/// Input must name a live initialized module allocation. Caller owns both buffers.
#[no_mangle]
pub unsafe extern "C" fn planner_project(pointer: *const u8, length: usize) -> u64 {
    let output = project_json(std::slice::from_raw_parts(pointer, length));
    let length = output.len() as u64;
    let pointer = Box::into_raw(output.into_boxed_slice()) as *mut u8 as usize as u64;
    (length << 32) | pointer
}

#[cfg(test)]
mod live_tests {
    use super::*;
    fn p() -> Problem {
        super::witnesses::tests::problem(8)
    }
    fn command(operation: Operation) -> Command {
        Command {
            pool_on: false,
            ev_amps: 0,
            battery: operation,
            charge_limit_w: 4000.0,
            discharge_limit_w: 4000.0,
        }
    }
    fn projected(p: &Problem, c: Command) -> Vec<Quarter> {
        match project(p, &vec![c; p.slots.len()]) {
            ProjectionOutcome::Projected { quarters } => quarters,
            ProjectionOutcome::Failed { issue } => panic!("{issue}"),
        }
    }
    #[test]
    fn native_operations_keep_solar_permissions() {
        let mut p = p();
        p.slots[0].solar_w = 2000.0;
        for op in [
            Operation::Hold,
            Operation::SolarCharge,
            Operation::SupplyHouse,
            Operation::SelfConsumption,
        ] {
            let q = projected(&p, command(op));
            assert_eq!(q[0].charge_w, 2000.0);
            assert_eq!(q[0].discharge_w, 0.0);
        }
        assert_eq!(projected(&p, command(Operation::Idle))[0].charge_w, 0.0);
        p.slots[0].solar_w = 0.0;
        p.slots[0].base_w = 1000.0;
        assert_eq!(
            projected(&p, command(Operation::SupplyHouse))[0].discharge_w,
            1000.0
        );
        assert_eq!(projected(&p, command(Operation::Hold))[0].discharge_w, 0.0);
    }
    #[test]
    fn all_presence_combinations_solve_without_phantom_devices() {
        for mask in 0..8 {
            let mut p = p();
            if mask & 1 == 0 {
                p.battery = None;
                p.initial.battery_kwh = None;
            }
            if mask & 2 == 0 {
                p.car = None;
                p.charger = None;
                p.initial.ev_kwh = None;
                p.targets.ev_km = None;
                p.targets.ev_limit_kwh = None;
            }
            if mask & 4 == 0 {
                p.heater = None;
                p.pool_store = None;
                p.initial.pool_c = None;
                p.initial.heater_state = None;
                p.targets.pool_c = None;
            }
            p.rules = vec![
                Rule {
                    key: RuleKey::PoolCold,
                    threshold: 2.0,
                    points: -1,
                    required: true,
                    unless: None,
                },
                Rule {
                    key: RuleKey::EvShort,
                    threshold: 100.0,
                    points: -1,
                    required: true,
                    unless: None,
                },
                Rule {
                    key: RuleKey::ArbitrageNotFull,
                    threshold: 1.0,
                    points: -1,
                    required: false,
                    unless: None,
                },
            ];
            p.slots[0].export_price = 2.0;
            let Outcome::Selected { selection } = solve(&p) else {
                panic!("presence mask {mask} failed");
            };
            if mask & 1 == 0 {
                assert_eq!(selection.account.contributions[0][2], 0);
            }
            for q in selection.quarters {
                assert_eq!(q.battery_kwh.is_some(), mask & 1 != 0);
                assert_eq!(q.ev_kwh.is_some(), mask & 2 != 0);
                assert_eq!(q.pool_c.is_some(), mask & 4 != 0);
            }
        }
    }
    #[test]
    fn partial_locked_prefix_preserves_disconnected_amps_and_saturates_fresh_state() {
        let mut p = p();
        for s in &mut p.slots {
            s.start_seconds -= 300.0;
            s.ev_available = false;
        }
        let mut c = command(Operation::Hold);
        c.ev_amps = 16;
        c.pool_on = true;
        p.initial.ev_kwh = Some(60.0);
        p.pool_stop_c = Some(29.0);
        p.accepted = Some(vec![c.clone(); 5]);
        p.locked_through_seconds = 3600.0;
        assert!(validate(&p).is_ok());
        let Outcome::Selected { selection } = solve(&p) else {
            panic!("locked prefix solve failed");
        };
        assert_eq!(selection.commands[..5], vec![c; 5]);
        assert!(selection.quarters[..5]
            .iter()
            .all(|q| q.ev_w == 0.0 && q.pool_w == 0.0));
        p.accepted.as_mut().unwrap().push(command(Operation::Hold));
        assert_eq!(validate(&p), Err("commitment_unavailable".into()));
    }
    #[test]
    fn locked_export_keeps_native_command_when_price_forecast_changes() {
        let mut p = p();
        p.limits.battery_export_min_price = 3.0;
        let c = command(Operation::Export);
        p.accepted = Some(vec![c.clone(); 4]);
        p.locked_through_seconds = 3600.0;
        let Outcome::Selected { selection } = solve(&p) else {
            panic!("locked export lost after forecast change");
        };
        assert_eq!(selection.commands[..4], vec![c; 4]);
        assert!(selection.quarters[0].discharge_w > 0.0);
    }
    #[test]
    fn thermostat_clips_members_and_heat_together_and_surplus_is_curtailed() {
        let mut p = p();
        p.pool_stop_c = Some(30.1);
        let mut c = command(Operation::Idle);
        c.pool_on = true;
        let q = projected(&p, c);
        assert!((q[0].pool_c.unwrap() - 30.1).abs() < 1e-8);
        assert!((q[0].pool_w - q[0].pool_compressor_w - q[0].pool_auxiliary_w).abs() < 1e-8);
        assert!((q[0].pool_heat_w - 4000.0).abs() < 1e-6);
        assert_eq!(q[1].pool_w, 0.0);
        p.slots[0].solar_w = 9000.0;
        let q = projected(&p, command(Operation::Idle));
        assert_eq!(q[0].curtailed_w, 2000.0);
        assert_eq!(q[0].net_w, -7000.0);
    }
}
