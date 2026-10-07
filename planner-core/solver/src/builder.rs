use crate::physics::{self, State};
use crate::policy::{self, Index};
use crate::*;

#[derive(Clone)]
struct Label {
    state: State,
    parent: usize,
    points: i32,
    cash: f64,
    wear: f64,
    last_charge: f64,
    prepared: bool,
    pool_last: Option<usize>,
    ev_last: Option<usize>,
    gap_estimate: f64,
    rank: (f64, f64),
}
#[derive(Clone)]
struct Node {
    parent: usize,
    command: Command,
}
struct Candidate {
    commands: Vec<Command>,
    quarters: Vec<Quarter>,
    account: Account,
    audit: WitnessAudit,
}

fn command(
    p: &Problem,
    pool_on: bool,
    ev_amps: u32,
    battery: Operation,
    charge: f64,
    discharge: f64,
) -> Command {
    Command {
        pool_on,
        ev_amps,
        battery,
        charge_limit_w: charge.min(p.battery.charge_max_w),
        discharge_limit_w: discharge.min(p.battery.discharge_max_w),
    }
}
fn actions(p: &Problem, index: &Index, i: usize, label: &Label) -> Vec<Command> {
    if physics::locked(p, i) {
        return vec![p.accepted.as_ref().unwrap()[i].clone()];
    }
    let s = &p.slots[i];
    let h = physics::projected_hours(s);
    let f = &index.future[i];
    // Purpose: service or forecast thermal reserve. Extra heat merely to earn a
    // cheap-load point has no proposal; this is guidance, not a physical ceiling.
    let coast = p.pool_store.idle_per_hour(f.pool_goal, s.outdoor_c).abs()
        * h
        * f.next_cheaper
            .saturating_sub(i)
            .max(
                if policy::rule(p, RuleKey::PoolShortGap).is_some_and(|r| r.points < 0) {
                    5
                } else {
                    1
                },
            )
            .min(p.slots.len() - i) as f64;
    let pool_needed =
        p.pool_store.step(label.state.pool, 0.0, s.outdoor_c, h) < f.pool_goal + coast;
    let mut ev_levels = vec![0];
    let room =
        (p.targets.ev_limit_kwh - label.state.ev).max(0.0) * 1000.0 / h / p.car.charge_efficiency;
    let need = (f.ev_goal - label.state.ev).max(0.0) * 1000.0 / h / p.car.charge_efficiency;
    if need > 0.0 {
        let min = p.charger.min_current_a;
        if p.charger.watts(min).unwrap() <= room {
            ev_levels.push(min);
        }
        let target = p.charger.fitting_amps(need).max(min);
        let target = if p.charger.watts(target).unwrap() < need {
            target
                .saturating_add(p.charger.current_step_a)
                .min(p.charger.max_current_a)
        } else {
            target
        };
        if p.charger.watts(target).unwrap() <= room {
            ev_levels.push(target);
        }
        let max = p.charger.fitting_amps(room);
        if max > 0 {
            ev_levels.push(max);
        }
    }
    ev_levels.sort_unstable();
    ev_levels.dedup();
    let mut out = Vec::new();
    for on in [false, true] {
        if on && !pool_needed {
            continue;
        }
        let (pool_w, _, _) = p.heater.step(on, label.state.age, h * 3600.0);
        for &amps in &ev_levels {
            let ev_w = p.charger.watts(amps).unwrap();
            let demand = s.base_w + pool_w + ev_w - s.solar_w;
            let available = p.battery.available_discharge_w(label.state.battery, h);
            let grid_room = (p.limits.import_w - demand).max(0.0);
            let stored = (label.state.battery - p.battery.min_soc * p.battery.capacity_kwh)
                .max(0.0)
                * p.battery.discharge_efficiency;
            let useful =
                (f.demand_kwh - stored).max(0.0) * 1000.0 / h / p.battery.charge_efficiency;
            let cap = p.battery.charge_max_w.min(grid_room).min(useful);
            // Joint templates compete through exact coupled physics. EV-on can
            // coexist with house-only supply; no blanket battery prohibition.
            out.push(command(
                p,
                on,
                amps,
                Operation::SelfConsumption,
                p.battery.charge_max_w,
                if amps == 0 {
                    p.battery.discharge_max_w
                } else {
                    (s.base_w + pool_w - s.solar_w).max(0.0).min(available)
                },
            ));
            out.push(command(
                p,
                on,
                amps,
                Operation::SelfConsumption,
                p.battery.charge_max_w,
                0.0,
            ));
            if cap > 0.0 {
                // The same useful energy can be spread over cheaper quarters;
                // native battery power is continuous, unlike EV amp commands.
                let thin = cap.min(500.0);
                out.push(command(p, on, amps, Operation::GridCharge, thin, 0.0));
                let refill = ((f.refill_demand_kwh - stored).max(0.0) * 1000.0
                    / h
                    / p.battery.charge_efficiency)
                    .min(cap);
                if refill > 0.0 {
                    out.push(command(p, on, amps, Operation::GridCharge, refill, 0.0));
                }
                out.push(command(p, on, amps, Operation::GridCharge, cap, 0.0));
                let overlap =
                    policy::rule(p, RuleKey::LargeLoadOverlap).map_or(cap, |r| r.threshold);
                let broad = cap.min(overlap);
                if broad > 0.0 {
                    out.push(command(p, on, amps, Operation::GridCharge, broad, 0.0));
                }
            }
            if p.limits.battery_export_enabled
                && s.export_price >= p.limits.battery_export_min_price
                && label.state.battery > p.limits.battery_export_reserve_kwh
            {
                out.push(command(
                    p,
                    on,
                    amps,
                    Operation::Export,
                    0.0,
                    p.battery.discharge_max_w,
                ));
            }
        }
    }
    // Round-robin pool/EV template order avoids truncating all alternatives of
    // one device. Every tested action, including rejected ones, is metered.
    if out.len() > p.recipe.max_actions {
        let all = out;
        out = Vec::new();
        let half = all.len().div_ceil(2);
        for k in 0..half {
            for j in [k, k + half] {
                if j < all.len() && out.len() < p.recipe.max_actions {
                    out.push(all[j].clone());
                }
            }
        }
    }
    out
}
fn estimate(p: &Problem, index: &Index, i: usize, l: &Label) -> f64 {
    let f = &index.future[i];
    let floor = p
        .initial
        .pool_c
        .min(p.targets.pool_c - p.service_guard.pool[0]);
    let buffer_level = policy::rule(p, RuleKey::PoolBuffer).map_or(p.targets.pool_c, |r| {
        p.targets.pool_c + r.threshold + 0.0005
    });
    let pool = (l.state.pool - floor) / (buffer_level - floor).max(f64::EPSILON);
    // Credit only service exposure that cannot be recovered before eligibility.
    // Filling the EV early earns no invented horizon-wide progress bonus.
    let max_gain =
        p.charger.watts(p.charger.max_current_a).unwrap() * 0.25 / 1000.0 * p.car.charge_efficiency;
    let mut service = 0.0;
    for (level, key) in [RuleKey::EvLow, RuleKey::EvShort].into_iter().enumerate() {
        if let Some(r) = policy::rule(p, key) {
            let deficit =
                (p.targets.ev_km - p.service_guard.ev[level]) * p.car.kwh_per_km - l.state.ev;
            let catchup = (deficit.max(0.0) / max_gain).ceil() as usize;
            let exposed = (i + catchup).saturating_sub(index.due[2 + level].max(i + 1));
            service -= exposed as f64 * (-r.points).max(0) as f64;
        }
    }
    let warming = ((buffer_level - floor).max(0.0) * p.pool_store.capacity_kwh_per_c
        / (p.heater.heat_w / 4000.0))
        .ceil()
        .max(1.0);
    f.useful_pool_quarters.min(warming) * pool.clamp(0.0, 1.0) + service + l.gap_estimate
}
fn rank(p: &Problem, index: &Index, i: usize, l: &Label) -> (f64, f64) {
    let future = estimate(p, index, i, l);
    let mut stored = (l.state.battery - p.battery.min_soc * p.battery.capacity_kwh).max(0.0)
        * p.battery.discharge_efficiency;
    let mut value = 0.0;
    for &(demand, price) in &index.future[i].battery_value_curve {
        let used = stored.min(demand);
        value += used * price;
        stored -= used;
        if stored <= 0.0 {
            break;
        }
    }
    (f64::from(l.points) + future, l.cash + l.wear - value)
}
fn gap_estimate(p: &Problem, i: usize, last: Option<usize>, key: RuleKey) -> f64 {
    let Some(last) = last else { return 0.0 };
    let gap = i - last - 1;
    if !(1..=4).contains(&gap) {
        return 0.0;
    }
    let Some(r) = policy::rule(p, key) else {
        return 0.0;
    };
    let border = p.slots[last].import_price;
    let restart = p.slots[i].import_price;
    if (last + 1..i).all(|j| {
        let price = p.slots[j].import_price;
        let t = r.threshold.max(price.abs() * 0.1);
        (price - border).abs() <= t + 1e-9 && (price - restart).abs() <= t + 1e-9
    }) {
        f64::from(r.points) * gap as f64
    } else {
        0.0
    }
}
fn construct(p: &Problem, index: &Index, work: &mut Work) -> Result<Vec<Vec<Command>>, String> {
    let mut arena = Vec::new();
    let mut labels = vec![Label {
        state: physics::initial(p),
        parent: usize::MAX,
        points: 0,
        cash: 0.0,
        wear: 0.0,
        last_charge: p.initial.battery_kwh,
        prepared: false,
        pool_last: None,
        ev_last: None,
        gap_estimate: 0.0,
        rank: (0.0, 0.0),
    }];
    for i in 0..p.slots.len() {
        let arena_base = arena.len();
        let mut expanded = Vec::new();
        for l in &labels {
            if !work.spend(work.unit_cost * 56) {
                return Err("work_grant_cannot_complete_construction".into());
            }
            for c in actions(p, index, i, l) {
                if !work
                    .spend(work.unit_cost + index.future[i].battery_value_curve.len() as u64 * 8)
                {
                    return Err("work_grant_cannot_complete_construction".into());
                }
                work.expansions += 1;
                let mut next = l.clone();
                let Ok(q) = physics::step(p, i, &c, &mut next.state) else {
                    continue;
                };
                if index.first_sale == Some(i) {
                    next.prepared =
                        policy::measured(l.last_charge / p.battery.capacity_kwh * 100.0, 10.0)
                            >= 100.0;
                }
                if policy::measured(q.charge_w, 10.0) > 0.0 {
                    next.last_charge = q.battery_kwh;
                }
                next.points += policy::quarter(p, index, i, &q, next.prepared)
                    .iter()
                    .sum::<i32>();
                next.cash += q.cost;
                next.wear += q.wear;
                if c.pool_on {
                    next.gap_estimate += gap_estimate(p, i, l.pool_last, RuleKey::PoolShortGap);
                    next.pool_last = Some(i);
                }
                if c.ev_amps > 0 {
                    next.gap_estimate += gap_estimate(p, i, l.ev_last, RuleKey::EvShortGap);
                    next.ev_last = Some(i);
                }
                next.rank = rank(p, index, i, &next);
                let parent = arena.len();
                arena.push(Node {
                    parent: l.parent,
                    command: c,
                });
                next.parent = parent;
                expanded.push(next);
            }
        }
        if expanded.is_empty() {
            return Err("no_complete_native_trajectory".into());
        }
        if !work.spend(expanded.len() as u64 * (work.unit_cost + expanded.len().ilog2() as u64 * 4))
        {
            return Err("work_grant_cannot_rank".into());
        }
        expanded.sort_by(|a, b| {
            let ra = a.rank;
            let rb = b.rank;
            rb.0.total_cmp(&ra.0).then(ra.1.total_cmp(&rb.1))
        });
        // Preserve one useful-store alternative per owner, preventing an early
        // local reward from erasing all slower-starting useful trajectories.
        let mut chosen: Vec<usize> =
            (0..p.recipe.beam_width.saturating_sub(3).min(expanded.len())).collect();
        for owner in 0..3 {
            let best = (0..expanded.len())
                .filter(|k| !chosen.contains(k))
                .max_by(|a, b| {
                    let inventory = |l: &Label| match owner {
                        0 => l.state.pool.min(index.future[i].pool_goal),
                        1 => l.state.ev.min(index.future[i].ev_goal),
                        _ => l.state.battery,
                    };
                    inventory(&expanded[*a])
                        .total_cmp(&inventory(&expanded[*b]))
                        .then(b.cmp(a))
                });
            if let Some(best) = best {
                if chosen.len() < p.recipe.beam_width {
                    chosen.push(best);
                }
            }
        }
        if chosen.is_empty() {
            chosen.push(0);
        }
        let retained: Vec<(Label, Node)> = chosen
            .into_iter()
            .map(|j| (expanded[j].clone(), arena[expanded[j].parent].clone()))
            .collect();
        arena.truncate(arena_base);
        labels = retained
            .into_iter()
            .map(|(mut l, node)| {
                l.parent = arena.len();
                arena.push(node);
                l
            })
            .collect();
    }
    labels.sort_by(|a, b| {
        b.points
            .cmp(&a.points)
            .then((a.cash + a.wear).total_cmp(&(b.cash + b.wear)))
    });
    let mut out = Vec::new();
    for l in labels.into_iter().take(p.recipe.finalists) {
        if !work.spend(p.slots.len() as u64 * work.unit_cost) {
            break;
        }
        let mut commands = Vec::with_capacity(p.slots.len());
        let mut at = l.parent;
        while at != usize::MAX {
            commands.push(arena[at].command.clone());
            at = arena[at].parent;
        }
        commands.reverse();
        out.push(commands);
    }
    if out.is_empty() {
        return Err("work_grant_cannot_reconstruct".into());
    }
    Ok(out)
}
enum EvaluationIssue {
    GrantUnavailable,
    Infeasible,
}
fn evaluate(
    p: &Problem,
    index: &Index,
    commands: Vec<Command>,
    work: &mut Work,
) -> Result<Candidate, EvaluationIssue> {
    // Every candidate receives the same complete bounded audit allocation.
    // Decline a new candidate before projection when its audit cannot be paid.
    let n = p.slots.len() as u64;
    let cap = p.recipe.witness_trials.clamp(1, 16) as u64;
    let audit_cost = n
        .saturating_mul(n)
        .saturating_mul(32 + cap * 8)
        .saturating_add(n.saturating_mul(256 + u64::from(p.charger.max_current_a) * 4))
        .saturating_add(
            (p.recipe.witness_trials as u64)
                .saturating_mul(n)
                .saturating_mul(96 + u64::from(p.charger.max_current_a) + work.unit_cost * 2),
        );
    if work
        .limit
        .saturating_sub(work.used)
        .saturating_sub(work.reserved)
        < audit_cost.saturating_add(n * work.unit_cost * 3)
    {
        return Err(EvaluationIssue::GrantUnavailable);
    }
    let quarters =
        physics::project_metered(p, &commands, work).ok_or(EvaluationIssue::Infeasible)?;
    if !work.spend(p.slots.len() as u64 * work.unit_cost) {
        return Err(EvaluationIssue::GrantUnavailable);
    }
    let mut account = policy::account(p, &quarters, index);
    let audit = witnesses::audit(
        p,
        &commands,
        &quarters,
        index,
        work,
        p.recipe.witness_trials,
    );
    policy::witnessed(p, &mut account, &audit, &quarters, index);
    Ok(Candidate {
        commands,
        quarters,
        account,
        audit,
    })
}
fn runs(p: &Problem, index: &Index, commands: &[Command]) -> Vec<RunPurpose> {
    let mut out = Vec::new();
    for device in ["pool", "ev", "battery"] {
        let mut from = 0;
        while from < commands.len() {
            let active = |i: usize| match device {
                "pool" => commands[i].pool_on,
                "ev" => commands[i].ev_amps > 0,
                _ => commands[i].battery == Operation::GridCharge,
            };
            if !active(from) {
                from += 1;
                continue;
            }
            let mut to = from + 1;
            while to < commands.len() && active(to) {
                to += 1;
            }
            let purpose = if physics::locked(p, from) {
                "accepted_command"
            } else if device == "pool" && index.buffer[from] == Some(true) {
                "thermal_buffer"
            } else if device == "battery" {
                "forecast_demand_or_permitted_sale"
            } else {
                "service"
            };
            out.push(RunPurpose {
                device,
                from,
                to,
                purpose,
            });
            from = to;
        }
    }
    out
}
pub(crate) fn solve(p: &Problem) -> Result<Selection, String> {
    validate(p)?;
    let n = p.slots.len() as u64;
    let startup = match &p.heater.response {
        shs_planner_models::Response::Steady => 0,
        shs_planner_models::Response::Bergvarme { startup } => startup.len() as u64 * 4,
    };
    let loss = match &p.pool_store.loss {
        shs_planner_models::StandingLoss::Linear { .. } => 0,
        shs_planner_models::StandingLoss::Measured { points } => points.len() as u64,
    };
    let unit = 96 + startup + loss + p.rules.len() as u64 * 6;
    let reserved = n
        .checked_mul(unit)
        .and_then(|v| v.checked_mul(4))
        .ok_or("work_recipe_overflow")?;
    let construction = n
        .checked_mul(unit)
        .and_then(|v| {
            v.checked_mul(
                6u64.checked_add(
                    3u64.checked_mul(p.recipe.beam_width as u64)?
                        .checked_mul(p.recipe.max_actions as u64)?,
                )?,
            )
        })
        .and_then(|v| v.checked_add(reserved))
        .ok_or("work_recipe_overflow")?;
    if p.work_grant < construction {
        return Err("work_grant_cannot_construct_and_certify".into());
    }
    let mut work = Work {
        used: 0,
        limit: p.work_grant,
        reserved,
        unit_cost: unit,
        expansions: 0,
        evaluations: 0,
        witness_trials: 0,
        repairs: 0,
    };
    let index = policy::index(p, &mut work)?;
    let mut proposals = construct(p, &index, &mut work)?;
    if let Some(seed) = &p.accepted {
        proposals.push(seed.clone());
    }
    let mut candidates = Vec::new();
    let mut budget_declined = false;
    for commands in proposals {
        match evaluate(p, &index, commands, &mut work) {
            Ok(c) => candidates.push(c),
            Err(EvaluationIssue::GrantUnavailable) => budget_declined = true,
            Err(EvaluationIssue::Infeasible) => {}
        }
    }
    candidates.sort_by(|a, b| {
        b.account.points.cmp(&a.account.points).then(
            (a.account.cash_sek + a.account.wear_sek)
                .total_cmp(&(b.account.cash_sek + b.account.wear_sek)),
        )
    });
    let best = candidates.first().ok_or("no_complete_candidate")?;
    let mut repairs = best.audit.repairs.clone();
    repairs.sort_by(|a, b| {
        b.expected_points
            .cmp(&a.expected_points)
            .then(a.family.cmp(&b.family))
    });
    // Combine independent, nonconflicting gap edits as one extra proposal.
    // Their individual certificates are not assumed to compose: reproject and
    // fully audit the resulting schedule before it can win.
    let mut batch = best.commands.clone();
    let mut touched = vec![false; batch.len()];
    let mut combined = 0;
    for repair in &repairs {
        if !matches!(repair.family.as_str(), "pool_short_gap" | "ev_short_gap")
            || repair.expected_points <= 0
        {
            continue;
        }
        let changed: Vec<usize> = repair
            .commands
            .iter()
            .zip(&best.commands)
            .enumerate()
            .filter_map(|(i, (a, b))| (a != b).then_some(i))
            .collect();
        if changed
            .iter()
            .any(|&i| touched[i] && batch[i] != repair.commands[i])
        {
            continue;
        }
        for i in changed {
            batch[i] = repair.commands[i].clone();
            touched[i] = true;
        }
        combined += 1;
    }
    if combined > 1 {
        work.repairs += 1;
        match evaluate(p, &index, batch, &mut work) {
            Ok(c) => candidates.push(c),
            Err(EvaluationIssue::GrantUnavailable) => budget_declined = true,
            Err(EvaluationIssue::Infeasible) => {}
        }
    }
    for repair in repairs.into_iter().take(p.recipe.repair_trials) {
        work.repairs += 1;
        match evaluate(p, &index, repair.commands, &mut work) {
            Ok(c) => candidates.push(c),
            Err(EvaluationIssue::GrantUnavailable) => budget_declined = true,
            Err(EvaluationIssue::Infeasible) => {}
        }
    }
    let best = candidates
        .into_iter()
        .reduce(|a, b| {
            if policy::better(&b.account, &a.account) {
                b
            } else {
                a
            }
        })
        .ok_or("no_complete_candidate")?;
    work.reserved = 0;
    let certified = physics::project_metered(p, &best.commands, &mut work)
        .ok_or("work_grant_cannot_certify")?;
    if !work.spend(n * unit) {
        return Err("work_grant_cannot_certify".into());
    }
    let mut account = policy::account(p, &certified, &index);
    policy::witnessed(p, &mut account, &best.audit, &certified, &index);
    if certified != best.quarters
        || account.points != best.account.points
        || account.cash_sek != best.account.cash_sek
        || account.wear_sek != best.account.wear_sek
        || account.contributions != best.account.contributions
    {
        return Err("account_parity".into());
    }
    for (i, c) in best.commands.iter().enumerate() {
        if physics::locked(p, i) && c != &p.accepted.as_ref().unwrap()[i] {
            return Err("commitment_changed".into());
        }
    }
    let run_purposes = runs(p, &index, &best.commands);
    let termination = if budget_declined {
        "grant_exhausted"
    } else {
        "bounded_complete"
    };
    Ok(Selection {
        commands: best.commands,
        quarters: certified,
        account,
        work_used: work.used,
        evaluations: work.evaluations,
        termination,
        witness_coverage: best.audit.coverage,
        economic: best.audit.economic,
        runs: run_purposes,
        work,
    })
}
