use crate::opportunity::Opportunity;
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
}
impl Candidate {
    fn better(&self, than: &Candidate) -> bool {
        self.account.score_sek > than.account.score_sek + policy::MIN_GAIN_SEK
    }
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
        charge_limit_w: p
            .battery
            .as_ref()
            .map_or(0.0, |b| charge.min(b.charge_max_w)),
        discharge_limit_w: p
            .battery
            .as_ref()
            .map_or(0.0, |b| discharge.min(b.discharge_max_w)),
    }
}
fn actions(p: &Problem, index: &Index, i: usize, label: &Label) -> Vec<Command> {
    if physics::locked(p, i) {
        return vec![p.accepted.as_ref().unwrap()[i].clone()];
    }
    let s = &p.slots[i];
    let h = physics::projected_hours(s);
    let f = &index.future[i];
    // Comfort and future demand propose heating; complete physics and score select it.
    let target = p.targets.pool_c.unwrap_or(0.0);
    let pool_goal = f.pool_goal;
    let pool_needed = p.pool_store.as_ref().is_some_and(|store| {
        let coast = store.idle_per_hour(pool_goal, s.outdoor_c).abs()
            * h
            * f.next_cheaper
                .saturating_sub(i)
                .max(1)
                .min(p.slots.len() - i) as f64;
        policy::rule(p, RuleKey::PoolHot).is_none_or(|r| label.state.pool < target + r.threshold)
            && store.step(label.state.pool, 0.0, s.outdoor_c, h) < pool_goal + coast
            && p.pool_stop_c.is_none_or(|stop| label.state.pool < stop)
    });
    let mut ev_levels = vec![0];
    if let Some((car, charger)) = p.car.as_ref().zip(p.charger.as_ref()) {
        let room = (p.targets.ev_limit_kwh.unwrap() - label.state.ev).max(0.0) * 1000.0
            / h
            / car.charge_efficiency;
        let need = (f.ev_goal - label.state.ev).max(0.0) * 1000.0 / h / car.charge_efficiency;
        if s.ev_available && need > 0.0 {
            let min = charger.min_current_a;
            if charger.watts(min).unwrap() <= room {
                ev_levels.push(min);
            }
            let target = charger.fitting_amps(need).max(min);
            let target = if charger.watts(target).unwrap() < need {
                target
                    .saturating_add(charger.current_step_a)
                    .min(charger.max_current_a)
            } else {
                target
            };
            if charger.watts(target).unwrap() <= room {
                ev_levels.push(target);
            }
            let max = charger.fitting_amps(room);
            if max > 0 {
                ev_levels.push(max);
            }
        }
    }
    ev_levels.sort_unstable();
    ev_levels.dedup();
    let mut out = Vec::new();
    for on in [false, true] {
        if on && !pool_needed {
            continue;
        }
        let pool_w = p
            .heater
            .as_ref()
            .zip(p.pool_store.as_ref())
            .map_or(0.0, |(heater, store)| {
                heater
                    .pool_transition(
                        store,
                        label.state.heater,
                        on,
                        shs_planner_models::PoolConditions {
                            water_c: label.state.pool,
                            outdoor_c: s.outdoor_c,
                            seconds: h * 3600.0,
                            stop_c: p.pool_stop_c,
                        },
                    )
                    .electric_w
            });
        for &amps in &ev_levels {
            let ev_w = p
                .charger
                .as_ref()
                .map_or(0.0, |charger| charger.watts(amps).unwrap());
            let Some(battery) = &p.battery else {
                out.push(command(p, on, amps, Operation::Idle, 0.0, 0.0));
                continue;
            };
            let demand = s.base_w + pool_w + ev_w - s.solar_w;
            let grid_room = (p.limits.import_w - demand).max(0.0);
            let stored = (label.state.battery - battery.min_soc * battery.capacity_kwh).max(0.0)
                * battery.discharge_efficiency;
            // Charging is worth doing up to a full battery: what it leaves at
            // the end is credited (end credit), so no demand-only ceiling.
            let headroom = (battery.max_soc * battery.capacity_kwh - label.state.battery).max(0.0)
                * 1000.0
                / h
                / battery.charge_efficiency;
            let cap = battery.charge_max_w.min(grid_room).min(headroom);
            // Automatic supply follows eligible measured demand. A forecast-sized
            // cap would suppress later appliance moves and ordinary load changes.
            out.push(command(
                p,
                on,
                amps,
                Operation::SelfConsumption,
                battery.charge_max_w,
                battery.discharge_max_w,
            ));
            out.push(command(
                p,
                on,
                amps,
                Operation::Hold,
                battery.charge_max_w,
                0.0,
            ));
            out.push(command(p, on, amps, Operation::Idle, 0.0, 0.0));
            if cap > 0.0 {
                let refill = ((f.refill_demand_kwh - stored).max(0.0) * 1000.0
                    / h
                    / battery.charge_efficiency)
                    .min(cap);
                if refill > 0.0 {
                    out.push(command(p, on, amps, Operation::GridCharge, refill, 0.0));
                }
                out.push(command(p, on, amps, Operation::GridCharge, cap, 0.0));
                // Battery power is continuous: half power is a real alternative
                // where the connection or the price curve does not suit all of it.
                out.push(command(p, on, amps, Operation::GridCharge, cap * 0.5, 0.0));
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
                    battery.discharge_max_w,
                ));
            }
        }
    }
    // Round-robin the whole pool/current cross product. Truncating halves of
    // the flat list erased high-current EV actions when battery variants grew.
    if out.len() > p.recipe.max_actions {
        let mut groups = std::collections::BTreeMap::<(bool, u32), Vec<Command>>::new();
        for c in out {
            groups.entry((c.pool_on, c.ev_amps)).or_default().push(c);
        }
        out = Vec::new();
        for variant in 0..groups.values().map(Vec::len).max().unwrap_or(0) {
            for group in groups.values() {
                if let Some(c) = group.get(variant) {
                    if out.len() < p.recipe.max_actions {
                        out.push(c.clone());
                    }
                }
            }
        }
    }
    out
}
fn rank(opportunity: &Opportunity, i: usize, l: &Label) -> (f64, f64) {
    // A point is a krona: one number ranks a partial plan, its cost breaking ties.
    let future = opportunity.to_go(i + 1, &l.state);
    let cost = l.cash + l.wear + future.cost;
    (f64::from(l.points) + future.points - cost, cost)
}

fn initial_label(p: &Problem) -> Label {
    Label {
        state: physics::initial(p),
        parent: usize::MAX,
        points: 0,
        cash: 0.0,
        wear: 0.0,
        rank: (0.0, 0.0),
    }
}

fn construct(
    p: &Problem,
    index: &Index,
    opportunity: &Opportunity,
    work: &mut Work,
) -> Result<Vec<Vec<Command>>, String> {
    let mut arena = Vec::new();
    let mut labels = vec![initial_label(p)];
    for i in 0..p.slots.len() {
        let arena_base = arena.len();
        let mut expanded = Vec::new();
        for l in &labels {
            if !work.spend(work.unit_cost * 56) {
                return Err("work_grant_cannot_complete_construction".into());
            }
            for c in actions(p, index, i, l) {
                if !work.spend(work.unit_cost + 128) {
                    return Err("work_grant_cannot_complete_construction".into());
                }
                work.expansions += 1;
                let mut next = l.clone();
                let Ok(q) = physics::step(p, i, &c, &mut next.state) else {
                    continue;
                };
                next.points += policy::guidance_quarter(p, index, i, &q, l.state.pool);
                next.cash += q.cost;
                next.wear += q.wear;
                next.rank = rank(opportunity, i, &next);
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
        // Prefer distinct joint inventory/startup cells before keeping siblings.
        // Cells are proposal diversity, not state equivalence or dominance: all
        // retained labels keep their exact physics and rule histories.
        let mut cells = std::collections::BTreeSet::new();
        let mut chosen = Vec::new();
        for (j, l) in expanded.iter().enumerate() {
            if cells.insert(opportunity.cell(&l.state)) {
                chosen.push(j);
            }
            if chosen.len() == p.recipe.beam_width {
                break;
            }
        }
        for j in 0..expanded.len() {
            if chosen.len() == p.recipe.beam_width {
                break;
            }
            if !chosen.contains(&j) {
                chosen.push(j);
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
    let finished = |l: &Label| {
        f64::from(l.points) - (l.cash + l.wear)
            + policy::end_credit(p, l.state.battery, l.state.pool, l.state.ev)
    };
    labels.sort_by(|a, b| finished(b).total_cmp(&finished(a)));
    let mut out = Vec::new();
    let mut profiles = std::collections::BTreeSet::new();
    let mut siblings = Vec::new();
    for l in labels {
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
        let mut profile = Vec::new();
        for owner in 0..3 {
            let active = |c: &Command| match owner {
                0 => c.pool_on,
                1 => c.ev_amps > 0,
                _ => c.battery == Operation::GridCharge,
            };
            let mut start = None;
            for i in 0..=commands.len() {
                if i < commands.len() && active(&commands[i]) {
                    if start.is_none() {
                        start = Some(i);
                    }
                } else if let Some(from) = start.take() {
                    profile.push((owner, from, i));
                }
            }
        }
        if profiles.insert(profile) {
            out.push(commands);
        } else {
            siblings.push(commands);
        }
        if out.len() == p.recipe.finalists {
            break;
        }
    }
    for commands in siblings {
        if out.len() == p.recipe.finalists {
            break;
        }
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
/// A candidate's account from one projection of its commands. The economic
/// certificates prove savings that are on the bill already, so they are no
/// part of a score: the audit of every family is a source of proposals
/// (`improve`) and the selected plan's report, not a cost of each candidate.
/// Economic witnesses propose improvements; they never change this account.
fn score(
    p: &Problem,
    index: &Index,
    commands: Vec<Command>,
    work: &mut Work,
) -> Result<Candidate, EvaluationIssue> {
    let n = p.slots.len() as u64;
    // Decline before projecting what could not also be accounted.
    if work.free() < n * work.unit_cost * 4 {
        return Err(EvaluationIssue::GrantUnavailable);
    }
    let quarters =
        physics::project_metered(p, &commands, work).ok_or(EvaluationIssue::Infeasible)?;
    if !work.spend(n * work.unit_cost) {
        return Err(EvaluationIssue::GrantUnavailable);
    }
    let account = policy::totals(p, &quarters, index);
    Ok(Candidate {
        commands,
        quarters,
        account,
    })
}
/// A proposal made from `base`, carried onto a plan that has since moved on.
/// Each device's change applies where the plan still holds what the proposal
/// started from; a proposal the plan has overtaken anywhere is dropped.
fn carry(base: &[Command], proposal: &[Command], onto: &[Command]) -> Option<Vec<Command>> {
    let battery = |c: &Command| (c.battery, c.charge_limit_w, c.discharge_limit_w);
    let mut out = onto.to_vec();
    for ((b, a), o) in base.iter().zip(proposal).zip(&mut out) {
        if a.pool_on != b.pool_on {
            if o.pool_on != b.pool_on {
                return None;
            }
            o.pool_on = a.pool_on;
        }
        if a.ev_amps != b.ev_amps {
            if o.ev_amps != b.ev_amps {
                return None;
            }
            o.ev_amps = a.ev_amps;
        }
        if battery(a) != battery(b) {
            if battery(o) != battery(b) {
                return None;
            }
            (o.battery, o.charge_limit_w, o.discharge_limit_w) = battery(a);
        }
    }
    Some(out)
}
/// Scores each of `count` proposals made from the incumbent and adopts the
/// best. The other improving proposals are then carried onto the new incumbent
/// in order of their gain and adopted where they still improve it, so one pass
/// takes every independent improvement it found. Returns how many proposals
/// were scored and how many adopted.
fn adopt(
    p: &Problem,
    index: &Index,
    best: &mut Candidate,
    count: usize,
    propose: impl Fn(&[Command], usize) -> Vec<Command>,
    work: &mut Work,
    declined: &mut bool,
) -> (u64, u64) {
    let base = best.commands.clone();
    let mut improving: Vec<(f64, usize)> = Vec::new();
    let mut leader: Option<(usize, Candidate)> = None;
    let mut scored = 0;
    for k in 0..count {
        let commands = propose(&base, k);
        if commands == base {
            continue;
        }
        scored += 1;
        match score(p, index, commands, work) {
            Ok(c) if c.better(best) => {
                improving.push((c.account.score_sek, k));
                if leader
                    .as_ref()
                    .is_none_or(|(_, l)| c.account.score_sek > l.account.score_sek)
                {
                    leader = Some((k, c));
                }
            }
            Ok(_) | Err(EvaluationIssue::Infeasible) => {}
            Err(EvaluationIssue::GrantUnavailable) => {
                *declined = true;
                break;
            }
        }
    }
    let Some((first, leader)) = leader else {
        return (scored, 0);
    };
    *best = leader;
    let mut adopted = 1;
    improving.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    for (_, k) in improving {
        if k == first || *declined {
            continue;
        }
        let Some(commands) = carry(&base, &propose(&base, k), &best.commands) else {
            continue;
        };
        scored += 1;
        match score(p, index, commands, work) {
            Ok(c) if c.better(best) => {
                *best = c;
                adopted += 1;
            }
            Ok(_) | Err(EvaluationIssue::Infeasible) => {}
            Err(EvaluationIssue::GrantUnavailable) => *declined = true,
        }
    }
    (scored, adopted)
}
/// Climbs from the incumbent until no proposal improves it or the grant runs
/// out. Span edits (move_resize.rs) are taken to a local optimum first; the
/// audit of every family then proposes its proven moves of energy in time,
/// and an adopted one sends the climb back to the span edits. Every proposal
/// is scored exactly, so whatever is adopted is an improvement. Returns the
/// incumbent's audit of every family when the climb ended on one.
fn improve(
    p: &Problem,
    index: &Index,
    mut best: Candidate,
    work: &mut Work,
    declined: &mut bool,
) -> (Candidate, Option<WitnessAudit>) {
    if p.recipe.repair_trials == 0 {
        return (best, None);
    }
    let mut battery_dirty = true;
    let mut allocation = None;
    loop {
        loop {
            // A whole-horizon battery allocation before appliance edits, then
            // once more when an adopted appliance schedule changes its draw.
            if battery_dirty {
                if let Some(next) =
                    battery_schedule::allocate(p, index, &best.commands, &best.quarters, work)
                {
                    match score(p, index, next.commands.clone(), work) {
                        Ok(c) if c.better(&best) => best = c,
                        Ok(_) | Err(EvaluationIssue::Infeasible) => {}
                        Err(EvaluationIssue::GrantUnavailable) => {
                            *declined = true;
                            break;
                        }
                    }
                    allocation = Some(next);
                }
            }
            if *declined {
                break;
            }
            let appliance_before: Vec<_> = best
                .commands
                .iter()
                .map(|c| (c.pool_on, c.ev_amps))
                .collect();
            let epoch = best.commands.clone();
            let Some(edits) = move_resize::proposals(p, &best.commands, &best.quarters, work)
            else {
                *declined = true;
                break;
            };
            work.move_resize_passes += 1;
            // These complete appliance moves compete with their battery response,
            // including moves infeasible under the inherited battery commands.
            let mut joint_adopted = 0;
            if let Some(response) = &allocation {
                for edit in &edits.coordinated {
                    let Some(commands) = carry(&epoch, &edit.apply(&epoch), &best.commands) else {
                        continue;
                    };
                    let commands = match response.respond(p, index, &commands, &best.quarters, work)
                    {
                        Ok(commands) => commands,
                        Err(battery_schedule::ResponseIssue::Infeasible) => continue,
                        Err(battery_schedule::ResponseIssue::GrantUnavailable) => break,
                    };
                    work.move_resize_trials += 1;
                    match score(p, index, commands, work) {
                        Ok(c) if c.better(&best) => {
                            best = c;
                            joint_adopted += 1;
                        }
                        Ok(_) | Err(EvaluationIssue::Infeasible) => {}
                        Err(EvaluationIssue::GrantUnavailable) => break,
                    }
                }
            }
            let edits = edits.singles;
            let count = edits.len().min(p.recipe.repair_trials.saturating_mul(32));
            let (scored, adopted) = adopt(
                p,
                index,
                &mut best,
                count,
                |base, k| match carry(&epoch, &edits[k].apply(&epoch), base) {
                    Some(commands) => commands,
                    None => base.to_vec(),
                },
                work,
                declined,
            );
            work.move_resize_trials += scored;
            work.move_resize_improvements += adopted + joint_adopted;
            battery_dirty = best
                .commands
                .iter()
                .zip(&appliance_before)
                .any(|(c, before)| (c.pool_on, c.ev_amps) != *before);
            if battery_dirty {
                if let Some(response) = &allocation {
                    if let Ok(commands) =
                        response.respond(p, index, &best.commands, &best.quarters, work)
                    {
                        if let Ok(c) = score(p, index, commands, work) {
                            if c.better(&best) {
                                best = c;
                            }
                        }
                    }
                }
            }
            if adopted + joint_adopted == 0 || *declined {
                break;
            }
        }
        if *declined {
            break;
        }
        if work.free() < witnesses::bound(p, work.unit_cost) {
            *declined = true;
            break;
        }
        let audit = witnesses::audit(
            p,
            &best.commands,
            &best.quarters,
            index,
            work,
            p.recipe.witness_trials,
        );
        let (scored, adopted) = adopt(
            p,
            index,
            &mut best,
            audit.repairs.len(),
            |_, k| audit.repairs[k].clone(),
            work,
            declined,
        );
        work.repairs += scored;
        battery_dirty = adopted > 0;
        if adopted == 0 {
            return (best, Some(audit));
        }
        if *declined {
            break;
        }
    }
    (best, None)
}
fn runs(p: &Problem, commands: &[Command]) -> Vec<RunPurpose> {
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
    let startup = match p.heater.as_ref().map(|h| &h.response) {
        None | Some(shs_planner_models::Response::Steady) => 0,
        Some(shs_planner_models::Response::Bergvarme { startup }) => startup.len() as u64 * 4,
    };
    let loss = match p.pool_store.as_ref().map(|s| &s.loss) {
        None | Some(shs_planner_models::StandingLoss::Linear { .. }) => 0,
        Some(shs_planner_models::StandingLoss::Measured { points }) => points.len() as u64,
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
    let construction = construction
        .checked_add(opportunity::work_bound(p, unit).ok_or("work_recipe_overflow")?)
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
        move_resize_trials: 0,
        move_resize_passes: 0,
        move_resize_improvements: 0,
    };
    let index = policy::index(p, &mut work)?;
    let opportunity = Opportunity::prepare(p, &index, &mut work)?;
    let proposals = construct(p, &index, &opportunity, &mut work)?;

    // The selected plan's report is an audit of every family. Set its cost
    // aside while the search spends, unless that would take the search's half.
    let report_cost = witnesses::bound(p, unit);
    let held = if work.free() >= report_cost.saturating_mul(2) {
        report_cost
    } else {
        0
    };
    work.reserved += held;
    let mut budget_declined = false;
    let mut candidates = Vec::new();
    for commands in proposals {
        match score(p, &index, commands, &mut work) {
            Ok(c) => candidates.push(c),
            Err(EvaluationIssue::GrantUnavailable) => budget_declined = true,
            Err(EvaluationIssue::Infeasible) => {}
        }
    }
    if candidates.is_empty() {
        return Err("no_complete_candidate".into());
    }
    candidates.sort_by(|a, b| b.account.score_sek.total_cmp(&a.account.score_sek));
    // Construction rank is not the rank after local refinement. Give every
    // distinct finalist a share of half the remaining grant, then spend the
    // rest climbing from the best refined candidate. All compete on the same
    // complete objective; this is one search, not an alternate cost policy.
    let ceiling = work.limit;
    let trial_grant = work.free() / 2 / candidates.len() as u64;
    let mut best: Option<Candidate> = None;
    for candidate in candidates {
        work.limit = work.used + work.reserved + trial_grant;
        let mut trial_declined = false;
        let (candidate, _) = improve(p, &index, candidate, &mut work, &mut trial_declined);
        work.limit = ceiling;
        if best.as_ref().is_none_or(|b| candidate.better(b)) {
            best = Some(candidate);
        }
    }
    let best = best.unwrap();
    let (best, report) = improve(p, &index, best, &mut work, &mut budget_declined);
    work.reserved -= held;
    let report = report.unwrap_or_else(|| {
        witnesses::audit(
            p,
            &best.commands,
            &best.quarters,
            &index,
            &mut work,
            p.recipe.witness_trials,
        )
    });
    work.reserved = 0;
    let certified = physics::project_metered(p, &best.commands, &mut work)
        .ok_or("work_grant_cannot_certify")?;
    if !work.spend(n * unit) {
        return Err("work_grant_cannot_certify".into());
    }
    let account = policy::account(p, &certified, &index);
    if certified != best.quarters
        || account.points != best.account.points
        || account.score_sek != best.account.score_sek
        || account.cash_sek != best.account.cash_sek
        || account.wear_sek != best.account.wear_sek
    {
        return Err("account_parity".into());
    }
    for (i, c) in best.commands.iter().enumerate() {
        if physics::locked(p, i) && c != &p.accepted.as_ref().unwrap()[i] {
            return Err("commitment_changed".into());
        }
    }
    let run_purposes = runs(p, &best.commands);
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
        witness_coverage: report.coverage,
        economic: report.economic,
        runs: run_purposes,
        work,
    })
}

#[cfg(test)]
mod move_resize_tests {
    use super::*;
    fn work(p: &Problem) -> Work {
        Work {
            used: 0,
            limit: p.work_grant,
            reserved: 10000,
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
    fn idle() -> Command {
        Command {
            pool_on: false,
            ev_amps: 0,
            battery: Operation::Hold,
            charge_limit_w: 1000.0,
            discharge_limit_w: 4000.0,
        }
    }
    #[test]
    fn one_pass_adopts_the_best_proposal_and_carries_an_independent_one_onto_it() {
        let mut p = witnesses::tests::problem(24);
        p.rules.clear();
        for (i, slot) in p.slots.iter_mut().enumerate() {
            slot.import_price = if i < 8 { 0.9 } else { 1.1 };
        }
        let mut commands = vec![idle(); 24];
        commands[18].pool_on = true;
        commands[18].ev_amps = 6;
        let mut work = work(&p);
        let index = policy::index(&p, &mut work).unwrap();
        let mut best = score(&p, &index, commands.clone(), &mut work).ok().unwrap();
        // The pool to a quarter as dear, the car to a cheap one, the pool to a cheap one.
        let mut sideways = commands.clone();
        sideways[18].pool_on = false;
        sideways[20].pool_on = true;
        let mut car = commands.clone();
        car[18].ev_amps = 0;
        car[3].ev_amps = 6;
        let mut pool = commands.clone();
        pool[18].pool_on = false;
        pool[2].pool_on = true;
        let proposals = [sideways, car, pool.clone()];
        let mut declined = false;
        let (scored, adopted) = adopt(
            &p,
            &index,
            &mut best,
            proposals.len(),
            |_, k| proposals[k].clone(),
            &mut work,
            &mut declined,
        );
        // Three scored; the pool's saves most, and the car's is scored again on top of it.
        assert_eq!((scored, adopted, declined), (4, 2, false));
        assert!(best.commands[2].pool_on && !best.commands[18].pool_on);
        assert_eq!(
            (best.commands[3].ev_amps, best.commands[18].ev_amps),
            (6, 0)
        );
        // A proposal the plan has overtaken is dropped, not forced onto it.
        assert!(carry(&commands, &pool, &best.commands).is_none());
    }
    #[test]
    fn exhausted_improvement_budget_keeps_a_fully_audited_incumbent_and_certification_reserve() {
        let p = witnesses::tests::problem(8);
        let mut work = work(&p);
        let index = policy::index(&p, &mut work).unwrap();
        let before = score(&p, &index, vec![idle(); 8], &mut work).ok().unwrap();
        let expected = before.commands.clone();
        work.limit = work.used + work.reserved + 1;
        let mut declined = false;
        let (after, _) = improve(&p, &index, before, &mut work, &mut declined);
        assert_eq!(after.commands, expected);
        assert!(declined);
        assert_eq!(work.reserved, 10000);
        assert!(work.used + work.reserved <= work.limit);
    }
}

#[cfg(test)]
mod forecast_tests {
    use super::*;
    fn work(p: &Problem) -> Work {
        Work {
            used: 0,
            limit: p.work_grant,
            reserved: 10000,
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
    fn pool_problem() -> Problem {
        let mut p = witnesses::tests::problem(12);
        p.battery = None;
        p.initial.battery_kwh = None;
        p.car = None;
        p.charger = None;
        p.initial.ev_kwh = None;
        p.targets.ev_km = None;
        p.targets.ev_limit_kwh = None;
        p.initial.pool_c = Some(29.7);
        p.pool_store.as_mut().unwrap().loss = shs_planner_models::StandingLoss::Linear {
            kw_per_c: 0.05,
            surroundings_c: Some(20.0),
        };
        p.recipe.beam_width = 32;
        p.recipe.max_actions = 32;
        p.recipe.finalists = 4;
        p.recipe.witness_trials = 12;
        p.recipe.repair_trials = 8;
        p.rules = vec![
            Rule {
                key: RuleKey::PoolLow,
                threshold: 1.0,
                points: -1,
                required: false,
            },
            Rule {
                key: RuleKey::PoolCold,
                threshold: 2.0,
                points: -1,
                required: true,
            },
            Rule {
                key: RuleKey::PoolHot,
                threshold: 2.0,
                points: -1,
                required: false,
            },
        ];
        for (i, s) in p.slots.iter_mut().enumerate() {
            s.import_price = if (4..7).contains(&i) {
                0.5
            } else {
                2.0 + i as f64 / 100.0
            };
        }
        p
    }
    #[test]
    fn pool_search_matches_exhaustive_fully_audited_small_horizon() {
        for variant in 0..4 {
            let mut p = pool_problem();
            match variant {
                1 => {
                    for (i, s) in p.slots.iter_mut().enumerate() {
                        s.import_price = if i < 3 { 0.5 } else { 2.0 + i as f64 / 100.0 };
                    }
                }
                2 => {
                    p.initial.pool_c = Some(28.05);
                    p.pool_store.as_mut().unwrap().loss =
                        shs_planner_models::StandingLoss::Linear {
                            kw_per_c: 0.5,
                            surroundings_c: Some(20.0),
                        };
                }
                3 => {
                    p.accepted = Some(
                        (0..4)
                            .map(|i| Command {
                                pool_on: i % 2 == 0,
                                ..idle()
                            })
                            .collect(),
                    );
                    p.locked_through_seconds = 3600.0;
                }
                _ => {}
            }
            let mut w = work(&p);
            let index = policy::index(&p, &mut w).unwrap();
            let mut oracle: Option<Account> = None;
            for bits in 0..1usize << p.slots.len() {
                let commands: Vec<_> = (0..p.slots.len())
                    .map(|i| Command {
                        pool_on: bits & (1 << i) != 0,
                        ..idle()
                    })
                    .collect();
                let Ok(candidate) = score(&p, &index, commands, &mut work(&p)) else {
                    continue;
                };
                if oracle.as_ref().is_none_or(|old| {
                    candidate.account.score_sek > old.score_sek + policy::MIN_GAIN_SEK
                }) {
                    oracle = Some(candidate.account);
                }
            }
            let selected = solve(&p).unwrap();
            let oracle = oracle.unwrap();
            assert_eq!(selected.account.points, oracle.points, "variant {variant}");
            assert!(
                (selected.account.cash_sek - oracle.cash_sek).abs() < 1e-8,
                "variant {variant}: {} vs {}",
                selected.account.cash_sek,
                oracle.cash_sek
            );
            if variant == 3 {
                assert_eq!(&selected.commands[..4], p.accepted.as_ref().unwrap());
            }
        }
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
    #[test]
    fn action_limit_preserves_high_ev_current_with_pool_and_battery_choices() {
        let mut p = witnesses::tests::problem(24);
        p.recipe.max_actions = 32;
        p.initial.pool_c = Some(29.0);
        p.targets.ev_km = Some(250.0);
        p.rules.clear();
        for s in &mut p.slots {
            s.base_w = 1000.0;
        }
        let index = policy::index(&p, &mut work(&p)).unwrap();
        let choices = actions(&p, &index, 0, &initial_label(&p));
        assert_eq!(choices.len(), p.recipe.max_actions);
        for pool_on in [false, true] {
            assert!(choices
                .iter()
                .any(|c| c.pool_on == pool_on
                    && c.ev_amps == p.charger.as_ref().unwrap().max_current_a));
        }
    }
    #[test]
    fn automatic_supply_proposal_follows_changed_pool_demand_without_serving_ev() {
        let mut p = witnesses::tests::problem(1);
        p.slots[0].base_w = 1000.0;
        p.targets.ev_km = Some(100.0);
        let index = policy::index(&p, &mut work(&p)).unwrap();
        let mut c = actions(&p, &index, 0, &initial_label(&p))
            .into_iter()
            .find(|c| !c.pool_on && c.ev_amps == 6 && c.battery == Operation::SelfConsumption)
            .unwrap();
        assert_eq!(c.discharge_limit_w, 4000.0);
        assert_eq!(
            physics::projection(&p, &[c.clone()]).unwrap()[0].discharge_w,
            1000.0
        );
        c.pool_on = true;
        let q = physics::projection(&p, &[c.clone()]).unwrap();
        assert_eq!(q[0].discharge_w, 4000.0);
        assert_eq!(q[0].ev_w, 1380.0);
        p.slots[0].solar_w = 2690.0;
        let q = physics::project_external(&p, &[c]).unwrap();
        assert_eq!(q[0].discharge_w, 2000.0);
    }
}
