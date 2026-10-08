use crate::physics::{self, State};
use crate::policy::{self, Index};
use crate::*;

#[derive(Clone)]
struct Label {
    buffer_episode: thermal_buffer::Credit,
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
    // Purpose: service or forecast thermal reserve. Extra heat merely to earn a
    // cheap-load point has no proposal; this is guidance, not a physical ceiling.
    let target = p.targets.pool_c.unwrap_or(0.0);
    let pool_goal = match label.buffer_episode.episode {
        thermal_buffer::Episode::Active(need) if i <= need.quarter => {
            policy::rule(p, RuleKey::PoolBuffer)
                .filter(|r| r.points > 0)
                .map_or(target, |r| target + r.threshold + 0.0005)
        }
        thermal_buffer::Episode::Available
            if label
                .buffer_episode
                .available(index.thermal_buffer.causes[i]) =>
        {
            f.pool_goal
        }
        _ => target,
    };
    let pool_needed = p.pool_store.as_ref().is_some_and(|store| {
        let coast = store.idle_per_hour(pool_goal, s.outdoor_c).abs()
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
        store.step(label.state.pool, 0.0, s.outdoor_c, h) < pool_goal + coast
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
            let available = battery.available_discharge_w(label.state.battery, h);
            let grid_room = (p.limits.import_w - demand).max(0.0);
            let stored = (label.state.battery - battery.min_soc * battery.capacity_kwh).max(0.0)
                * battery.discharge_efficiency;
            let useful = (f.demand_kwh - stored).max(0.0) * 1000.0 / h / battery.charge_efficiency;
            let cap = battery.charge_max_w.min(grid_room).min(useful);
            // Joint templates compete through exact coupled physics. EV-on can
            // coexist with house-only supply; no blanket battery prohibition.
            out.push(command(
                p,
                on,
                amps,
                Operation::SelfConsumption,
                battery.charge_max_w,
                if amps == 0 {
                    battery.discharge_max_w
                } else {
                    (s.base_w + pool_w - s.solar_w).max(0.0).min(available)
                },
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
                // The same useful energy can be spread over cheaper quarters;
                // native battery power is continuous, unlike EV amp commands.
                let thin = cap.min(500.0);
                out.push(command(p, on, amps, Operation::GridCharge, thin, 0.0));
                let refill = ((f.refill_demand_kwh - stored).max(0.0) * 1000.0
                    / h
                    / battery.charge_efficiency)
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
                    battery.discharge_max_w,
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
    let mut service = 0.0;
    if let Some((car, charger)) = p.car.as_ref().zip(p.charger.as_ref()) {
        let max_gain =
            charger.watts(charger.max_current_a).unwrap() * 0.25 / 1000.0 * car.charge_efficiency;
        for (level, key) in [RuleKey::EvLow, RuleKey::EvShort].into_iter().enumerate() {
            if let Some(r) = policy::rule(p, key) {
                let deficit = (p.targets.ev_km.unwrap() - p.service_guard.ev[level])
                    * car.kwh_per_km
                    - l.state.ev;
                let catchup = (deficit.max(0.0) / max_gain).ceil() as usize;
                service -= (i + catchup).saturating_sub(index.due[2 + level].max(i + 1)) as f64
                    * (-r.points).max(0) as f64;
            }
        }
    }
    let pool = p
        .heater
        .as_ref()
        .zip(p.pool_store.as_ref())
        .map_or(0.0, |(heater, store)| {
            let target = p.targets.pool_c.unwrap();
            let floor = p
                .initial
                .pool_c
                .unwrap()
                .min(target - p.service_guard.pool[0]);
            let buffer = if l.buffer_episode.episode == thermal_buffer::Episode::Spent {
                target
            } else {
                policy::rule(p, RuleKey::PoolBuffer)
                    .map_or(target, |r| target + r.threshold + 0.0005)
            };
            let share = (l.state.pool - floor) / (buffer - floor).max(f64::EPSILON);
            let warming = ((buffer - floor).max(0.0) * store.capacity_kwh_per_c
                / (heater.heat_w / 4000.0))
                .ceil()
                .max(1.0);
            let future = &index.future[i];
            let buffer_points = match l.buffer_episode.episode {
                thermal_buffer::Episode::Available => {
                    if l.buffer_episode.available(index.thermal_buffer.causes[i]) {
                        future.buffer_quarters
                    } else {
                        0.0
                    }
                }
                thermal_buffer::Episode::Active(need) => {
                    need.quarter.saturating_sub(i) as f64
                        * policy::rule(p, RuleKey::PoolBuffer)
                            .map_or(0.0, |r| r.points.max(0) as f64)
                }
                thermal_buffer::Episode::Spent => 0.0,
            };
            (future.useful_pool_quarters + buffer_points).min(warming) * share.clamp(0.0, 1.0)
        });
    pool + service + l.gap_estimate
}

fn rank(p: &Problem, index: &Index, i: usize, l: &Label) -> (f64, f64) {
    let future = estimate(p, index, i, l);
    let mut stored = p.battery.as_ref().map_or(0.0, |b| {
        (l.state.battery - b.min_soc * b.capacity_kwh).max(0.0) * b.discharge_efficiency
    });
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
        buffer_episode: thermal_buffer::Credit::new(p.slots.len()),
        state: physics::initial(p),
        parent: usize::MAX,
        points: 0,
        cash: 0.0,
        wear: 0.0,
        last_charge: p.initial.battery_kwh.unwrap_or(0.0),
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
                    next.prepared = policy::measured(
                        l.last_charge / p.battery.as_ref().unwrap().capacity_kwh * 100.0,
                        10.0,
                    ) >= 100.0;
                }
                if policy::measured(q.charge_w, 10.0) > 0.0 {
                    next.last_charge = q.battery_kwh.unwrap();
                }
                next.points +=
                    policy::quarter(p, index, i, &q, next.prepared, &mut next.buffer_episode)
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
fn audit_cost(p: &Problem, unit_cost: u64) -> u64 {
    let n = p.slots.len() as u64;
    let cap = p.recipe.witness_trials.clamp(1, 16) as u64;
    let audit_cost =
        n.saturating_mul(n)
            .saturating_mul(32 + cap * 8)
            .saturating_add(n.saturating_mul(
                256 + u64::from(p.charger.as_ref().map_or(0, |c| c.max_current_a)) * 4,
            ))
            .saturating_add(
                (p.recipe.witness_trials as u64)
                    .saturating_mul(n)
                    .saturating_mul(
                        96 + u64::from(p.charger.as_ref().map_or(0, |c| c.max_current_a))
                            + unit_cost * 2,
                    ),
            );
    audit_cost.saturating_add(n * unit_cost * 3)
}
fn evaluate(
    p: &Problem,
    index: &Index,
    commands: Vec<Command>,
    work: &mut Work,
) -> Result<Candidate, EvaluationIssue> {
    // Every candidate receives the same complete bounded audit allocation.
    // Decline a new candidate before projection when its audit cannot be paid.
    let audit_cost = audit_cost(p, work.unit_cost);
    if work
        .limit
        .saturating_sub(work.used)
        .saturating_sub(work.reserved)
        < audit_cost
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
struct Preview {
    commands: Vec<Command>,
    account: Account,
    destination: move_resize::Destination,
}
/// Direct points plus possible positive witness credit bound the complete score.
/// Reserve enough for at least one full audit; no preview may replace the incumbent.
fn improve(
    p: &Problem,
    index: &Index,
    mut best: Candidate,
    work: &mut Work,
    declined: &mut bool,
) -> Candidate {
    if p.recipe.repair_trials == 0 {
        return best;
    }
    let n = p.slots.len() as u64;
    loop {
        let audit = audit_cost(p, work.unit_cost);
        if work
            .limit
            .saturating_sub(work.used)
            .saturating_sub(work.reserved)
            < audit + n * work.unit_cost * 3
        {
            *declined = true;
            break;
        }
        work.reserved += audit;
        let edits = move_resize::proposals(p, index, &best.commands, work);
        work.reserved -= audit;
        let Some(edits) = edits else {
            *declined = true;
            break;
        };
        let mut shortlist: Vec<Preview> = Vec::new();
        work.move_resize_passes += 1;
        for edit in edits
            .into_iter()
            .take(p.recipe.repair_trials.saturating_mul(32))
        {
            if work
                .limit
                .saturating_sub(work.used)
                .saturating_sub(work.reserved)
                < audit + n * work.unit_cost * 3
            {
                *declined = true;
                break;
            }
            let commands = edit.apply(&best.commands);
            if commands == best.commands || shortlist.iter().any(|c| c.commands == commands) {
                continue;
            }
            work.move_resize_trials += 1;
            let Some(quarters) = physics::project_metered(p, &commands, work) else {
                continue;
            };
            if !work.spend(n * work.unit_cost) {
                *declined = true;
                break;
            }
            let mut account = policy::account(p, &quarters, index);
            // Include positive witness points and negative direct points a
            // witness exclusion can remove. Economic certificates only deduct.
            let witnessed = |key| {
                matches!(
                    key,
                    RuleKey::LargeLoadOverlap | RuleKey::PoolShortGap | RuleKey::EvShortGap
                )
            };
            account.points += p
                .rules
                .iter()
                .map(|r| {
                    if witnessed(r.key) {
                        r.points.max(0)
                    } else if r.unless.is_some_and(witnessed) {
                        (-r.points).max(0)
                    } else {
                        0
                    }
                })
                .sum::<i32>()
                * p.slots.len() as i32;
            if !policy::better(&account, &best.account) {
                continue;
            }
            shortlist.push(Preview {
                commands,
                account,
                destination: edit.destination(),
            });
            shortlist.sort_by(|a, b| {
                b.account.points.cmp(&a.account.points).then(
                    (a.account.cash_sek + a.account.wear_sek)
                        .total_cmp(&(b.account.cash_sek + b.account.wear_sek)),
                )
            });
            // Keep a points-ranked representative for each destination day and
            // device before filling the remaining audit slots. Adjacent near-
            // identical starts must not exclude a different overnight event.
            let mut destinations = std::collections::BTreeSet::new();
            let mut chosen: Vec<usize> = shortlist
                .iter()
                .enumerate()
                .filter_map(|(i, c)| {
                    destinations
                        .insert((c.destination.device, c.destination.day))
                        .then_some(i)
                })
                .take(p.recipe.repair_trials)
                .collect();
            let mut shapes: std::collections::BTreeSet<_> =
                chosen.iter().map(|i| shortlist[*i].destination).collect();
            for (i, candidate) in shortlist.iter().enumerate() {
                if chosen.len() == p.recipe.repair_trials {
                    break;
                }
                if !chosen.contains(&i) && shapes.insert(candidate.destination) {
                    chosen.push(i);
                }
            }
            for i in 0..shortlist.len() {
                if chosen.len() == p.recipe.repair_trials {
                    break;
                }
                if !chosen.contains(&i) {
                    chosen.push(i);
                }
            }
            shortlist = shortlist
                .into_iter()
                .enumerate()
                .filter_map(|(i, c)| chosen.contains(&i).then_some(c))
                .collect();
        }
        let mut improved = false;
        for preview in shortlist {
            work.repairs += 1;
            match evaluate(p, index, preview.commands, work) {
                Ok(candidate) if policy::better(&candidate.account, &best.account) => {
                    best = candidate;
                    improved = true;
                }
                Ok(_) | Err(EvaluationIssue::Infeasible) => {}
                Err(EvaluationIssue::GrantUnavailable) => {
                    *declined = true;
                    break;
                }
            }
        }
        if !improved {
            break;
        }
        work.move_resize_improvements += 1;
        if *declined {
            break;
        }
    }
    best
}
fn runs(p: &Problem, commands: &[Command], account: &Account) -> Vec<RunPurpose> {
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
            } else if device == "pool"
                && p.rules
                    .iter()
                    .position(|r| r.key == RuleKey::PoolBuffer)
                    .is_some_and(|j| {
                        account.contributions[from..to]
                            .iter()
                            .any(|row| row[j] != 0)
                    })
            {
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
    let proposals = construct(p, &index, &mut work)?;

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
    let best = improve(p, &index, best, &mut work, &mut budget_declined);
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
    let run_purposes = runs(p, &best.commands, &best.account);
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
    fn complete_points_trials_move_and_lengthen_each_flexible_device_despite_higher_cash() {
        for device in [
            move_resize::Device::Pool,
            move_resize::Device::Ev,
            move_resize::Device::Battery,
        ] {
            let mut p = witnesses::tests::problem(24);
            p.recipe.repair_trials = 4;
            p.initial.heater_state = Some(HeaterState::Off { seconds: 0.0 });
            p.rules = vec![
                Rule {
                    key: RuleKey::CheapBuy,
                    threshold: 0.3,
                    points: 2,
                    required: false,
                    unless: None,
                },
                Rule {
                    key: RuleKey::PoolRestart,
                    threshold: 12.0,
                    points: -2,
                    required: false,
                    unless: None,
                },
            ];
            for (i, slot) in p.slots.iter_mut().enumerate() {
                slot.import_price = if i < 8 { 0.9 } else { 1.1 };
            }
            let mut commands = vec![idle(); 24];
            match device {
                move_resize::Device::Pool => commands[18].pool_on = true,
                move_resize::Device::Ev => commands[18].ev_amps = 6,
                move_resize::Device::Battery => commands[18].battery = Operation::GridCharge,
            }
            // An accepted prefix cannot be moved, resized or overwritten.
            p.accepted = Some(commands[..4].to_vec());
            p.locked_through_seconds = 3600.0;
            let mut work = work(&p);
            let index = policy::index(&p, &mut work).unwrap();
            let before = evaluate(&p, &index, commands, &mut work).ok().unwrap();
            let old = before.account.clone();
            let mut declined = false;
            let after = improve(&p, &index, before, &mut work, &mut declined);
            assert!(after.account.points > old.points, "{device:?}");
            assert!(
                after.account.cash_sek > old.cash_sek,
                "points must win even with higher cash: {device:?}"
            );
            assert_eq!(&after.commands[..4], p.accepted.as_ref().unwrap());
            assert!(
                !after.commands[18].pool_on
                    && after.commands[18].ev_amps == 0
                    && after.commands[18].battery != Operation::GridCharge
            );
            assert!(work.move_resize_improvements > 0);
            if device == move_resize::Device::Pool {
                assert_eq!(after.account.contributions[4][1], -2);
                assert!(after.commands[4..8].iter().all(|c| c.pool_on));
            }
            assert!(work.used + work.reserved <= work.limit);
        }
    }
    #[test]
    fn exhausted_improvement_budget_keeps_a_fully_audited_incumbent_and_certification_reserve() {
        let p = witnesses::tests::problem(8);
        let mut work = work(&p);
        let index = policy::index(&p, &mut work).unwrap();
        let before = evaluate(&p, &index, vec![idle(); 8], &mut work)
            .ok()
            .unwrap();
        let expected = before.commands.clone();
        work.limit = work.used + work.reserved + 1;
        let mut declined = false;
        let after = improve(&p, &index, before, &mut work, &mut declined);
        assert_eq!(after.commands, expected);
        assert!(declined);
        assert_eq!(work.reserved, 10000);
        assert!(work.used + work.reserved <= work.limit);
    }
}
