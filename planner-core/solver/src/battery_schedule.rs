//! Whole-horizon battery allocation conditional on the pool and car's draw.
//! Backward inventory values compare complete charge/hold/supply/sale sequences.
//! Interpolation approximates value only: every emitted command is carried from
//! the exact inventory by the same native physics as the final projection.
use crate::{physics, policy, *};

const LEVELS: usize = 32;
const CARRY_COST: u64 = 48;

struct Context<'a> {
    p: &'a Problem,
    index: &'a policy::Index,
    commands: &'a [Command],
    planned: &'a [Quarter],
    axes: &'a [Vec<f64>],
}
impl Context<'_> {
    fn demand(&self, i: usize) -> (f64, f64) {
        let s = &self.p.slots[i];
        (
            s.base_w + self.planned[i].pool_w + self.planned[i].ev_w - s.solar_w,
            s.solar_w,
        )
    }
    /// A linear continuation segment is maximised at an inventory knot or a
    /// physical/tariff boundary. Include both, deriving partial native powers
    /// from actual energy changes rather than testing guessed power fractions.
    fn options(&self, i: usize, kwh: f64) -> Vec<Command> {
        if physics::locked(self.p, i) {
            return vec![self.commands[i].clone()];
        }
        let p = self.p;
        let b = p.battery.as_ref().unwrap();
        let s = &p.slots[i];
        let hours = physics::projected_hours(s);
        let demand = self.demand(i).0;
        let house = if self.planned[i].ev_w > 0.0 {
            (demand - self.planned[i].ev_w)
                .max(0.0)
                .min(b.discharge_max_w)
        } else {
            b.discharge_max_w
        };
        let charge = b
            .available_charge_w(kwh, hours)
            .min((p.limits.import_w - demand).max(0.0));
        let supply = b
            .available_discharge_w(kwh, hours)
            .min(demand.max(0.0))
            .min(house);
        let export = if p.limits.battery_export_enabled
            && s.export_price >= p.limits.battery_export_min_price
        {
            b.available_discharge_w(kwh, hours)
                .min(
                    (kwh - p.limits.battery_export_reserve_kwh).max(0.0) * 1000.0 / hours
                        * b.discharge_efficiency,
                )
                .min((p.limits.export_w + demand).max(0.0))
        } else {
            0.0
        };
        let mut out = Vec::new();
        let mut add = |operation, charge, discharge| {
            let mut c = self.commands[i].clone();
            c.battery = operation;
            c.charge_limit_w = charge;
            c.discharge_limit_w = discharge;
            if !out.contains(&c) {
                out.push(c);
            }
        };
        add(Operation::SelfConsumption, b.charge_max_w, house);
        add(Operation::SelfConsumption, 0.0, house);
        add(Operation::Hold, b.charge_max_w, 0.0);
        add(Operation::Idle, 0.0, 0.0);
        add(
            self.commands[i].battery,
            self.commands[i].charge_limit_w,
            self.commands[i].discharge_limit_w,
        );
        let mut purchase = |power: f64| {
            if power > 0.0 && power <= charge + 1e-7 {
                // Solar-only capture is a permission; a grid purchase is sized.
                add(
                    if power <= (-demand).max(0.0) {
                        Operation::SolarCharge
                    } else {
                        Operation::GridCharge
                    },
                    power.min(charge),
                    0.0,
                );
            }
        };
        purchase(charge);
        // Direct rule rewards change at their declared flexible-load floors.
        for floor in [500.0, policy::VERY_CHEAP_LOAD_W] {
            purchase((floor - self.planned[i].pool_w - self.planned[i].ev_w).max(0.0));
        }
        purchase((-demand).max(0.0).min(charge));
        for &target in &self.axes[i + 1] {
            if target > kwh {
                purchase((target - kwh) * 1000.0 / hours / b.charge_efficiency);
            }
        }
        if export > 0.0 {
            add(Operation::Export, 0.0, export);
        }
        for &target in &self.axes[i + 1] {
            if target >= kwh {
                continue;
            }
            let power = (kwh - target) * 1000.0 / hours * b.discharge_efficiency;
            if power <= supply + 1e-7 {
                add(
                    Operation::SelfConsumption,
                    b.charge_max_w,
                    power.min(supply),
                );
            }
            if power <= export + 1e-7 {
                add(Operation::Export, 0.0, power.min(export));
            }
        }
        // Net zero is the tariff kink for a sale that first supplies the house.
        if demand > 0.0 && demand < export {
            add(Operation::Export, 0.0, demand);
        }
        out
    }
    fn carry(&self, i: usize, kwh: f64, c: &Command) -> Option<physics::CarriedQuarter> {
        let q = physics::carry(self.p, &self.p.slots[i], c, self.demand(i), kwh);
        physics::within_grid(self.p, q.net).then_some(q)
    }
    fn value(&self, i: usize, q: &physics::CarriedQuarter) -> f64 {
        let mut v = self.planned[i].clone();
        v.charge_w = q.charge;
        v.discharge_w = q.discharge;
        v.net_w = q.net;
        v.curtailed_w = q.curtailed;
        v.battery_kwh = Some(q.battery_kwh);
        v.spare_battery_cover_w = physics::spare_cover(
            self.p,
            q.charge,
            q.discharge,
            q.battery_kwh,
            physics::projected_hours(&self.p.slots[i]),
        );
        let before = if i == 0 {
            self.p.initial.pool_c
        } else {
            self.planned[i - 1].pool_c
        };
        // History/episode and witness rules remain the full scorer's authority.
        f64::from(policy::guidance_quarter(
            self.p,
            self.index,
            i,
            &v,
            before.unwrap_or(0.0),
        )) - q.cost
    }
    fn bound(&self, unit: u64) -> Option<u64> {
        let p = self.p;
        let b = p.battery.as_ref().unwrap();
        let n = self.commands.len() as u64;
        let size = self.axes.iter().map(Vec::len).max().unwrap() as u64;
        let b_axis = &self.axes[0];
        let step = (b_axis.last().unwrap() - b_axis[0]) / LEVELS as f64;
        let points = 64 + p.rules.len() as u64 * 6;
        let mut cost = n.checked_mul(size * 32 + 64)?;
        for (i, s) in p.slots.iter().enumerate() {
            let hours = physics::projected_hours(s);
            let demand = self.demand(i).0;
            let reach = |energy: f64| ((energy / step).ceil() as u64).saturating_add(4).min(size);
            let charging = reach(b.charge_max_w * hours / 1000.0 * b.charge_efficiency);
            let supplying = reach(
                b.discharge_max_w.min(demand.max(0.0)) * hours / 1000.0 / b.discharge_efficiency,
            );
            let exporting = if p.limits.battery_export_enabled
                && s.export_price >= p.limits.battery_export_min_price
            {
                reach(b.discharge_max_w * hours / 1000.0 / b.discharge_efficiency)
            } else {
                0
            };
            let actions = 11 + charging + supplying + exporting;
            let row = size.checked_mul(
                actions
                    .checked_mul(CARRY_COST + points + 24)?
                    .checked_add(size * 8)?,
            )?;
            cost = cost
                .checked_add(row)?
                .checked_add(actions * (CARRY_COST + points + 24))?;
        }
        // One full score and complete witness audit can still be paid after us.
        cost.checked_add(n * unit * 4 + witnesses::bound(p, unit))
    }
}
struct Values {
    rows: Vec<Vec<f64>>,
}
impl Values {
    fn at(&self, ctx: &Context, i: usize, kwh: f64) -> f64 {
        let row = &self.rows[i];
        let axis = &ctx.axes[i];
        let upper = axis.partition_point(|v| *v < kwh);
        if upper == 0 {
            return row[0];
        }
        if upper == axis.len() {
            return row[axis.len() - 1];
        }
        if kwh == axis[upper] {
            return row[upper];
        }
        let lower = upper - 1;
        if !row[lower].is_finite() || !row[upper].is_finite() {
            return row[lower].max(row[upper]);
        }
        let share = (kwh - axis[lower]) / (axis[upper] - axis[lower]);
        row[lower] + share * (row[upper] - row[lower])
    }
    fn best(&self, ctx: &Context, i: usize, kwh: f64) -> Option<(Command, f64, f64)> {
        let mut best: Option<(Command, f64, f64)> = None;
        for mut c in ctx.options(i, kwh) {
            let Some(q) = ctx.carry(i, kwh, &c) else {
                continue;
            };
            let value = ctx.value(i, &q) + self.at(ctx, i + 1, q.battery_kwh);
            if best.as_ref().is_none_or(|(_, _, old)| value > *old + 1e-9) {
                if !physics::locked(ctx.p, i)
                    && matches!(c.battery, Operation::GridCharge | Operation::Export)
                {
                    if q.charge == 0.0 && q.discharge == 0.0 {
                        c.battery = Operation::Idle;
                        c.charge_limit_w = 0.0;
                        c.discharge_limit_w = 0.0;
                    } else if c.battery == Operation::GridCharge {
                        c.charge_limit_w = q.charge;
                    } else {
                        c.discharge_limit_w = q.discharge;
                    }
                }
                best = Some((c, q.battery_kwh, value));
            }
        }
        best
    }
}
fn axes(p: &Problem, planned: &[Quarter]) -> Vec<Vec<f64>> {
    let b = p.battery.as_ref().unwrap();
    let initial = p.initial.battery_kwh.unwrap();
    let low = (b.min_soc * b.capacity_kwh).min(initial);
    let high = (b.max_soc * b.capacity_kwh).max(initial);
    let mut out: Vec<_> = (0..=LEVELS)
        .map(|i| low + (high - low) * i as f64 / LEVELS as f64)
        .collect();
    out.extend([
        initial,
        p.limits.battery_export_reserve_kwh.clamp(low, high),
    ]);
    if let Some(t) = &p.end_credit.battery {
        out.push(t.cap.clamp(low, high));
    }
    out.sort_by(f64::total_cmp);
    out.dedup();
    // Each row includes the incumbent's exact inventory. Its continuation
    // therefore need not be interpolated away when comparing a new path.
    std::iter::once(initial)
        .chain(planned.iter().map(|q| q.battery_kwh.unwrap()))
        .map(|e| {
            let mut row = out.clone();
            row.push(e);
            row.sort_by(f64::total_cmp);
            row.dedup();
            row
        })
        .collect()
}
/// Immutable continuation values from one complete battery allocation.
/// Forward responses use exact native household physics before whole-plan scoring.
pub(crate) struct Allocation {
    pub commands: Vec<Command>,
    axes: Vec<Vec<f64>>,
    values: Values,
}
#[derive(Debug)]
pub(crate) enum ResponseIssue {
    GrantUnavailable,
    Infeasible,
}
impl Allocation {
    pub fn respond(
        &self,
        p: &Problem,
        index: &policy::Index,
        commands: &[Command],
        planned: &[Quarter],
        work: &mut Work,
    ) -> Result<Vec<Command>, ResponseIssue> {
        let ctx = Context {
            p,
            index,
            commands,
            planned,
            axes: &self.axes,
        };
        // Keep the completed response's score payable while metering each
        // exact transition. A partial response is never a candidate.
        let score = p.slots.len() as u64 * work.unit_cost * 4 + witnesses::bound(p, work.unit_cost);
        if score > work.free() {
            return Err(ResponseIssue::GrantUnavailable);
        }
        work.reserved += score;
        let response = (|| {
            let mut state = physics::initial(p);
            let mut out = Vec::with_capacity(commands.len());
            for (i, command) in commands.iter().enumerate() {
                let mut options = ctx.options(i, state.battery);
                if !physics::locked(p, i) {
                    let b = p.battery.as_ref().unwrap();
                    let mut full_supply = command.clone();
                    full_supply.battery = Operation::SelfConsumption;
                    full_supply.charge_limit_w = b.charge_max_w;
                    full_supply.discharge_limit_w = b.discharge_max_w;
                    options.push(full_supply);
                }
                let size = self.axes[i + 1].len() as u64;
                let amount = size * 24
                    + options.len() as u64
                        * (work.unit_cost + 64 + p.rules.len() as u64 * 6 + size * 8);
                if !work.spend(amount) {
                    return Err(ResponseIssue::GrantUnavailable);
                }
                let mut best = None;
                for mut c in options {
                    let mut next = state.clone();
                    let Ok(q) = physics::step(p, i, &c, &mut next) else {
                        continue;
                    };
                    let value = f64::from(policy::guidance_quarter(p, index, i, &q, state.pool))
                        - q.cost
                        - q.wear
                        + self.values.at(&ctx, i + 1, next.battery);
                    if best.as_ref().is_none_or(|(_, _, old)| value > *old + 1e-9) {
                        if !physics::locked(p, i) {
                            if c.battery == Operation::GridCharge {
                                c.charge_limit_w = q.charge_w;
                            }
                            if c.battery == Operation::Export {
                                c.discharge_limit_w = q.discharge_w;
                            }
                        }
                        best = Some((c, next, value));
                    }
                }
                let (c, next, _) = best.ok_or(ResponseIssue::Infeasible)?;
                out.push(c);
                state = next;
            }
            Ok(out)
        })();
        work.reserved -= score;
        response
    }
}
/// None means a complete optional pass plus its full score could not be paid.
/// The builder alone scores and adopts the returned whole-horizon proposal.
pub(crate) fn allocate(
    p: &Problem,
    index: &policy::Index,
    commands: &[Command],
    planned: &[Quarter],
    work: &mut Work,
) -> Option<Allocation> {
    p.battery.as_ref()?;
    let axes = axes(p, planned);
    let ctx = Context {
        p,
        index,
        commands,
        planned,
        axes: &axes,
    };
    let admission = ctx.bound(work.unit_cost)?;
    if admission > work.free() {
        return None;
    }
    let score = p.slots.len() as u64 * work.unit_cost * 4 + witnesses::bound(p, work.unit_cost);
    if !work.spend(admission - score) {
        return None;
    }
    let n = commands.len();
    let mut values = Values {
        rows: ctx
            .axes
            .iter()
            .map(|row| vec![f64::NEG_INFINITY; row.len()])
            .collect(),
    };
    for (g, &e) in ctx.axes[n].iter().enumerate() {
        values.rows[n][g] = policy::battery_credit(p, e);
    }
    for i in (0..n).rev() {
        for (g, &e) in ctx.axes[i].iter().enumerate() {
            if let Some((_, _, value)) = values.best(&ctx, i, e) {
                values.rows[i][g] = value;
            }
        }
    }
    let mut kwh = p.initial.battery_kwh.unwrap();
    let mut proposal = Vec::with_capacity(n);
    for i in 0..n {
        let (c, end, _) = values.best(&ctx, i, kwh)?;
        proposal.push(c);
        kwh = end;
    }
    Some(Allocation {
        commands: proposal,
        axes,
        values,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle() -> Command {
        Command {
            pool_on: false,
            ev_amps: 0,
            battery: Operation::Idle,
            charge_limit_w: 0.0,
            discharge_limit_w: 0.0,
        }
    }
    fn work(p: &Problem) -> Work {
        Work {
            used: 0,
            limit: p.work_grant,
            reserved: 1000,
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
    fn problem(n: usize) -> Problem {
        let mut p = witnesses::tests::problem(n);
        p.rules.clear();
        p
    }
    fn proposal(p: &Problem, commands: &[Command]) -> Vec<Command> {
        let mut w = work(p);
        let index = policy::index(p, &mut w).unwrap();
        let planned = physics::projection(p, commands).unwrap();
        let out = allocate(p, &index, commands, &planned, &mut w)
            .unwrap()
            .commands;
        assert!(w.used + w.reserved <= w.limit);
        physics::projection(p, &out).unwrap();
        out
    }
    #[test]
    fn cheap_charge_is_preserved_for_the_dearer_house_load() {
        let mut p = problem(3);
        p.battery.as_mut().unwrap().capacity_kwh = 1.0;
        p.initial.battery_kwh = Some(0.0);
        for (s, (price, base)) in p
            .slots
            .iter_mut()
            .zip([(0.1, 0.0), (1.0, 1000.0), (4.0, 4000.0)])
        {
            s.import_price = price;
            s.base_w = base;
        }
        let commands = proposal(&p, &vec![idle(); 3]);
        let q = physics::projection(&p, &commands).unwrap();
        assert!((q[0].charge_w - 4000.0).abs() < 1e-7);
        assert_eq!(q[1].discharge_w, 0.0);
        assert!((q[2].discharge_w - 4000.0).abs() < 1e-7);
        assert!((q.iter().map(|q| q.cost).sum::<f64>() - 0.35).abs() < 1e-9);
    }
    #[test]
    fn declared_charge_reward_floor_is_an_exact_native_choice() {
        let mut p = problem(3);
        p.battery.as_mut().unwrap().capacity_kwh = 1.13;
        p.initial.battery_kwh = Some(0.0);
        p.slots[0].import_price = 0.9;
        p.slots[1].import_price = 1.1;
        p.slots[2].import_price = 1.1;
        p.rules = vec![Rule {
            key: RuleKey::CheapBuy,
            threshold: 0.25,
            points: 2,
            required: false,
            unless: None,
        }];
        let commands = proposal(&p, &vec![idle(); 3]);
        let q = physics::projection(&p, &commands).unwrap();
        assert!((q[0].charge_w - 500.0).abs() < 1e-7);
        let mut w = work(&p);
        let index = policy::index(&p, &mut w).unwrap();
        let account = policy::account(&p, &q, &index);
        assert_eq!(account.points, 2);
        assert!((account.score_sek - 1.8875).abs() < 1e-9);
    }
    #[test]
    fn partial_earlier_sale_leaves_full_power_for_the_higher_price() {
        let mut p = problem(2);
        let b = p.battery.as_mut().unwrap();
        b.capacity_kwh = 2.0;
        b.discharge_max_w = 1000.0;
        p.initial.battery_kwh = Some(1.375);
        p.limits.battery_export_reserve_kwh = 1.0;
        p.slots[0].export_price = 3.0;
        p.slots[1].export_price = 4.0;
        let commands = proposal(&p, &vec![idle(); 2]);
        let q = physics::projection(&p, &commands).unwrap();
        assert!((q[0].discharge_w - 500.0).abs() < 1e-7);
        assert!((q[1].discharge_w - 1000.0).abs() < 1e-7);
        assert!((q[1].battery_kwh.unwrap() - 1.0).abs() < 1e-9);
    }
    #[test]
    fn short_horizon_matches_exhaustively_enumerated_native_controls() {
        let mut p = problem(3);
        let b = p.battery.as_mut().unwrap();
        b.capacity_kwh = 1.0;
        b.charge_max_w = 1000.0;
        b.discharge_max_w = 1000.0;
        p.initial.battery_kwh = Some(0.5);
        p.limits.wear_per_kwh = 0.2;
        p.limits.import_w = 1500.0;
        p.limits.export_w = 1000.0;
        p.end_credit.reference_sek_per_kwh = 0.7;
        p.end_credit.battery = Some(StoreTerm {
            grid_kwh_per_unit: 1.0,
            cap: 0.75,
        });
        for (s, (buy, sell, load)) in
            p.slots
                .iter_mut()
                .zip([(-0.2, -0.1, 0.0), (4.0, 3.0, 750.0), (2.0, 1.0, 250.0)])
        {
            s.import_price = buy;
            s.export_price = sell;
            s.base_w = load;
        }
        let mut w = work(&p);
        let index = policy::index(&p, &mut w).unwrap();
        let score = |cs: &[Command]| {
            physics::projection(&p, cs).map(|q| policy::account(&p, &q, &index).score_sek)
        };
        let mut options = vec![idle()];
        for watts in [250.0, 500.0, 750.0, 1000.0] {
            for op in [
                Operation::GridCharge,
                Operation::SelfConsumption,
                Operation::Export,
            ] {
                let mut c = idle();
                c.battery = op;
                if op == Operation::GridCharge {
                    c.charge_limit_w = watts;
                } else {
                    c.discharge_limit_w = watts;
                }
                options.push(c);
            }
        }
        let mut oracle = f64::NEG_INFINITY;
        for a in &options {
            for b in &options {
                for c in &options {
                    if let Ok(value) = score(&[a.clone(), b.clone(), c.clone()]) {
                        oracle = oracle.max(value);
                    }
                }
            }
        }
        let actual = score(&proposal(&p, &vec![idle(); 3])).unwrap();
        assert!((actual - oracle).abs() < 1e-8, "{actual} vs {oracle}");
    }
    #[test]
    fn conditional_flows_match_full_physics_with_partial_capture_and_losses() {
        let mut p = problem(4);
        p.slots[0].start_seconds = -300.0;
        p.battery.as_mut().unwrap().charge_efficiency = 0.91;
        p.battery.as_mut().unwrap().discharge_efficiency = 0.88;
        p.limits.wear_per_kwh = 0.12;
        p.limits.export_w = 300.0;
        let mut commands = vec![idle(); 4];
        commands[0].battery = Operation::GridCharge;
        commands[0].charge_limit_w = 1200.0;
        commands[1].battery = Operation::SelfConsumption;
        commands[1].discharge_limit_w = 800.0;
        commands[1].ev_amps = 6;
        commands[2].battery = Operation::Hold;
        commands[2].charge_limit_w = 900.0;
        p.slots[2].solar_w = 8000.0;
        commands[3].battery = Operation::Export;
        commands[3].discharge_limit_w = 300.0;
        let planned = physics::projection(&p, &commands).unwrap();
        let mut w = work(&p);
        let index = policy::index(&p, &mut w).unwrap();
        let test_axes = axes(&p, &planned);
        let ctx = Context {
            p: &p,
            index: &index,
            commands: &commands,
            planned: &planned,
            axes: &test_axes,
        };
        let mut e = p.initial.battery_kwh.unwrap();
        for (i, (c, expected)) in commands.iter().zip(&planned).enumerate() {
            let q = ctx.carry(i, e, c).unwrap();
            for (a, b) in [
                (q.charge, expected.charge_w),
                (q.discharge, expected.discharge_w),
                (q.net, expected.net_w),
                (q.curtailed, expected.curtailed_w),
                (q.cost, expected.cost + expected.wear),
                (q.battery_kwh, expected.battery_kwh.unwrap()),
            ] {
                assert!((a - b).abs() < 1e-9, "quarter {i}: {a} vs {b}");
            }
            e = q.battery_kwh;
        }
    }
    #[test]
    fn appliance_move_losing_alone_wins_with_the_cached_battery_response() {
        let mut p = problem(2);
        p.battery.as_mut().unwrap().capacity_kwh = 2.0;
        p.initial.battery_kwh = Some(1.0);
        p.slots[0].base_w = 1000.0;
        p.slots[0].import_price = 0.1;
        p.slots[1].import_price = 0.9;
        p.rules = vec![Rule {
            key: RuleKey::EvFromHomeBattery,
            threshold: 0.0,
            points: -1,
            required: false,
            unless: None,
        }];
        let mut base = vec![idle(); 2];
        base[0].battery = Operation::SelfConsumption;
        base[0].discharge_limit_w = 4000.0;
        base[1].ev_amps = 6;
        let mut w = work(&p);
        let index = policy::index(&p, &mut w).unwrap();
        let planned = physics::projection(&p, &base).unwrap();
        let before = policy::account(&p, &planned, &index).score_sek;
        let allocation = allocate(&p, &index, &base, &planned, &mut w).unwrap();
        let mut changed = base.clone();
        changed[0].ev_amps = 6;
        changed[1].ev_amps = 0;
        let alone = physics::projection(&p, &changed).unwrap();
        assert!(policy::account(&p, &alone, &index).score_sek < before);
        let commands = allocation
            .respond(&p, &index, &changed, &planned, &mut w)
            .unwrap();
        let q = physics::projection(&p, &commands).unwrap();
        let after = policy::account(&p, &q, &index);
        assert!(after.score_sek > before + 0.2);
        assert_eq!(after.points, 0);
        assert_eq!((commands[0].ev_amps, commands[1].ev_amps), (6, 0));
        assert!(w.used + w.reserved <= w.limit);
    }
    #[test]
    fn response_repairs_stale_grid_infeasibility_and_restores_reserve_on_exhaustion() {
        let mut p = problem(3);
        p.limits.import_w = 1000.0;
        p.limits.battery_export_enabled = false;
        let mut base = vec![idle(); 3];
        base[2].ev_amps = 6;
        base[2].battery = Operation::SelfConsumption;
        base[2].discharge_limit_w = 4000.0;
        p.accepted = Some(base[..1].to_vec());
        p.locked_through_seconds = 900.0;
        let mut w = work(&p);
        let index = policy::index(&p, &mut w).unwrap();
        let planned = physics::projection(&p, &base).unwrap();
        let allocation = allocate(&p, &index, &base, &planned, &mut w).unwrap();
        let mut changed = base.clone();
        changed[1].ev_amps = 6;
        changed[2].ev_amps = 0;
        assert!(physics::projection(&p, &changed).is_err());
        let commands = allocation
            .respond(&p, &index, &changed, &planned, &mut w)
            .unwrap();
        assert_eq!(&commands[..1], p.accepted.as_ref().unwrap());
        assert!(physics::projection(&p, &commands)
            .unwrap()
            .iter()
            .all(|q| q.net_w <= 1000.0));
        let held = w.reserved;
        let scoring = p.slots.len() as u64 * w.unit_cost * 4 + witnesses::bound(&p, w.unit_cost);
        w.limit = w.used + held + scoring + 1;
        assert!(matches!(
            allocation.respond(&p, &index, &changed, &planned, &mut w),
            Err(ResponseIssue::GrantUnavailable)
        ));
        assert_eq!(w.reserved, held);
        assert!(w.used + w.reserved <= w.limit);
    }
    #[test]
    fn locks_survive_and_unaffordable_pass_preserves_the_work_reserve() {
        let mut p = problem(8);
        let mut commands = vec![idle(); 8];
        commands[0].battery = Operation::Hold;
        commands[0].charge_limit_w = 1234.0;
        p.accepted = Some(commands[..2].to_vec());
        p.locked_through_seconds = 1800.0;
        p.slots[7].base_w = 4000.0;
        p.slots[7].import_price = 4.0;
        let out = proposal(&p, &commands);
        assert_eq!(out[..2], commands[..2]);
        let mut w = work(&p);
        let index = policy::index(&p, &mut w).unwrap();
        let q = physics::projection(&p, &commands).unwrap();
        w.limit = w.used + w.reserved + 1;
        let used = w.used;
        assert!(allocate(&p, &index, &commands, &q, &mut w).is_none());
        assert_eq!(w.used, used);
        assert_eq!(w.reserved, 1000);
    }
}
