use crate::*;
#[derive(Clone)]
pub(crate) struct State {
    pub battery: f64,
    pub ev: f64,
    pub pool: f64,
    pub age: RunAge,
}
pub(crate) fn initial(p: &Problem) -> State {
    State {
        battery: p.initial.battery_kwh,
        ev: p.initial.ev_kwh,
        pool: p.initial.pool_c,
        age: p.initial.heater_age,
    }
}
pub(crate) fn locked(p: &Problem, i: usize) -> bool {
    p.accepted.is_some() && p.slots[i].start_seconds < p.locked_through_seconds
}

// Keep interval identity for locking; fresh state starts at capture, never before it.
pub(crate) fn projected_hours(s: &Slot) -> f64 {
    s.hours + s.start_seconds.min(0.0) / 3600.0
}

pub(crate) fn step(
    p: &Problem,
    i: usize,
    command: &Command,
    state: &mut State,
) -> Result<Quarter, String> {
    if locked(p, i) && command != &p.accepted.as_ref().unwrap()[i] {
        return Err("commitment_changed".into());
    }
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

pub(crate) fn projection(p: &Problem, commands: &[Command]) -> Result<Vec<Quarter>, String> {
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
