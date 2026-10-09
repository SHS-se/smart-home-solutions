use crate::*;
#[derive(Clone)]
pub(crate) struct State {
    pub battery: f64,
    pub ev: f64,
    pub pool: f64,
    pub heater: HeaterState,
}
pub(crate) fn initial(p: &Problem) -> State {
    State {
        battery: p.initial.battery_kwh.unwrap_or(0.0),
        ev: p.initial.ev_kwh.unwrap_or(0.0),
        pool: p.initial.pool_c.unwrap_or(0.0),
        heater: p.initial.heater_state.unwrap_or(HeaterState::OffUnobserved),
    }
}
pub(crate) fn locked(p: &Problem, i: usize) -> bool {
    p.accepted.is_some() && p.slots[i].start_seconds < p.locked_through_seconds
}

// Keep interval identity for locking; fresh state starts at capture, never before it.
pub(crate) fn projected_hours(s: &Slot) -> f64 {
    s.hours + s.start_seconds.min(0.0) / 3600.0
}

fn transition(
    p: &Problem,
    i: usize,
    command: &Command,
    state: &mut State,
    external: bool,
) -> Result<Quarter, String> {
    if !external && locked(p, i) && command != &p.accepted.as_ref().unwrap()[i] {
        return Err("commitment_changed".into());
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
            heater.pool_transition(
                store,
                state.heater,
                command.pool_on,
                shs_planner_models::PoolConditions {
                    water_c: state.pool,
                    outdoor_c: s.outdoor_c,
                    seconds,
                    stop_c: p.pool_stop_c,
                },
            )
        });
    let pool_w = pool.as_ref().map_or(0.0, |h| h.electric_w);
    let ev_w = if let Some((car, charger)) = p.car.as_ref().zip(p.charger.as_ref()) {
        let nominal = charger
            .watts(command.ev_amps)
            .ok_or("non_native_ev_command")?;
        if !s.ev_available && command.ev_amps != 0 && !locked(p, i) && !external {
            return Err("ev_unavailable".into());
        }
        let room = (p.targets.ev_limit_kwh.unwrap() - state.ev).max(0.0) * 1000.0
            / hours
            / car.charge_efficiency;
        if nominal > room + 1e-7 && !locked(p, i) && !external {
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
    let demand = s.base_w + pool_w + ev_w - s.solar_w;
    if command.battery == Operation::Export
        && p.battery.is_some()
        && (!p.limits.battery_export_enabled
            || (!external && !locked(p, i) && s.export_price < p.limits.battery_export_min_price))
    {
        return Err("export_without_permission".into());
    }
    let (charge, discharge) = battery_flows(p, command, demand, state.battery, hours, None);
    let physical_net = demand + charge - discharge;
    if physical_net > p.limits.import_w + 1e-7 {
        return Err("shared_grid_limit".into());
    }
    let curtailed_w = (-physical_net - p.limits.export_w).max(0.0).min(s.solar_w);
    let net = physical_net + curtailed_w;
    if -net > p.limits.export_w + 1e-7 {
        return Err("shared_grid_limit".into());
    }
    let cost = grid_cost(s, net, hours);
    // Wear is declared on what the battery discharges, as the bench bills it.
    let wear = discharge * hours / 1000.0 * p.limits.wear_per_kwh;
    if let Some(h) = &pool {
        state.pool = h.water_c;
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
        pool_auxiliary_w: pool.as_ref().map_or(0.0, |h| h.auxiliary_w),
        pool_heat_w: pool.as_ref().map_or(0.0, |h| h.heat_w),
        ev_w,
        charge_w: charge,
        discharge_w: discharge,
        net_w: net,
        curtailed_w,
        battery_kwh: p.battery.as_ref().map(|_| state.battery),
        ev_kwh: p.car.as_ref().map(|_| state.ev),
        pool_c: p.heater.as_ref().map(|_| state.pool),
        heater_state: p.heater.as_ref().map(|_| state.heater),
        pool_start: pool.and_then(|h| h.start),
        cost,
        wear,
        spare_battery_cover_w: spare_cover(p, charge, discharge, state.battery, hours),
    })
}
/// What the battery could still have given the house in a quarter, W: none
/// while it charges, else its spare power as far as what it holds afterwards.
pub(crate) fn spare_cover(
    p: &Problem,
    charge: f64,
    discharge: f64,
    battery_kwh: f64,
    hours: f64,
) -> f64 {
    p.battery.as_ref().map_or(0.0, |battery| {
        if charge > 0.0 {
            0.0
        } else {
            (battery.discharge_max_w - discharge).max(0.0).min(
                (battery_kwh - battery.min_soc * battery.capacity_kwh).max(0.0) * 1000.0 / hours
                    * battery.discharge_efficiency,
            )
        }
    })
}

/// What the battery does in a quarter for a house asking `demand` W of it and
/// the grid. A projection decides a grid charge or a sale by the command's own
/// limits. On another day each runs at the power the plan `booked`, as far as
/// the pack can take or give it: a plan books a power, not a level to reach.
pub(crate) fn battery_flows(
    p: &Problem,
    command: &Command,
    demand: f64,
    battery_kwh: f64,
    hours: f64,
    booked: Option<(f64, f64)>,
) -> (f64, f64) {
    let Some(battery) = &p.battery else {
        return (0.0, 0.0);
    };
    let room = battery.available_charge_w(battery_kwh, hours);
    let stored = battery.available_discharge_w(battery_kwh, hours);
    let charge_cap = command.charge_limit_w.min(room);
    let discharge_cap = command.discharge_limit_w.min(stored);
    let solar = (-demand).max(0.0).min(charge_cap);
    match command.battery {
        Operation::Idle => (0.0, 0.0),
        Operation::Hold | Operation::SolarCharge => (solar, 0.0),
        Operation::SelfConsumption | Operation::SupplyHouse => {
            (solar, demand.max(0.0).min(discharge_cap))
        }
        Operation::GridCharge => (
            booked
                .map_or(charge_cap, |(charge, _)| charge.min(room))
                .min((p.limits.import_w - demand).max(0.0)),
            0.0,
        ),
        Operation::Export => {
            let power = booked.map_or_else(
                || {
                    let reserve = (battery_kwh - p.limits.battery_export_reserve_kwh).max(0.0)
                        * 1000.0
                        / hours
                        * battery.discharge_efficiency;
                    discharge_cap.min(reserve)
                },
                |(_, discharge)| discharge.min(stored),
            );
            (0.0, power.min((p.limits.export_w + demand).max(0.0)))
        }
    }
}
fn grid_cost(s: &Slot, net: f64, hours: f64) -> f64 {
    (net.max(0.0) * s.import_price - (-net).max(0.0) * s.export_price) * hours / 1000.0
}

/// A day that differs from its forecast: the household's own load and the sun,
/// each scaled.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Day {
    pub base: f64,
    pub solar: f64,
}
impl Day {
    pub(crate) const FORECAST: Day = Day {
        base: 1.0,
        solar: 1.0,
    };
    /// What the house asks of the battery and the grid in a quarter of this
    /// day, and its sun. The pool and the car draw what the plan projected:
    /// what they are booked does not depend on the rest of the house.
    pub(crate) fn demand(self, s: &Slot, planned: &Quarter) -> (f64, f64) {
        let solar_w = s.solar_w * self.solar;
        (
            s.base_w * self.base + planned.pool_w + planned.ev_w - solar_w,
            solar_w,
        )
    }
}
/// The battery and the grid in one quarter of a carried plan.
pub(crate) struct CarriedQuarter {
    pub charge: f64,
    pub discharge: f64,
    pub net: f64,
    pub curtailed: f64,
    /// Grid cost and battery wear.
    pub cost: f64,
    pub battery_kwh: f64,
}
/// One quarter of a plan carried through a day: the battery does what its
/// command permits for the house there is (`battery_flows`), and the grid
/// takes the rest.
pub(crate) fn carry(
    p: &Problem,
    s: &Slot,
    command: &Command,
    (demand, solar_w): (f64, f64),
    battery_kwh: f64,
    booked: Option<(f64, f64)>,
) -> CarriedQuarter {
    let hours = projected_hours(s);
    let (charge, discharge) = battery_flows(p, command, demand, battery_kwh, hours, booked);
    let physical_net = demand + charge - discharge;
    let curtailed = (-physical_net - p.limits.export_w).max(0.0).min(solar_w);
    let net = physical_net + curtailed;
    CarriedQuarter {
        charge,
        discharge,
        net,
        curtailed,
        cost: grid_cost(s, net, hours) + discharge * hours / 1000.0 * p.limits.wear_per_kwh,
        battery_kwh: p.battery.as_ref().map_or(battery_kwh, |battery| {
            battery.step(battery_kwh, charge, discharge, hours)
        }),
    }
}
/// A projected plan's bill on a day that differs from its forecast, and where
/// its battery ends: grid cost and wear, each quarter carried as booked.
pub(crate) fn carried(
    p: &Problem,
    commands: &[Command],
    planned: &[Quarter],
    day: Day,
) -> (f64, f64) {
    let mut battery_kwh = p.initial.battery_kwh.unwrap_or(0.0);
    let mut cost = 0.0;
    for ((s, c), q) in p.slots.iter().zip(commands).zip(planned) {
        let quarter = carry(
            p,
            s,
            c,
            day.demand(s, q),
            battery_kwh,
            Some((q.charge_w, q.discharge_w)),
        );
        cost += quarter.cost;
        battery_kwh = quarter.battery_kwh;
    }
    (cost, battery_kwh)
}

pub(crate) fn projection(p: &Problem, commands: &[Command]) -> Result<Vec<Quarter>, String> {
    if commands.len() != p.slots.len() {
        return Err("projection_coverage".into());
    }
    let mut state = initial(p);
    commands
        .iter()
        .enumerate()
        .map(|(i, c)| step(p, i, c, &mut state))
        .collect()
}

/// Count whole-vector reconstruction, physical/model transitions and buffer allocation.
pub(crate) fn project_metered(
    p: &Problem,
    commands: &[Command],
    work: &mut Work,
) -> Option<Vec<Quarter>> {
    if !work.spend(p.slots.len() as u64 * work.unit_cost * 2) {
        return None;
    }
    work.evaluations += 1;
    projection(p, commands).ok()
}

pub(crate) fn step(
    p: &Problem,
    i: usize,
    command: &Command,
    state: &mut State,
) -> Result<Quarter, String> {
    transition(p, i, command, state, false)
}
pub(crate) fn project_external(p: &Problem, commands: &[Command]) -> Result<Vec<Quarter>, String> {
    if commands.len() != p.slots.len() {
        return Err("projection_coverage".into());
    }
    let mut state = initial(p);
    commands
        .iter()
        .enumerate()
        .map(|(i, c)| transition(p, i, c, &mut state, true))
        .collect()
}
