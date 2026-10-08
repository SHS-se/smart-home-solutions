//! One complete causal rule-led solve. No persistence, history or external I/O.
mod builder;
mod physics;
mod policy;
mod witnesses;
use serde::{Deserialize, Serialize};
use shs_planner_models::{
    Battery, CarBattery, Charger, Heater, HeaterStart, HeaterState, ThermalStore,
};

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
    pub heater_state: HeaterState,
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
    pub ev_w: f64,
    pub charge_w: f64,
    pub discharge_w: f64,
    pub net_w: f64,
    pub battery_kwh: f64,
    pub ev_kwh: f64,
    pub pool_c: f64,
    pub heater_state: HeaterState,
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
    if p.abi != 3 || p.slots.is_empty() {
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
    if matches!(p.initial.heater_state, HeaterState::Running{seconds} | HeaterState::Off{seconds} if seconds<0.0)
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
    p.heater.validate_response().map_err(str::to_owned)?;
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
