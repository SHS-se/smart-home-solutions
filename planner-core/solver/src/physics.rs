use crate::*;
use shs_planner_models::{PoolConditions, PoolTransition};
mod pool_memo;
use pool_memo::PoolMemo;
#[derive(Clone)]
pub(crate) struct State {
    pub battery: f64,
    pub ev: f64,
    pub pool: f64,
    pub pool_pending_heat_kwh: f64,
    pub pool_source_depletion_kwh: f64,
    pub heater: HeaterState,
    pub charging: crate::charging::Activity,
    /// Quarters of the pool run this plan started, while it is on; None for
    /// one already running when the plan began, which has no run charge.
    pub pool_run_quarters: Option<u32>,
}
use crate::policy::pool_run_charge;
/// The run age a projection continues from: back through the quarters to the
/// planned start of the run still on at the prefix's end.
fn pool_run_age(prefix: &[Quarter]) -> Option<u32> {
    let mut quarters = 0;
    for q in prefix.iter().rev() {
        if q.pool_command_w <= 0.0 {
            return None;
        }
        quarters += 1;
        if q.pool_start.is_some() {
            return Some(quarters);
        }
    }
    None
}
pub(crate) fn initial(p: &Problem) -> State {
    State {
        battery: p.initial.battery_kwh.unwrap_or(0.0),
        ev: p.initial.ev_kwh.unwrap_or(0.0),
        pool: p.initial.pool_c.unwrap_or(0.0),
        pool_pending_heat_kwh: p.initial.pool_pending_heat_kwh.unwrap_or(0.0),
        pool_source_depletion_kwh: p.initial.pool_source_depletion_kwh.unwrap_or(0.0),
        heater: p.initial.heater_state.unwrap_or(HeaterState::OffUnobserved),
        charging: Default::default(),
        pool_run_quarters: None,
    }
}
pub(crate) fn projected_hours(s: &Slot) -> f64 {
    s.hours + s.start_seconds.min(0.0) / 3600.0
}

/// An independently commanded auxiliary keeps drawing when the thermal owner
/// is off. Thermal state and compressor startup remain owned by the pool model.
pub(crate) fn pool_auxiliary_w(s: &Slot, on: bool, coupled_w: f64) -> f64 {
    s.pool_auxiliary_dispatch
        .as_ref()
        .map_or(coupled_w, |dispatch| {
            dispatch.fixed_w + if on { dispatch.on_w } else { 0.0 }
        })
}

/// Energy stays quarter-resolved; permission must also fit the full ON draw.
/// Battery support at this reservation is checked for the whole remaining
/// interval. This is conservative for brief thermostat-limited runs.
pub(crate) struct PoolDemand {
    pub average_w: f64,
    pub reservation_w: f64,
}
pub(crate) fn pool_demand(
    p: &Problem,
    s: &Slot,
    on: bool,
    water_c: f64,
    pool: Option<&PoolTransition>,
) -> PoolDemand {
    let compressor = pool.map_or(0.0, |q| q.compressor_w);
    let auxiliary = pool_auxiliary_w(s, on, pool.map_or(0.0, |q| q.auxiliary_w));
    let active = on && p.pool_stop_c.is_none_or(|stop| water_c < stop);
    let full = p.heater.as_ref().map_or(0.0, |heater| {
        if active {
            heater.full_compressor_w()
        } else {
            0.0
        }
    });
    let full_auxiliary = pool_auxiliary_w(
        s,
        on,
        if active {
            p.heater.as_ref().map_or(0.0, |heater| heater.auxiliary_w)
        } else {
            0.0
        },
    );
    PoolDemand {
        average_w: compressor + auxiliary,
        reservation_w: full + full_auxiliary,
    }
}

fn transition(
    p: &Problem,
    i: usize,
    command: &Command,
    state: &mut State,
    external: bool,
    pool_step: impl FnOnce(&Heater, &ThermalStore, HeaterState, bool, PoolConditions) -> PoolTransition,
) -> Result<Quarter, String> {
    if !external && !commitments::hold(p, i).admits(command) {
        return Err("commitment_changed".into());
    }
    if !commitments::available_command(p, i, command) {
        return Err("owner_unavailable".into());
    }
    let s = &p.slots[i];
    let hours = projected_hours(s);
    let seconds = hours * 3600.0;
    if command.charge_limit_w < 0.0 || command.discharge_limit_w < 0.0 {
        return Err("negative_native_power_limit".into());
    }
    if p.heater.is_none() && command.pool_on
        || p.car.is_none() && command.ev_amps != 0
        || p.battery.is_none()
            && (command.battery != Operation::Idle
                || command.charge_limit_w != 0.0
                || command.discharge_limit_w != 0.0)
    {
        return Err("command_for_absent_device".into());
    }
    let pool = p
        .heater
        .as_ref()
        .zip(p.pool_store.as_ref())
        .map(|(heater, store)| {
            pool_step(
                heater,
                store,
                state.heater,
                command.pool_on,
                shs_planner_models::PoolConditions {
                    source_depletion_kwh: state.pool_source_depletion_kwh,
                    water_c: state.pool,
                    pending_heat_kwh: state.pool_pending_heat_kwh,
                    outdoor_c: s.outdoor_c,
                    seconds,
                    stop_c: p.pool_stop_c,
                },
            )
        });
    let pool_auxiliary_w = pool_auxiliary_w(
        s,
        command.pool_on,
        pool.as_ref().map_or(0.0, |h| h.auxiliary_w),
    );
    let pool_demand = pool_demand(p, s, command.pool_on, state.pool, pool.as_ref());
    let pool_w = pool_demand.average_w;
    let ev_w = if let Some((car, charger)) = p.car.as_ref().zip(p.charger.as_ref()) {
        let nominal = charger
            .watts(command.ev_amps)
            .ok_or("non_native_ev_command")?;
        if !s.ev_available
            && command.ev_amps != 0
            && !commitments::hold(p, i).has(commitments::Owner::Ev)
            && !external
        {
            return Err("ev_unavailable".into());
        }
        let room = (p.targets.ev_limit_kwh.unwrap() - state.ev).max(0.0) * 1000.0
            / hours
            / car.charge_efficiency;
        if nominal > room + 1e-7
            && !commitments::hold(p, i).has(commitments::Owner::Ev)
            && !external
        {
            return Err("ev_command_beyond_charge_limit".into());
        }
        if s.ev_available {
            nominal.min(room)
        } else {
            0.0
        }
    } else {
        0.0
    };
    let load = BatteryLoad {
        gross_w: s.base_w + pool_w + ev_w,
        solar_w: s.solar_w,
        ev_w: ev_w + s.base_ev_w,
    };
    let demand = load.net_w();
    if command.battery == Operation::Export
        && p.battery.is_some()
        && (s.battery_export_allowed == Some(false)
            || !p.limits.battery_export_enabled
            || (!external
                && !commitments::hold(p, i).has(commitments::Owner::Battery)
                && s.export_price < p.limits.battery_export_min_price))
    {
        return Err("export_without_permission".into());
    }
    let (charge, discharge) = battery_flows(p, command, load, state.battery, hours);
    let (net, curtailed_w) = grid_flow(p, demand, s.solar_w, charge, discharge);
    // An imperfect uncontrollable-load forecast cannot make the home
    // unplannable. Keep the excess visible; no added command may worsen it.
    let unavoidable_import = (s.base_w - s.solar_w).max(0.0);
    if !within_grid(p, net) && !(net >= 0.0 && net <= unavoidable_import + 1e-7) {
        return Err("shared_grid_limit".into());
    }
    let held_battery = commitments::hold(p, i).has(commitments::Owner::Battery);
    let admission_ev_w = if s.ev_available && ev_w > 0.0 {
        p.charger
            .as_ref()
            .and_then(|charger| charger.watts(command.ev_amps))
            .unwrap_or(0.0)
    } else {
        0.0
    };
    let fixed_charge = if command.battery == Operation::GridCharge && held_battery {
        command.charge_limit_w.min(
            p.battery
                .as_ref()
                .map_or(0.0, |battery| battery.charge_max_w),
        )
    } else {
        charge
    };
    if pool_demand.reservation_w > pool_w + 1e-7
        || admission_ev_w > ev_w + 1e-7
        || fixed_charge > charge + 1e-7
    {
        let reservation = BatteryLoad {
            gross_w: s.base_w + pool_demand.reservation_w + admission_ev_w,
            solar_w: s.solar_w,
            ev_w: admission_ev_w + s.base_ev_w,
        };
        let (reserved_charge, reserved_discharge) =
            battery_flows(p, command, reservation, state.battery, hours);
        // Published grid-charge is a fixed figure, not a peak-time reduction.
        let reserved_charge = if command.battery == Operation::GridCharge {
            fixed_charge
        } else {
            reserved_charge
        };
        // Export is published as a fixed allocation. Only automatic house
        // supply may increase its discharge when pool demand rises.
        let reserved_discharge = if command.battery == Operation::Export && !held_battery {
            reserved_discharge.min(discharge.floor())
        } else {
            reserved_discharge
        };
        let (reserved_net, _) = grid_flow(
            p,
            reservation.net_w(),
            s.solar_w,
            reserved_charge,
            reserved_discharge,
        );
        if !within_grid(p, reserved_net)
            && !(reserved_net >= 0.0 && reserved_net <= unavoidable_import + 1e-7)
        {
            return Err("shared_grid_limit".into());
        }
    }
    let cost = grid_cost(s, net, hours);
    // Battery throughput and heater starts are modelled wear, not meter cash.
    let wear = discharge * hours / 1000.0 * p.limits.wear_per_kwh
        + if pool.as_ref().is_some_and(|h| h.start.is_some()) {
            p.limits.pool_start_cost_sek
        } else {
            0.0
        };
    let charging = crate::charging::Activity::observed(command, ev_w, charge);
    let started = pool.as_ref().is_some_and(|h| h.start.is_some());
    let run_quarters = if !command.pool_on {
        None
    } else if started {
        Some(1)
    } else {
        state.pool_run_quarters.map(|k| k + 1)
    };
    // A run ends when it is switched off or restarts; one still on at the
    // horizon is charged for the length it has there. The charge is part of
    // pricing starts: a problem that prices none has none.
    let ended = if p.limits.pool_start_cost_sek <= 0.0 {
        0.0
    } else {
        state
            .pool_run_quarters
            .filter(|_| run_quarters.is_none() || started)
            .map_or(0.0, pool_run_charge)
            + run_quarters
                .filter(|_| i + 1 == p.slots.len())
                .map_or(0.0, pool_run_charge)
    };
    let continuity = charging.cost_from(state.charging, &p.limits) + ended;
    state.charging = charging;
    state.pool_run_quarters = run_quarters;
    if let Some(h) = &pool {
        state.pool = h.water_c;
        state.pool_pending_heat_kwh = h.pending_heat_kwh;
        state.pool_source_depletion_kwh = h.source_depletion_kwh;
        state.heater = h.next;
    }
    if let Some(car) = &p.car {
        state.ev += ev_w * hours / 1000.0 * car.charge_efficiency;
    }
    if let Some(battery) = &p.battery {
        state.battery = battery.step(state.battery, charge, discharge, hours);
    }
    Ok(Quarter {
        pool_command_w: if command.pool_on {
            p.heater
                .as_ref()
                .map_or(0.0, |h| h.compressor_w + h.auxiliary_w)
        } else {
            0.0
        },
        pool_w,
        pool_compressor_w: pool.as_ref().map_or(0.0, |h| h.compressor_w),
        pool_auxiliary_w,
        pool_heat_w: pool.as_ref().map_or(0.0, |h| h.heat_w),
        ev_w,
        charge_w: charge,
        discharge_w: discharge,
        net_w: net,
        curtailed_w,
        battery_kwh: p.battery.as_ref().map(|_| state.battery),
        ev_kwh: p.car.as_ref().map(|_| state.ev),
        pool_c: p.heater.as_ref().map(|_| state.pool),
        pool_pending_heat_kwh: p.heater.as_ref().map(|_| state.pool_pending_heat_kwh),
        pool_source_depletion_kwh: p
            .heater
            .as_ref()
            .and_then(|h| h.source.map(|_| state.pool_source_depletion_kwh)),
        heater_state: p.heater.as_ref().map(|_| state.heater),
        pool_start: pool.and_then(|h| h.start),
        cost,
        wear,
        continuity,
    })
}
/// Reconciled AC household consumption and its EV member. Source permissions
/// use proportional self-consumed PV, matching the canonical battery-supply.ts.
#[derive(Clone, Copy)]
pub(crate) struct BatteryLoad {
    pub gross_w: f64,
    pub solar_w: f64,
    pub ev_w: f64,
}
impl BatteryLoad {
    pub(crate) fn net_w(self) -> f64 {
        self.gross_w - self.solar_w
    }
    pub(crate) fn house_supply_bound(self, p: &Problem) -> f64 {
        let eligible = if p.ev_battery_supply_allowed {
            self.gross_w
        } else {
            (self.gross_w - self.ev_w).max(0.0)
        };
        let pv = if self.gross_w > 0.0 {
            self.solar_w.min(self.gross_w) * eligible / self.gross_w
        } else {
            0.0
        };
        (eligible - pv).min(self.net_w()).max(0.0)
    }
    /// Forced export cannot evade household-supply eligibility on a shared bus.
    pub(crate) fn discharge_bound(self, p: &Problem, export: bool) -> f64 {
        let house = self.house_supply_bound(p);
        if export && (p.ev_battery_supply_allowed || self.ev_w == 0.0 || self.net_w() <= 0.0) {
            (p.limits.export_w + self.net_w()).max(0.0)
        } else {
            house
        }
    }
}

/// What the battery does in a quarter for a house asking `demand` W of it and
/// the grid. Grid charges and sales use the command's native power limits.
pub(crate) fn battery_flows(
    p: &Problem,
    command: &Command,
    load: BatteryLoad,
    battery_kwh: f64,
    hours: f64,
) -> (f64, f64) {
    let Some(battery) = &p.battery else {
        return (0.0, 0.0);
    };
    let demand = load.net_w();
    let room = battery.available_charge_w(battery_kwh, hours);
    let stored = battery.available_discharge_w(battery_kwh, hours);
    let charge_cap = command.charge_limit_w.min(room);
    let discharge_cap = command.discharge_limit_w.min(stored);
    let solar = (-demand).max(0.0).min(charge_cap);
    match command.battery {
        Operation::Idle => (0.0, 0.0),
        Operation::Hold | Operation::SolarCharge => (solar, 0.0),
        Operation::SelfConsumption => (solar, load.house_supply_bound(p).min(discharge_cap)),
        // The same law HA applies: a fixed figure, raised to keep import at
        // the limit, and peak shaving that supplies only the excess.
        Operation::SupplyHouse => {
            let need = (demand - p.limits.import_w).max(0.0).min(stored);
            (
                solar,
                load.house_supply_bound(p).min(discharge_cap.max(need)),
            )
        }
        Operation::ShaveImport => {
            let need = (demand - p.limits.import_w).max(0.0);
            (
                solar,
                load.house_supply_bound(p).min(discharge_cap).min(need),
            )
        }
        Operation::GridCharge => (charge_cap.min((p.limits.import_w - demand).max(0.0)), 0.0),
        Operation::Export => {
            let reserve = (battery_kwh - p.limits.battery_export_reserve_kwh).max(0.0) * 1000.0
                / hours
                * battery.discharge_efficiency;
            (
                0.0,
                discharge_cap
                    .min(reserve)
                    .min(load.discharge_bound(p, true)),
            )
        }
    }
}
fn grid_cost(s: &Slot, net: f64, hours: f64) -> f64 {
    (net.max(0.0) * s.import_price - (-net).max(0.0) * s.export_price) * hours / 1000.0
}
fn grid_flow(p: &Problem, demand: f64, solar: f64, charge: f64, discharge: f64) -> (f64, f64) {
    let physical_net = demand + charge - discharge;
    let curtailed = (-physical_net - p.limits.export_w).max(0.0).min(solar);
    (physical_net + curtailed, curtailed)
}
pub(crate) fn within_grid(p: &Problem, net: f64) -> bool {
    net <= p.limits.import_w + 1e-7 && -net <= p.limits.export_w + 1e-7
}

/// The battery and the grid in one quarter of a carried plan.
pub(crate) struct CarriedQuarter {
    pub charge: f64,
    pub discharge: f64,
    pub net: f64,
    // Retain the separate flow for native parity diagnostics.
    #[cfg(test)]
    pub curtailed: f64,
    /// Grid cost and battery wear.
    pub cost: f64,
    pub battery_kwh: f64,
}
/// Conditional battery/grid projection for the supplied appliance demand.
pub(crate) fn carry(
    p: &Problem,
    s: &Slot,
    command: &Command,
    load: BatteryLoad,
    battery_kwh: f64,
) -> CarriedQuarter {
    let hours = projected_hours(s);
    let (charge, discharge) = battery_flows(p, command, load, battery_kwh, hours);
    let (net, _curtailed) = grid_flow(p, load.net_w(), load.solar_w, charge, discharge);
    CarriedQuarter {
        charge,
        discharge,
        net,
        #[cfg(test)]
        curtailed: _curtailed,
        cost: grid_cost(s, net, hours) + discharge * hours / 1000.0 * p.limits.wear_per_kwh,
        battery_kwh: p.battery.as_ref().map_or(battery_kwh, |battery| {
            battery.step(battery_kwh, charge, discharge, hours)
        }),
    }
}
#[cfg(test)]
pub(crate) fn projection(p: &Problem, commands: &[Command]) -> Result<Vec<Quarter>, String> {
    projection_prefix(p, commands, &[], |_, h, s, state, on, conditions| {
        h.pool_transition(s, state, on, conditions)
    })
}
fn projection_prefix(
    p: &Problem,
    commands: &[Command],
    prefix: &[Quarter],
    mut pool_step: impl FnMut(
        usize,
        &Heater,
        &ThermalStore,
        HeaterState,
        bool,
        PoolConditions,
    ) -> PoolTransition,
) -> Result<Vec<Quarter>, String> {
    if commands.len() != p.slots.len() {
        return Err("projection_coverage".into());
    }
    let mut state = prefix.last().map_or_else(
        || initial(p),
        |q| State {
            battery: q.battery_kwh.unwrap_or(0.0),
            ev: q.ev_kwh.unwrap_or(0.0),
            pool: q.pool_c.unwrap_or(0.0),
            pool_pending_heat_kwh: q.pool_pending_heat_kwh.unwrap_or(0.0),
            pool_source_depletion_kwh: q.pool_source_depletion_kwh.unwrap_or(0.0),
            heater: q.heater_state.unwrap_or(HeaterState::OffUnobserved),
            charging: crate::charging::Activity::observed(
                &commands[prefix.len() - 1],
                q.ev_w,
                q.charge_w,
            ),
            pool_run_quarters: pool_run_age(prefix),
        },
    );
    let mut quarters = Vec::with_capacity(commands.len());
    quarters.extend_from_slice(prefix);
    for (i, c) in commands.iter().enumerate().skip(prefix.len()) {
        quarters.push(transition(
            p,
            i,
            c,
            &mut state,
            false,
            |h, s, state, on, conditions| pool_step(i, h, s, state, on, conditions),
        )?);
    }
    Ok(quarters)
}

/// Count whole-vector reconstruction, physical/model transitions and buffer allocation.
pub(crate) fn project_metered(
    p: &Problem,
    commands: &[Command],
    work: &mut Work,
) -> Option<Vec<Quarter>> {
    project_metered_prefix(p, commands, work, &[])
}
/// The prefix was already projected from this problem with identical commands.
/// Charge the same complete evaluation to keep search budgets and ordering unchanged.
pub(crate) fn project_metered_prefix(
    p: &Problem,
    commands: &[Command],
    work: &mut Work,
    prefix: &[Quarter],
) -> Option<Vec<Quarter>> {
    if !meter_projection(p, work) {
        return None;
    }
    projection_prefix(p, commands, prefix, |_, h, s, state, on, conditions| {
        h.pool_transition(s, state, on, conditions)
    })
    .ok()
}

fn meter_projection(p: &Problem, work: &mut Work) -> bool {
    if !work.spend(p.slots.len() as u64 * work.unit_cost * 2) {
        return false;
    }
    work.evaluations += 1;
    true
}

/// One immutable full or masked problem owns an exact thermal memo. Candidate
/// guidance and refinement share this implementation; independent certification
/// and execution continue through the direct model.
pub(crate) struct Projector<'p> {
    problem: &'p Problem,
    pool: Option<PoolMemo<'p>>,
}
impl<'p> Projector<'p> {
    pub(crate) fn new(problem: &'p Problem) -> Self {
        Self {
            problem,
            pool: problem
                .heater
                .as_ref()
                .zip(problem.pool_store.as_ref())
                .map(|(heater, store)| PoolMemo::new(heater, store)),
        }
    }
    pub(crate) fn step(
        &mut self,
        i: usize,
        command: &Command,
        state: &mut State,
    ) -> Result<Quarter, String> {
        let pool = &mut self.pool;
        transition(
            self.problem,
            i,
            command,
            state,
            false,
            |_, _, state, on, conditions| {
                pool.as_mut()
                    .expect("projector owns the pool model")
                    .transition(state, on, conditions)
            },
        )
    }
    #[cfg(test)]
    pub(crate) fn thermal_hits(&self) -> usize {
        self.pool.as_ref().map_or(0, PoolMemo::hits)
    }
    pub(crate) fn project_metered_prefix(
        &mut self,
        commands: &[Command],
        work: &mut Work,
        prefix: &[Quarter],
    ) -> Option<Vec<Quarter>> {
        if !meter_projection(self.problem, work) {
            return None;
        }
        let pool = &mut self.pool;
        projection_prefix(
            self.problem,
            commands,
            prefix,
            |_, _, _, state, on, conditions| {
                pool.as_mut()
                    .expect("projector owns the pool model")
                    .transition(state, on, conditions)
            },
        )
        .ok()
    }
}

#[cfg(test)]
pub(crate) fn step(
    p: &Problem,
    i: usize,
    command: &Command,
    state: &mut State,
) -> Result<Quarter, String> {
    transition(p, i, command, state, false, Heater::pool_transition)
}
pub(crate) fn project_external(p: &Problem, commands: &[Command]) -> Result<Vec<Quarter>, String> {
    if commands.len() != p.slots.len() {
        return Err("projection_coverage".into());
    }
    let mut state = initial(p);
    commands
        .iter()
        .enumerate()
        .map(|(i, c)| transition(p, i, c, &mut state, true, Heater::pool_transition))
        .collect()
}

#[cfg(test)]
mod refinement_tests {
    use super::*;
    use shs_planner_models::{LossPoint, Response, StandingLoss, StartupPoint};

    fn work() -> Work {
        Work {
            used: 0,
            limit: 1_520_000_000,
            reserved: 0,
            unit_cost: 128,
            expansions: 0,
            evaluations: 0,
            witness_trials: 0,
            repairs: 0,
            move_resize_trials: 0,
            move_resize_passes: 0,
            move_resize_improvements: 0,
        }
    }

    #[test]
    fn repeated_intervals_reuse_physics_while_prices_and_partial_quarters_stay_independent() {
        let mut p = crate::witnesses::tests::problem(128);
        p.pool_store.as_mut().unwrap().response_time_constant_h = 0.675;
        p.initial.pool_pending_heat_kwh = Some(0.5);
        p.slots[0].start_seconds = -300.0;
        for (i, slot) in p.slots.iter_mut().enumerate() {
            slot.outdoor_c = 10.0 + (i % 3) as f64;
            slot.base_w = 500.0;
            slot.import_price = 1.0 + i as f64 / 100.0;
        }
        let mut projector = Projector::new(&p);
        let mut receipts = Vec::new();
        for i in 0..p.slots.len() {
            let command = Command {
                pool_on: i % 2 == 0,
                ev_amps: 0,
                battery: Operation::Hold,
                charge_limit_w: 1000.0,
                discharge_limit_w: 0.0,
            };
            let mut direct = initial(&p);
            let mut cached = direct.clone();
            let expected = step(&p, i, &command, &mut direct).unwrap();
            let actual = projector.step(i, &command, &mut cached).unwrap();
            assert_eq!(
                serde_json::to_vec(&actual).unwrap(),
                serde_json::to_vec(&expected).unwrap()
            );
            receipts.push(actual);
        }
        assert_eq!(projector.thermal_hits(), 121);
        assert_ne!(receipts[1].cost, receipts[7].cost);
    }

    #[test]
    fn reservoir_survives_shutdown_and_projection_prefix_reuse() {
        for source in [
            None,
            Some(shs_planner_models::SourceModel {
                recovery_rate_per_h: 0.15,
                heat_loss_per_kwh: 0.02,
            }),
        ] {
            let mut p = crate::witnesses::tests::problem(6);
            p.heater.as_mut().unwrap().source = source;
            p.initial.pool_source_depletion_kwh = source.map(|_| 9.0);
            let store = p.pool_store.as_mut().unwrap();
            store.capacity_kwh_per_c = 5.0;
            store.response_time_constant_h = 2.0;
            store.loss = StandingLoss::Linear {
                kw_per_c: 0.0,
                surroundings_c: None,
            };
            p.initial.pool_pending_heat_kwh = Some(3.0);
            let commands: Vec<_> = (0..6)
                .map(|i| Command {
                    pool_on: i == 0,
                    ev_amps: 0,
                    battery: Operation::Hold,
                    charge_limit_w: 1000.0,
                    discharge_limit_w: 0.0,
                })
                .collect();
            let direct = projection(&p, &commands).unwrap();
            assert!(direct[0].pool_pending_heat_kwh.unwrap() > 3.0);
            assert_eq!(direct[1].pool_heat_w, 0.0);
            assert!(direct[1].pool_c.unwrap() > direct[0].pool_c.unwrap());
            assert!(
                direct[1].pool_pending_heat_kwh.unwrap() < direct[0].pool_pending_heat_kwh.unwrap()
            );
            for prefix in [1, 3, 5] {
                let resumed = projection_prefix(
                    &p,
                    &commands,
                    &direct[..prefix],
                    |_, h, s, state, on, conditions| h.pool_transition(s, state, on, conditions),
                )
                .unwrap();
                assert_eq!(resumed, direct);
            }
        }
    }

    #[test]
    fn memo_matches_direct_projection_bits_work_and_failures_across_models() {
        for startup in [false, true] {
            for measured in [false, true] {
                for state in [
                    HeaterState::OffUnobserved,
                    HeaterState::Off { seconds: -0.0 },
                    HeaterState::Running { seconds: 450.0 },
                    HeaterState::Steady,
                ] {
                    let mut p = crate::witnesses::tests::problem(16);
                    p.initial.pool_c = Some(29.99);
                    p.initial.heater_state = Some(state);
                    p.pool_stop_c = Some(30.1);
                    p.slots[0].start_seconds = -123.45;
                    p.pool_store.as_mut().unwrap().capacity_kwh_per_c = 5.0;
                    if measured {
                        p.pool_store.as_mut().unwrap().loss = StandingLoss::Measured {
                            points: vec![
                                LossPoint {
                                    at_c: 25.0,
                                    c_per_h: -0.1,
                                },
                                LossPoint {
                                    at_c: 35.0,
                                    c_per_h: -0.3,
                                },
                            ],
                        };
                    }
                    if startup {
                        p.heater.as_mut().unwrap().response = Response::Bergvarme {
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
                    }
                    let commands: Vec<_> = (0..16)
                        .map(|i| Command {
                            pool_on: i % 5 != 3,
                            ev_amps: 0,
                            battery: Operation::Hold,
                            charge_limit_w: 1000.0,
                            discharge_limit_w: 0.0,
                        })
                        .collect();
                    p.accepted = Some(commands[..4].to_vec());
                    p.locked_through_seconds = 3600.0;
                    let mut projector = Projector::new(&p);
                    let mut direct_work = work();
                    let mut memo_work = work();
                    for attempt in 0..3 {
                        let mut changed = commands.clone();
                        if attempt == 2 {
                            changed[7].ev_amps = 6;
                            changed[8].battery = Operation::SelfConsumption;
                            changed[8].discharge_limit_w = 1000.0;
                        }
                        let direct =
                            project_metered_prefix(&p, &changed, &mut direct_work, &[]).unwrap();
                        let memo = projector
                            .project_metered_prefix(&changed, &mut memo_work, &[])
                            .unwrap();
                        assert_eq!(
                            serde_json::to_vec(&memo).unwrap(),
                            serde_json::to_vec(&direct).unwrap()
                        );
                        assert_eq!(direct_work.used, memo_work.used);
                        assert_eq!(direct_work.evaluations, memo_work.evaluations);
                    }
                    assert!(projector.thermal_hits() > 0);
                    let mut invalid = commands;
                    invalid[0].pool_on = !invalid[0].pool_on;
                    assert!(project_metered_prefix(&p, &invalid, &mut direct_work, &[]).is_none());
                    assert!(projector
                        .project_metered_prefix(&invalid, &mut memo_work, &[])
                        .is_none());
                    direct_work.limit = direct_work.used;
                    memo_work.limit = memo_work.used;
                    assert!(project_metered_prefix(&p, &invalid, &mut direct_work, &[]).is_none());
                    assert!(projector
                        .project_metered_prefix(&invalid, &mut memo_work, &[])
                        .is_none());
                    assert_eq!(direct_work.used, memo_work.used);
                    assert_eq!(direct_work.evaluations, memo_work.evaluations);
                }
            }
        }
    }
}

#[cfg(test)]
mod startup_cost_tests {
    use super::*;
    fn command(on: bool) -> Command {
        Command {
            pool_on: on,
            ev_amps: 0,
            battery: Operation::Idle,
            charge_limit_w: 0.0,
            discharge_limit_w: 0.0,
        }
    }
    #[test]
    fn a_short_pool_run_pays_its_run_charge_when_it_ends() {
        assert_eq!(
            [1, 4, 5, 6, 7, 8, 11, 20].map(pool_run_charge),
            [7.0, 7.0, 6.0, 5.0, 4.0, 3.0, 0.0, 0.0]
        );
        let mut p = crate::witnesses::tests::problem(16);
        p.limits.pool_start_cost_sek = 3.0;
        // A two-quarter run, then a six-quarter run still on at the horizon.
        let on = [2, 3, 10, 11, 12, 13, 14, 15];
        let commands: Vec<_> = (0..16).map(|i| command(on.contains(&i))).collect();
        let q = projection(&p, &commands).unwrap();
        let charged: Vec<_> = q.iter().map(|q| q.continuity).collect();
        let mut expected = vec![0.0; 16];
        expected[4] = 7.0;
        expected[15] = 5.0;
        assert_eq!(charged, expected);
        // A projection continuing a prefix carries the run's age.
        for cut in 1..16 {
            let resumed = projection_prefix(&p, &commands, &q[..cut], |_, h, s, state, on, c| {
                h.pool_transition(s, state, on, c)
            })
            .unwrap();
            assert_eq!(resumed, q, "cut {cut}");
        }
    }
    #[test]
    fn wear_charges_actual_starts_once_and_preserves_electricity_and_heat() {
        let mut p = crate::witnesses::tests::problem(8);
        let commands: Vec<_> = [true, true, false, true, true, false, false, true]
            .into_iter()
            .map(command)
            .collect();
        let before = projection(&p, &commands).unwrap();
        p.limits.pool_start_cost_sek = 3.0;
        let after = projection(&p, &commands).unwrap();
        assert_eq!(after.iter().filter(|q| q.pool_start.is_some()).count(), 3);
        for (a, b) in after.iter().zip(&before) {
            assert_eq!(
                a.wear - b.wear,
                if a.pool_start.is_some() { 3.0 } else { 0.0 }
            );
            assert_eq!(a.cost, b.cost);
            assert_eq!(a.pool_c, b.pool_c);
            assert_eq!(a.pool_w, b.pool_w);
        }
    }
    #[test]
    fn a_running_heater_continues_without_another_start_charge() {
        for state in [HeaterState::Steady, HeaterState::Running { seconds: 300.0 }] {
            let mut p = crate::witnesses::tests::problem(4);
            p.initial.heater_state = Some(state);
            p.limits.pool_start_cost_sek = 3.0;
            let q = projection(&p, &vec![command(true); 4]).unwrap();
            assert!(q.iter().all(|q| q.wear == 0.0 && q.pool_start.is_none()));
        }
    }
    #[test]
    fn partial_first_interval_pays_one_start_not_a_prorated_charge() {
        let mut p = crate::witnesses::tests::problem(4);
        p.slots[0].start_seconds = -600.0;
        p.limits.pool_start_cost_sek = 3.0;
        let q = projection(&p, &vec![command(true); 4]).unwrap();
        assert_eq!(q[0].wear, 3.0);
        assert_eq!(q[1].wear, 0.0);
    }
}

#[cfg(test)]
mod supply_permission_tests {
    use super::*;

    fn command(operation: Operation) -> Command {
        Command {
            pool_on: false,
            ev_amps: 6,
            battery: operation,
            charge_limit_w: 4000.0,
            discharge_limit_w: 4000.0,
        }
    }

    #[test]
    fn all_native_operations_respect_proportional_ev_exclusion_and_explicit_permission() {
        let mut p = crate::witnesses::tests::problem(1);
        p.slots[0].base_w = 1000.0;
        let ev_w = 1380.0;
        for allowed in [false, true] {
            p.ev_battery_supply_allowed = allowed;
            for pv in [0.0, 1190.0, 1234.567891, 2380.0, 4000.0] {
                p.slots[0].solar_w = pv;
                let expected = if allowed {
                    (2380.0_f64 - pv).max(0.0)
                } else {
                    1000.0 * (1.0 - (pv / 2380.0).min(1.0))
                };
                for operation in [
                    Operation::Idle,
                    Operation::Hold,
                    Operation::SolarCharge,
                    Operation::GridCharge,
                    Operation::SelfConsumption,
                    Operation::SupplyHouse,
                    Operation::Export,
                ] {
                    let q = projection(&p, &[command(operation)]).unwrap().remove(0);
                    let house_supply = (q.discharge_w - (-q.net_w).max(0.0)).max(0.0);
                    assert!(
                        house_supply <= expected + 1e-8,
                        "{operation:?}, permission {allowed}, PV {pv}: {house_supply} > {expected}"
                    );
                    assert_eq!(q.ev_w, ev_w);
                    if matches!(
                        operation,
                        Operation::SelfConsumption | Operation::SupplyHouse
                    ) {
                        assert!((q.discharge_w - expected).abs() < 1e-8);
                    }
                    if operation == Operation::Export && allowed {
                        assert_eq!(
                            q.discharge_w, 4000.0,
                            "whole-house eligibility permits the separately authorized export"
                        );
                    }
                    if operation == Operation::Export && pv >= 2380.0 {
                        assert!(
                            q.discharge_w > 0.0,
                            "EV supplied by PV does not prohibit permitted export"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn stated_supply_laws_defend_the_house_import_limit() {
        let mut p = crate::witnesses::tests::problem(1);
        p.initial.battery_kwh = Some(10.0);
        let discharge = |p: &Problem, operation, limit: f64, base: f64| {
            let mut p = p.clone();
            p.slots[0].base_w = base;
            let mut c = command(operation);
            c.ev_amps = 0;
            c.discharge_limit_w = limit;
            projection(&p, &[c]).unwrap()[0].discharge_w
        };
        let limit = p.limits.import_w;
        // Peak shaving supplies only demand above the limit.
        assert!(
            (discharge(&p, Operation::ShaveImport, 4000.0, limit + 1500.0) - 1500.0).abs() < 1e-8
        );
        assert_eq!(
            discharge(&p, Operation::ShaveImport, 4000.0, limit - 500.0),
            0.0
        );
        // A fixed figure stands, and rises to keep import at the limit.
        assert!(
            (discharge(&p, Operation::SupplyHouse, 500.0, limit + 1500.0) - 1500.0).abs() < 1e-8
        );
        assert!((discharge(&p, Operation::SupplyHouse, 500.0, limit + 200.0) - 500.0).abs() < 1e-8);
        // Following demand supplies all of it.
        assert!((discharge(&p, Operation::SelfConsumption, 4000.0, 3000.0) - 3000.0).abs() < 1e-8);
    }

    #[test]
    fn passive_ev_is_excluded_even_without_a_controllable_car() {
        let mut p = crate::witnesses::tests::problem(1);
        p.car = None;
        p.charger = None;
        p.initial.ev_kwh = None;
        p.targets.ev_km = None;
        p.targets.ev_limit_kwh = None;
        p.slots[0].base_w = 3000.0;
        p.slots[0].base_ev_w = 2000.0;
        p.slots[0].solar_w = 1500.0;
        let mut c = command(Operation::SelfConsumption);
        c.ev_amps = 0;
        let q = projection(&p, &[c.clone()]).unwrap();
        assert!((q[0].discharge_w - 500.0).abs() < 1e-8);
        p.ev_battery_supply_allowed = true;
        assert!((projection(&p, &[c]).unwrap()[0].discharge_w - 1500.0).abs() < 1e-8);
    }

    #[test]
    fn external_replay_recomputes_eligibility_when_actual_demand_changes() {
        let mut p = crate::witnesses::tests::problem(1);
        p.slots[0].base_w = 2500.0;
        let c = command(Operation::SelfConsumption);
        assert_eq!(
            projection(&p, std::slice::from_ref(&c)).unwrap()[0].discharge_w,
            2500.0
        );
        p.slots[0].base_w = 500.0;
        p.initial.battery_kwh = Some(10.0);
        assert_eq!(
            project_external(&p, std::slice::from_ref(&c)).unwrap()[0].discharge_w,
            500.0
        );
        // A previously accepted broad native limit is still constrained by current scope.
        p.accepted = Some(vec![c.clone()]);
        p.locked_through_seconds = 3600.0;
        assert_eq!(projection(&p, &[c]).unwrap()[0].discharge_w, 500.0);
    }

    #[test]
    fn pool_reservoir_requires_current_abi_and_matching_device_presence() {
        let mut p = crate::witnesses::tests::problem(1);
        p.abi = 9;
        assert_eq!(
            crate::validate(&p),
            Err("unsupported_abi_or_empty_problem".into())
        );
        p.abi = 13;
        p.initial.pool_pending_heat_kwh = None;
        assert_eq!(
            crate::validate(&p),
            Err("inconsistent_device_presence".into())
        );
    }

    #[test]
    fn permission_and_passive_partition_are_required_abi_fields() {
        let p = crate::witnesses::tests::problem(1);
        let mut json = serde_json::to_value(&p).unwrap();
        json.as_object_mut()
            .unwrap()
            .remove("ev_battery_supply_allowed");
        assert!(serde_json::from_value::<Problem>(json).is_err());
        let mut json = serde_json::to_value(&p).unwrap();
        json["slots"][0]
            .as_object_mut()
            .unwrap()
            .remove("base_ev_w");
        assert!(serde_json::from_value::<Problem>(json).is_err());
        let mut p = p;
        p.slots[0].base_ev_w = 1.0;
        assert_eq!(crate::validate(&p), Err("invalid_base_ev_partition".into()));
    }
}
