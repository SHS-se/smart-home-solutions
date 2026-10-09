//! The battery's commands, searched on their own. The pool and the car draw
//! what the plan projected whatever the battery is told, so a change of battery
//! command is judged by carrying the battery and the grid alone through the
//! forecast day and the stress days (`policy::objective`). That costs a small
//! part of a projection, and a pass can judge every mode in every span. What
//! it selects is still a proposal: the search scores the result like any plan.
use crate::physics::{self, Day};
use crate::{policy, *};

/// One quarter of one day carried by the battery and the grid, in work units.
const STEP_COST: u64 = 48;
/// Looks at every mode in every span within one call.
const PASSES: usize = 3;
/// The likeliest edits of one look judged exactly.
const SHORTLIST: usize = 48;
/// Rounds of adoption from one shortlist: each takes the gains whose effects
/// do not meet, and what it passed over is judged again on the result.
const ROUNDS: usize = 4;
/// Two battery levels this close, kWh, have the same future.
const SAME_KWH: f64 = 1e-9;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    /// Follows the house both ways: takes surplus, covers what the house lacks.
    Supply,
    /// Covers what the house lacks and takes nothing: surplus is sold. The
    /// forecast's surplus earns what leaving the battery out would, and a day
    /// with none is not left to the grid.
    Cover,
    /// Takes surplus and keeps what it has.
    Hold,
    /// Left out: surplus is sold and what the house lacks is bought.
    Idle,
    Charge,
    Export,
}
const MODES: [Mode; 6] = [
    Mode::Supply,
    Mode::Cover,
    Mode::Hold,
    Mode::Idle,
    Mode::Charge,
    Mode::Export,
];
#[derive(Clone, Copy, Debug)]
struct Edit {
    start: usize,
    end: usize,
    mode: Mode,
}
/// A battery command: operation, charge limit, discharge limit.
type Setting = (Operation, f64, f64);
fn setting(c: &Command) -> Setting {
    (c.battery, c.charge_limit_w, c.discharge_limit_w)
}
/// The mode as a native command in quarter `i`, or None where it is not permitted there.
fn command(p: &Problem, mode: Mode, i: usize, planned: &Quarter) -> Option<Setting> {
    let battery = p.battery.as_ref()?;
    let s = &p.slots[i];
    // The home battery never supplies the car: while it charges, the battery
    // covers the rest of the house and no more.
    let house_w = if planned.ev_w > 0.0 {
        (s.base_w + planned.pool_w - s.solar_w)
            .max(0.0)
            .min(battery.discharge_max_w)
    } else {
        battery.discharge_max_w
    };
    Some(match mode {
        Mode::Supply => (Operation::SelfConsumption, battery.charge_max_w, house_w),
        Mode::Cover => (Operation::SelfConsumption, 0.0, house_w),
        Mode::Hold => (Operation::Hold, battery.charge_max_w, 0.0),
        Mode::Idle => (Operation::Idle, 0.0, 0.0),
        Mode::Charge => (Operation::GridCharge, battery.charge_max_w, 0.0),
        Mode::Export => {
            if !p.limits.battery_export_enabled
                || s.export_price < p.limits.battery_export_min_price
            {
                return None;
            }
            (Operation::Export, 0.0, battery.discharge_max_w)
        }
    })
}

/// One day of the plan as the battery and the grid carry it.
struct Trace {
    /// What the house asks in each quarter, and its sun.
    demand: Vec<(f64, f64)>,
    /// The battery before each quarter, and after the last.
    kwh: Vec<f64>,
    /// Running cost: grid and wear.
    cost: Vec<f64>,
    flows: Vec<(f64, f64)>,
    /// What a kWh more in the pack before each quarter is worth (`values`).
    value: Vec<f64>,
}
/// What a kWh more in the pack before each quarter is worth on a day, the plan
/// otherwise as it is. The kWh stays until the pack next runs out, where it
/// saves what the house then buys; or next fills, where it saves what filling
/// took; or to the end, where it is credited. An estimate for small changes:
/// a large one outlasts the first of these.
fn values(p: &Problem, battery: &Battery, trace: &Trace) -> Vec<f64> {
    let n = trace.flows.len();
    let mut out = vec![0.0; n + 1];
    const STEP: f64 = 1e-3;
    out[n] = (policy::battery_credit(p, trace.kwh[n] + STEP)
        - policy::battery_credit(p, trace.kwh[n]))
        / STEP;
    for i in (0..n).rev() {
        let s = &p.slots[i];
        let per_kwh = 1000.0 / physics::projected_hours(s);
        let (charge, discharge) = trace.flows[i];
        let net = trace.demand[i].0 + charge - discharge;
        let price = if net > 1e-6 {
            s.import_price
        } else {
            s.export_price
        };
        let stored = (trace.kwh[i] - battery.min_soc * battery.capacity_kwh).max(0.0)
            * per_kwh
            * battery.discharge_efficiency;
        let room = (battery.max_soc * battery.capacity_kwh - trace.kwh[i]).max(0.0) * per_kwh
            / battery.charge_efficiency;
        out[i] = if discharge > 0.0 && discharge >= stored - 1e-6 {
            battery.discharge_efficiency * (price - p.limits.wear_per_kwh)
        } else if charge > 0.0 && charge >= room - 1e-6 {
            price / battery.charge_efficiency
        } else {
            out[i + 1]
        };
    }
    out
}
/// What an edit is judged to add to the plan's objective.
struct Gain {
    sek: f64,
    /// The quarter from which every day is again as it was.
    until: usize,
    /// Quarters of days carried to find out.
    steps: u64,
}
struct Ledger<'a> {
    index: &'a policy::Index,
    /// The forecast day, then the stress days.
    days: Vec<Trace>,
    /// Running points of the forecast day's quarters (`points`).
    points: Vec<f64>,
    weight: f64,
}
/// What the rules take or give in a forecast quarter with these battery
/// flows. The pool and the car are as planned, so only what a rule reads of
/// the battery and the grid can differ from the plan's own account; a rule
/// that reads a plan's history reads the same history either way.
fn points(
    p: &Problem,
    index: &policy::Index,
    i: usize,
    planned: &[Quarter],
    q: &physics::CarriedQuarter,
) -> f64 {
    let mut v = planned[i].clone();
    v.charge_w = q.charge;
    v.discharge_w = q.discharge;
    v.net_w = q.net;
    v.curtailed_w = q.curtailed;
    v.battery_kwh = Some(q.battery_kwh);
    v.spare_battery_cover_w = physics::spare_cover(
        p,
        q.charge,
        q.discharge,
        q.battery_kwh,
        physics::projected_hours(&p.slots[i]),
    );
    let before_c = if i == 0 {
        p.initial.pool_c
    } else {
        planned[i - 1].pool_c
    };
    f64::from(policy::guidance_quarter(
        p,
        index,
        i,
        &v,
        before_c.unwrap_or(0.0),
    ))
}
impl<'a> Ledger<'a> {
    fn new(
        p: &Problem,
        index: &'a policy::Index,
        commands: &[Command],
        planned: &[Quarter],
    ) -> Self {
        let n = commands.len();
        let mut days: Vec<Trace> = Vec::new();
        let mut points = vec![0.0; n + 1];
        for day in std::iter::once(Day::FORECAST).chain(policy::STRESS_DAYS) {
            let mut trace = Trace {
                demand: Vec::with_capacity(n),
                kwh: Vec::with_capacity(n + 1),
                cost: Vec::with_capacity(n + 1),
                flows: Vec::with_capacity(n),
                value: Vec::new(),
            };
            trace.kwh.push(p.initial.battery_kwh.unwrap_or(0.0));
            trace.cost.push(0.0);
            for i in 0..n {
                let demand = day.demand(&p.slots[i], &planned[i]);
                let q = physics::carry(
                    p,
                    &p.slots[i],
                    &commands[i],
                    demand,
                    trace.kwh[i],
                    days.first().map(|forecast| forecast.flows[i]),
                );
                if days.is_empty() {
                    points[i + 1] = points[i] + self::points(p, index, i, planned, &q);
                }
                trace.demand.push(demand);
                trace.flows.push((q.charge, q.discharge));
                trace.cost.push(trace.cost[i] + q.cost);
                trace.kwh.push(q.battery_kwh);
            }
            if let Some(battery) = &p.battery {
                trace.value = values(p, battery, &trace);
            }
            days.push(trace);
        }
        Self {
            days,
            index,
            points,
            weight: policy::STRESS_WEIGHT,
        }
    }
    /// What the edit adds to the plan's objective, and the quarter from which
    /// every day is again as it was: two edits whose spans to there do not
    /// meet do not affect each other. Exactly, each day is carried on until
    /// its battery is back where it was. As an estimate, only the span is
    /// carried, and what it leaves the battery with is valued by `values`.
    fn gain(
        &self,
        p: &Problem,
        commands: &[Command],
        planned: &[Quarter],
        edit: Edit,
        exact: bool,
        booked: &mut Vec<(f64, f64)>,
    ) -> Gain {
        let n = commands.len();
        let at = |i: usize| -> Command {
            let mut c = commands[i].clone();
            if i < edit.end {
                if let Some(new) = command(p, edit.mode, i, &planned[i]) {
                    (c.battery, c.charge_limit_w, c.discharge_limit_w) = new;
                }
            }
            c
        };
        booked.clear();
        let mut steps = 0;
        let mut until = edit.end;
        let mut forecast_delta = 0.0;
        let mut stressed_delta = 0.0;
        let mut points = 0.0;
        for (d, trace) in self.days.iter().enumerate() {
            let mut kwh = trace.kwh[edit.start];
            let mut cost = 0.0;
            let mut i = edit.start;
            // The forecast day runs until its battery is back where it was;
            // a stress day at least as far, since its bookings are the forecast's.
            let settled = if d == 0 { edit.end } else { until };
            loop {
                let flows = (d > 0).then(|| {
                    booked
                        .get(i - edit.start)
                        .copied()
                        .unwrap_or(self.days[0].flows[i])
                });
                let q = physics::carry(p, &p.slots[i], &at(i), trace.demand[i], kwh, flows);
                if d == 0 {
                    booked.push((q.charge, q.discharge));
                    points += self::points(p, self.index, i, planned, &q);
                }
                cost += q.cost;
                kwh = q.battery_kwh;
                i += 1;
                steps += 1;
                if i == n || (i >= settled && (!exact || (kwh - trace.kwh[i]).abs() <= SAME_KWH)) {
                    break;
                }
            }
            let mut delta = cost - (trace.cost[i] - trace.cost[edit.start]);
            if i == n {
                delta -= policy::battery_credit(p, kwh) - policy::battery_credit(p, trace.kwh[n]);
            } else {
                // Nothing where the day has settled; else the estimate.
                delta -= trace.value[i] * (kwh - trace.kwh[i]);
            }
            if d == 0 {
                forecast_delta = delta;
                points -= self.points[i] - self.points[edit.start];
                until = i;
            } else {
                stressed_delta += delta / (self.days.len() - 1) as f64;
                until = until.max(i);
            }
        }
        Gain {
            sek: points - (1.0 - self.weight) * forecast_delta - self.weight * stressed_delta,
            until,
            steps,
        }
    }
}

/// The spans a mode is tried on: one, two, four … quarters long, each length
/// stepped by half of itself.
fn spans(n: usize) -> impl Iterator<Item = (usize, usize)> {
    [1usize, 2, 4, 8, 16, 32].into_iter().flat_map(move |len| {
        (0..n)
            .step_by((len / 2).max(1))
            .filter_map(move |start| (start + len <= n).then_some((start, start + len)))
    })
}

/// The plan's battery commands improved on their own, or None where no change
/// gains or the grant cannot pay for looking. Only battery fields differ from
/// `commands`, and never in a committed quarter.
pub(crate) fn improve(
    p: &Problem,
    index: &policy::Index,
    commands: &[Command],
    planned: &[Quarter],
    work: &mut Work,
) -> Option<Vec<Command>> {
    p.battery.as_ref()?;
    let n = commands.len();
    let days = 1 + policy::STRESS_DAYS.len() as u64;
    let mut working = commands.to_vec();
    let mut changed = false;
    let mut booked = Vec::with_capacity(n);
    for _ in 0..PASSES {
        if !work.spend(n as u64 * days * STEP_COST) {
            break;
        }
        let mut ledger = Ledger::new(p, index, &working, planned);
        // Every mode in every span, estimated on the plan as it stands.
        let mut estimates: Vec<(f64, Edit)> = Vec::new();
        for (start, end) in spans(n) {
            if (start..end).any(|i| physics::locked(p, i)) {
                continue;
            }
            for mode in MODES {
                // Selling surplus is all that sets these apart from holding
                // or supplying: with none forecast in the span they gain nothing.
                if matches!(mode, Mode::Idle | Mode::Cover)
                    && (start..end).all(|i| ledger.days[0].demand[i].0 >= 0.0)
                {
                    continue;
                }
                if !differs(p, &working, planned, start, end, mode)
                    || !work.spend((end - start) as u64 * days * STEP_COST)
                {
                    continue;
                }
                let edit = Edit { start, end, mode };
                let gain = ledger.gain(p, &working, planned, edit, false, &mut booked);
                if gain.sek > policy::MIN_GAIN_SEK {
                    estimates.push((gain.sek, edit));
                }
            }
        }
        estimates.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.start.cmp(&b.1.start)));
        // The likeliest of each mode and place, judged exactly.
        let mut shortlist: Vec<(f64, usize, Edit)> = Vec::new();
        let mut kept: Vec<Edit> = Vec::new();
        for (_, edit) in estimates {
            if kept.len() == SHORTLIST {
                break;
            }
            if kept
                .iter()
                .any(|k| k.mode == edit.mode && edit.start < k.end && k.start < edit.end)
            {
                continue;
            }
            if work.free() < (n - edit.start) as u64 * days * STEP_COST {
                break;
            }
            kept.push(edit);
            let gain = ledger.gain(p, &working, planned, edit, true, &mut booked);
            work.spend(gain.steps * STEP_COST);
            if gain.sek > policy::MIN_GAIN_SEK {
                shortlist.push((gain.sek, gain.until, edit));
            }
        }
        let mut adopted = false;
        for _ in 0..ROUNDS {
            if shortlist.is_empty() {
                break;
            }
            shortlist.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.2.start.cmp(&b.2.start)));
            // The largest gains whose effects do not meet add up exactly.
            let mut taken: Vec<(usize, usize)> = Vec::new();
            let mut rest = Vec::new();
            for (_, until, edit) in shortlist {
                if taken
                    .iter()
                    .any(|(from, to)| edit.start < *to && *from < until)
                {
                    rest.push(edit);
                    continue;
                }
                taken.push((edit.start, until));
                for i in edit.start..edit.end {
                    if let Some(new) = command(p, edit.mode, i, &planned[i]) {
                        let c = &mut working[i];
                        (c.battery, c.charge_limit_w, c.discharge_limit_w) = new;
                    }
                }
            }
            adopted = true;
            // What was passed over is judged again on the plan as it now stands.
            if rest.is_empty() || !work.spend(n as u64 * days * STEP_COST * (1 + rest.len() as u64))
            {
                break;
            }
            ledger = Ledger::new(p, index, &working, planned);
            shortlist = rest
                .into_iter()
                .filter(|edit| differs(p, &working, planned, edit.start, edit.end, edit.mode))
                .filter_map(|edit| {
                    let gain = ledger.gain(p, &working, planned, edit, true, &mut booked);
                    (gain.sek > policy::MIN_GAIN_SEK).then_some((gain.sek, gain.until, edit))
                })
                .collect();
        }
        if !adopted {
            break;
        }
        changed = true;
    }
    changed.then_some(working)
}
/// Whether the mode is permitted throughout the span and would change a command in it.
fn differs(
    p: &Problem,
    commands: &[Command],
    planned: &[Quarter],
    start: usize,
    end: usize,
    mode: Mode,
) -> bool {
    let mut differs = false;
    (start..end).all(|i| {
        command(p, mode, i, &planned[i])
            .inspect(|new| differs |= *new != setting(&commands[i]))
            .is_some()
    }) && differs
}

#[cfg(test)]
mod tests {
    use super::*;
    fn work(p: &Problem) -> Work {
        Work {
            used: 0,
            limit: p.work_grant,
            reserved: 0,
            unit_cost: 100,
            expansions: 0,
            evaluations: 0,
            witness_trials: 0,
            repairs: 0,
            move_resize_trials: 0,
            move_resize_passes: 0,
            move_resize_improvements: 0,
        }
    }
    fn commands(p: &Problem, mode: Mode) -> Vec<Command> {
        let off = Quarter {
            pool_command_w: 0.0,
            pool_w: 0.0,
            pool_compressor_w: 0.0,
            pool_auxiliary_w: 0.0,
            pool_heat_w: 0.0,
            ev_w: 0.0,
            charge_w: 0.0,
            discharge_w: 0.0,
            net_w: 0.0,
            curtailed_w: 0.0,
            battery_kwh: None,
            ev_kwh: None,
            pool_c: None,
            heater_state: None,
            pool_start: None,
            cost: 0.0,
            wear: 0.0,
            spare_battery_cover_w: 0.0,
        };
        (0..p.slots.len())
            .map(|i| {
                let (battery, charge_limit_w, discharge_limit_w) =
                    command(p, mode, i, &off).unwrap();
                Command {
                    pool_on: false,
                    ev_amps: 0,
                    battery,
                    charge_limit_w,
                    discharge_limit_w,
                }
            })
            .collect()
    }
    /// A dear day whose forecast sun exactly covers the house.
    fn balanced() -> Problem {
        balanced_for(8)
    }
    fn balanced_for(n: usize) -> Problem {
        let mut p = crate::witnesses::tests::problem(n);
        p.rules.clear();
        for s in &mut p.slots {
            s.base_w = 1000.0;
            s.solar_w = 1000.0;
            s.import_price = 3.0;
            s.export_price = 1.5;
        }
        // What the pack holds at the end is worth what it would cost to buy.
        p.limits.battery_export_enabled = false;
        p.end_credit.reference_sek_per_kwh = 3.0;
        p.end_credit.battery = Some(StoreTerm {
            cap: 10.0,
            grid_kwh_per_unit: 1.0,
        });
        p
    }
    #[test]
    fn the_forecast_day_carried_is_the_plan_s_own_bill_and_the_ledger_agrees_with_the_objective() {
        let mut p = balanced();
        p.slots[2].solar_w = 0.0;
        p.slots[5].solar_w = 3000.0;
        let index = policy::index(&p, &mut work(&p)).unwrap();
        for mode in [Mode::Supply, Mode::Hold, Mode::Idle, Mode::Charge] {
            let c = commands(&p, mode);
            let q = physics::projection(&p, &c).unwrap();
            let (cost, end) = physics::carried(&p, &c, &q, Day::FORECAST);
            let bill: f64 = q.iter().map(|v| v.cost + v.wear).sum();
            assert!((cost - bill).abs() < 1e-9, "{mode:?}");
            assert!((end - q.last().unwrap().battery_kwh.unwrap()).abs() < 1e-9);
            let ledger = Ledger::new(&p, &index, &c, &q);
            assert!((ledger.days[0].cost[8] - bill).abs() < 1e-9);
        }
        // A gain the ledger reports is the change in the objective, exactly.
        let before = commands(&p, Mode::Idle);
        let q = physics::projection(&p, &before).unwrap();
        let ledger = Ledger::new(&p, &index, &before, &q);
        let edit = Edit {
            start: 1,
            end: 4,
            mode: Mode::Supply,
        };
        let gain = ledger
            .gain(&p, &before, &q, edit, true, &mut Vec::new())
            .sek;
        let mut after = before.clone();
        for c in &mut after[1..4] {
            (c.battery, c.charge_limit_w, c.discharge_limit_w) =
                (Operation::SelfConsumption, 4000.0, 4000.0);
        }
        let objective = |c: &[Command]| {
            let q = physics::projection(&p, c).unwrap();
            policy::objective(&p, &policy::account(&p, &q, &index), c, &q)
        };
        assert!((gain - (objective(&after) - objective(&before))).abs() < 1e-9);
    }
    #[test]
    fn a_battery_left_out_for_a_forecast_that_exactly_balances_is_put_back_to_follow_the_house() {
        // On the forecast, leaving the battery out costs nothing: the sun
        // covers the house. A heavier day buys at 3.00 what the pack held.
        let p = balanced();
        let idle = commands(&p, Mode::Idle);
        let q = physics::projection(&p, &idle).unwrap();
        let index = policy::index(&p, &mut work(&p)).unwrap();
        let improved = improve(&p, &index, &idle, &q, &mut work(&p)).unwrap();
        assert!(improved
            .iter()
            .all(|c| c.battery == Operation::SelfConsumption));
        // Following the house already, nothing gains.
        let q = physics::projection(&p, &improved).unwrap();
        assert!(improve(&p, &index, &improved, &q, &mut work(&p)).is_none());
    }
    #[test]
    fn a_following_battery_follows_a_heavier_day_and_a_booked_charge_does_not_grow() {
        let mut p = balanced_for(12);
        for s in &mut p.slots {
            s.solar_w = 0.0;
        }
        // An hour supplying a kilowatt, then charging until full.
        let mut c = commands(&p, Mode::Charge);
        c[..4].clone_from_slice(&commands(&p, Mode::Supply)[..4]);
        let q = physics::projection(&p, &c).unwrap();
        // The forecast: 5 kWh less one, then a kWh a quarter to the full 10.
        assert_eq!(q[9].charge_w, 4000.0);
        assert_eq!(q[10].charge_w, 0.0);
        let (_, forecast) = physics::carried(&p, &c, &q, Day::FORECAST);
        assert!((forecast - 10.0).abs() < 1e-9);
        // A quarter heavier, the house took a quarter more in that hour. The
        // charge was booked for the forecast and leaves the pack that short.
        let heavier = policy::STRESS_DAYS[0];
        assert_eq!(heavier.base, 1.25);
        let (_, end) = physics::carried(&p, &c, &q, heavier);
        assert!((end - 9.75).abs() < 1e-9);
    }
    #[test]
    fn covering_sells_a_forecast_surplus_and_still_supplies_a_day_without_one() {
        let mut p = balanced();
        // Half a kilowatt of surplus, sold for more than the pack is credited.
        for s in &mut p.slots {
            s.solar_w = 1500.0;
        }
        p.end_credit.reference_sek_per_kwh = 1.0;
        let bill = |mode, day| {
            let c = commands(&p, mode);
            let q = physics::projection(&p, &c).unwrap();
            physics::carried(&p, &c, &q, day)
        };
        // On the forecast, covering and leaving the battery out are one plan.
        assert_eq!(
            bill(Mode::Cover, Day::FORECAST),
            bill(Mode::Idle, Day::FORECAST)
        );
        // With a quarter less sun and a quarter more load the house lacks
        // 125 W: left out, the battery lets it be bought at 3.00.
        let heavier = policy::STRESS_DAYS[0];
        let (left_out, _) = bill(Mode::Idle, heavier);
        let (covered, end) = bill(Mode::Cover, heavier);
        assert!((left_out - 8.0 * 0.125 * 0.25 * 3.0).abs() < 1e-9);
        assert!(covered.abs() < 1e-9 && (end - (5.0 - 8.0 * 0.125 * 0.25)).abs() < 1e-9);
        // The search takes the battery from left out to covering.
        let idle = commands(&p, Mode::Idle);
        let q = physics::projection(&p, &idle).unwrap();
        let index = policy::index(&p, &mut work(&p)).unwrap();
        let improved = improve(&p, &index, &idle, &q, &mut work(&p)).unwrap();
        assert!(improved
            .iter()
            .all(|c| setting(c) == (Operation::SelfConsumption, 0.0, 4000.0)));
    }
    #[test]
    fn committed_quarters_keep_their_battery_command() {
        let mut p = balanced();
        let idle = commands(&p, Mode::Idle);
        p.accepted = Some(idle[..4].to_vec());
        p.locked_through_seconds = 3600.0;
        let q = physics::projection(&p, &idle).unwrap();
        let index = policy::index(&p, &mut work(&p)).unwrap();
        let improved = improve(&p, &index, &idle, &q, &mut work(&p)).unwrap();
        assert_eq!(improved[..4], idle[..4]);
        assert!(improved[4..]
            .iter()
            .all(|c| c.battery == Operation::SelfConsumption));
    }
}
