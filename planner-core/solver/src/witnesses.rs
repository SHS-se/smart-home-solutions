//! Bounded causal certificates. Shapes suggest trials; only projected, service-
//! and inventory-preserving alternatives produce penalties or repair commands.
use crate::physics::{locked, project_metered, projected_hours};
use crate::*;

const EPS: f64 = 1e-6;
/// Which certificates an audit seeks.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scope {
    /// Those a rule of the problem scores by, and no others: what a plan's
    /// account needs beyond its own projection.
    Scored,
    /// Every family, the economic ones included: proposals and the report.
    All,
}
const GAP: usize = 0;
const OVERLAP: usize = 1;
/// From here to `EARLY` a family proves a saving on the bill, never points.
const ECONOMIC: usize = 2;
/// The economic family that may sell from the battery.
const EXPORT: usize = 9;
/// The early-grid-charge family: last, so the economic family numbers stand.
const EARLY: usize = 13;
const FAMILIES: [&str; 14] = [
    "pool_short_gap",
    "large_load_overlap",
    "export_before_import",
    "battery_headroom_solar",
    "pool_solar_preheat",
    "pool_wait_for_sun",
    "import_avoidable_by_storage",
    "battery_price_spread",
    "battery_preserve",
    "high_value_export",
    "pool_cheaper_heating",
    "ev_timing",
    "uneconomic_cycling",
    "early_grid_charge",
];

#[derive(Clone, Copy)]
enum Transfer {
    AddCycle,
    CutCycle,
    ChargeMove,
    /// A charge move of no more than the source bought from the grid.
    BoughtMove,
    DischargeMove,
}
#[derive(Clone, Copy)]
enum Proposal {
    /// A pool pause, joined by moving its bordering runs' quarters into it.
    Gap {
        from: usize,
        to: usize,
        left: usize,
        right: usize,
        trim_left: usize,
        trim_right: usize,
    },
    Pool {
        from: usize,
        to: usize,
        length: usize,
    },
    Ev {
        from: usize,
        to: usize,
    },
    Battery {
        from: usize,
        to: usize,
        transfer: Transfer,
    },
    Overlap {
        from: usize,
        to: usize,
        ev: bool,
    },
    /// Charging bought from the grid, moved to a clearly cheaper later quarter.
    Early {
        from: usize,
        to: usize,
        ev: bool,
    },
}
#[derive(Clone, Copy)]
struct Trial {
    proposal: Proposal,
    priority: f64,
    source: usize,
}
#[derive(Clone, Copy)]
enum Flow {
    Ev,
    Charge,
    Discharge,
}
#[derive(Clone, Copy)]
struct Delivery {
    slot: usize,
    flow: Flow,
    watts: f64,
}
struct Edit {
    commands: Vec<Command>,
    deliveries: Vec<Delivery>,
}

#[derive(Default, Clone, Copy)]
struct Exposure {
    counts: [usize; 2],
    deficits: [f64; 2],
    worst: f64,
}
fn exposure(p: &Problem, q: &[Quarter], index: &policy::Index, device: usize) -> Exposure {
    let mut out = Exposure::default();
    let target = if device == 0 {
        p.targets.pool_c
    } else {
        p.targets.ev_km
    };
    let Some(target) = target else {
        return out;
    };
    let thresholds = if device == 0 {
        p.service_guard.pool
    } else {
        p.service_guard.ev
    };
    for (i, v) in q.iter().enumerate() {
        let value = if device == 0 {
            policy::measured(v.pool_c.unwrap(), 1000.0)
        } else {
            policy::measured(v.ev_kwh.unwrap() / p.car.as_ref().unwrap().kwh_per_km, 10.0)
        };
        for (level, offset) in thresholds.iter().enumerate() {
            let short = (target - offset - value).max(0.0);
            if i >= index.due[device * 2 + level] && short > 0.0 {
                out.counts[level] += 1;
                out.deficits[level] += short * projected_hours(&p.slots[i]);
                if level == 0 {
                    out.worst = out.worst.max(short);
                }
            }
        }
    }
    out
}
fn not_worse(a: Exposure, b: Exposure) -> bool {
    b.worst <= a.worst + 1e-9
        && (0..2).all(|i| b.counts[i] <= a.counts[i] && b.deficits[i] <= a.deficits[i] + 1e-9)
}
fn delivered(q: &Quarter, flow: Flow) -> f64 {
    match flow {
        Flow::Ev => q.ev_w,
        Flow::Charge => q.charge_w,
        Flow::Discharge => q.discharge_w,
    }
}
fn preserve(
    p: &Problem,
    before: &[Quarter],
    after: &[Quarter],
    index: &policy::Index,
    before_exposure: [Exposure; 2],
    expected: &[Delivery],
) -> bool {
    let (a, b) = (before.last().unwrap(), after.last().unwrap());
    b.battery_kwh.unwrap_or(0.0) + EPS >= a.battery_kwh.unwrap_or(0.0)
        && b.ev_kwh.unwrap_or(0.0) + EPS >= a.ev_kwh.unwrap_or(0.0)
        && b.pool_c.unwrap_or(0.0) + EPS >= a.pool_c.unwrap_or(0.0)
        && (0..2).all(|d| not_worse(before_exposure[d], exposure(p, after, index, d)))
        && expected
            .iter()
            .all(|e| (delivered(&after[e.slot], e.flow) - e.watts).abs() <= 1.0)
}
fn cost(q: &[Quarter]) -> f64 {
    q.iter().map(|v| v.cost + v.wear).sum()
}
/// What the pool heater draws while commanded on.
fn heater_w(p: &Problem) -> f64 {
    p.heater
        .as_ref()
        .map_or(0.0, |h| h.compressor_w + h.auxiliary_w)
}
fn set_charge(c: &mut Command, power: f64) {
    // Removing a booked charge explicitly closes capture; that is Idle, not Hold.
    c.battery = if power > EPS {
        Operation::GridCharge
    } else {
        Operation::Idle
    };
    c.charge_limit_w = if power > EPS { power } else { 0.0 };
    c.discharge_limit_w = 0.0;
}
fn set_discharge(c: &mut Command, power: f64, export: bool, battery: &Battery) {
    c.battery = if power <= EPS {
        Operation::Idle
    } else if export {
        Operation::Export
    } else {
        Operation::SupplyHouse
    };
    c.discharge_limit_w = if power > EPS { power } else { 0.0 };
    // House supply remains an automatic operation: fresh surplus is capturable.
    c.charge_limit_w = if c.battery == Operation::SupplyHouse {
        battery.charge_max_w
    } else {
        0.0
    };
}
/// A device's charging power the grid met: no more than the quarter imports.
fn bought(q: &Quarter, ev: bool) -> f64 {
    (if ev { q.ev_w } else { q.charge_w }).min(q.net_w.max(0.0))
}
/// Whether the pool heater could have run through a quarter without buying:
/// on the sun the rest of the house leaves and on what the battery could
/// still give.
fn carried_without_grid(p: &Problem, q: &[Quarter], i: usize) -> bool {
    let needed = q[i].net_w + q[i].discharge_w - q[i].charge_w + heater_w(p);
    if needed <= EPS {
        return true;
    }
    let Some(battery) = p.battery.as_ref() else {
        return false;
    };
    let before = if i == 0 {
        p.initial.battery_kwh
    } else {
        q[i - 1].battery_kwh
    };
    let stored = before.unwrap_or(0.0) - battery.capacity_kwh * battery.min_soc;
    needed
        <= battery.discharge_max_w.min(
            stored.max(0.0) * battery.discharge_efficiency / projected_hours(&p.slots[i]) * 1000.0,
        ) + EPS
}
fn valid_amps(p: &Problem, amps: u32) -> bool {
    p.charger.as_ref().is_some_and(|c| c.watts(amps).is_some())
}

/// Store only the best bounded number per family/day. Enumeration is separately
/// metered in audit; this bound prevents a quadratic candidate-memory footprint.
fn offer(queues: &mut [Vec<Trial>], days: usize, family: usize, trial: Trial, cap: usize) {
    let queue = &mut queues[family * days + trial.source / 96];
    if queue.len() < cap {
        queue.push(trial);
    } else if let Some((at, worst)) = queue
        .iter()
        .enumerate()
        .min_by(|a, b| a.1.priority.total_cmp(&b.1.priority))
    {
        if trial.priority > worst.priority {
            queue[at] = trial;
        }
    }
}

/// Whether an audit compares every pair of quarters: the economic families
/// do, and so do the overlap and early-charge rules where the problem has them.
fn pairwise(p: &Problem, scope: Scope) -> bool {
    scope == Scope::All
        || policy::rule(p, RuleKey::LargeLoadOverlap).is_some()
        || policy::rule(p, RuleKey::EarlyGridCharge).is_some()
}
/// Enumeration, top-list maintenance, gap construction and sorting, prepaid.
fn preparation(p: &Problem, n: usize, cap: usize, scope: Scope) -> u64 {
    let n = n as u64;
    if !pairwise(p, scope) {
        // One pass over the pool's commands.
        return n * 16;
    }
    n.saturating_mul(n)
        .saturating_mul(32 + cap as u64 * 8)
        .saturating_add(
            n.saturating_mul(
                256 + u64::from(p.charger.as_ref().map_or(0, |c| c.max_current_a)) * 4,
            ),
        )
}
/// Copying, comparisons, exposure, native amp enumeration, interval margins
/// and explanation materialization for one trial, before its projection.
fn trial_cost(p: &Problem, n: usize) -> u64 {
    n as u64 * (96 + u64::from(p.charger.as_ref().map_or(0, |c| c.max_current_a)))
}
/// The most a complete audit of every family can spend.
pub(crate) fn bound(p: &Problem, unit_cost: u64) -> u64 {
    let n = p.slots.len();
    let quota = p.recipe.witness_trials;
    preparation(p, n, quota.clamp(1, 16), Scope::All)
        .saturating_add((quota as u64).saturating_mul(trial_cost(p, n) + n as u64 * unit_cost * 2))
}

fn enumerate(
    p: &Problem,
    commands: &[Command],
    q: &[Quarter],
    cap: usize,
    scope: Scope,
) -> Vec<Vec<Trial>> {
    let n = commands.len();
    let days = n.div_ceil(96);
    let mut queues = vec![Vec::new(); FAMILIES.len() * days];
    if let Some(rule) = policy::rule(p, RuleKey::PoolShortGap) {
        for from in 1..n {
            if commands[from].pool_on || !commands[from - 1].pool_on {
                continue;
            }
            let mut to = from;
            while to < n && !commands[to].pool_on {
                to += 1;
            }
            if to == n || to - from > 4 {
                continue;
            }
            // A pause its restart is charged for takes no gap deduction:
            // joining it is a proposal, and the score has nothing to certify.
            if scope == Scope::Scored && policy::restart_charged(p, q, to) {
                continue;
            }
            // Dearer than a bordering running quarter, and nothing but the grid to run on.
            let border = p.slots[from - 1].import_price.min(p.slots[to].import_price);
            if (from..to).any(|i| {
                let price = p.slots[i].import_price;
                price - border > rule.threshold.max(0.1 * price.abs()) + 1e-9
                    && !carried_without_grid(p, q, i)
            }) {
                continue;
            }
            let mut left = from - 1;
            let mut right = to + 1;
            while left > 0 && commands[left - 1].pool_on {
                left -= 1;
            }
            while right < n && commands[right].pool_on {
                right += 1;
            }
            // Binary pool commands need exactly one donor per gap quarter;
            // partial intervals are checked by energy when the edit is made.
            let trim = to - from;
            for trim_left in 0..=trim {
                offer(
                    &mut queues,
                    days,
                    GAP,
                    Trial {
                        source: from,
                        priority: (to - from) as f64 - trim as f64 * 0.001,
                        proposal: Proposal::Gap {
                            from,
                            to,
                            left,
                            right,
                            trim_left,
                            trim_right: trim - trim_left,
                        },
                    },
                    cap,
                );
            }
        }
    }
    let overlap = policy::rule(p, RuleKey::LargeLoadOverlap).map(|r| r.threshold);
    let early = policy::rule(p, RuleKey::EarlyGridCharge).map(|r| r.threshold);
    for from in 0..n {
        if !pairwise(p, scope) {
            break;
        }
        if locked(p, from) {
            continue;
        }
        let source_surplus = (-q[from].net_w).max(0.0);
        // The two cheapest later quarters with the power for all that was
        // bought, per device: battery, then car.
        let mut early_to: [Vec<usize>; 2] = [Vec::new(), Vec::new()];
        let early_margin =
            early.map(|threshold| threshold.max(0.1 * p.slots[from].import_price.abs()));
        for to in 0..n {
            if to == from || locked(p, to) {
                continue;
            }
            let delta = p.slots[from].import_price - p.slots[to].import_price;
            if to > from && early_margin.is_some_and(|margin| delta > margin + 1e-9) {
                for ev in [false, true] {
                    let power = bought(&q[from], ev);
                    let room = if ev {
                        p.charger.as_ref().map_or(0.0, |c| {
                            c.watts(c.max_current_a).unwrap_or(0.0) - q[to].ev_w
                        })
                    } else if q[to].discharge_w > EPS {
                        0.0
                    } else {
                        p.battery
                            .as_ref()
                            .map_or(0.0, |b| b.charge_max_w - q[to].charge_w)
                    }
                    .min(p.limits.import_w - q[to].net_w);
                    if power < 500.0 || room + EPS < power {
                        continue;
                    }
                    let best = &mut early_to[usize::from(ev)];
                    best.push(to);
                    best.sort_by(|a, b| {
                        p.slots[*a]
                            .import_price
                            .total_cmp(&p.slots[*b].import_price)
                            .then(a.cmp(b))
                    });
                    best.truncate(2);
                }
            }
            let dest_surplus = (-q[to].net_w).max(0.0);
            let dest_import = q[to].net_w.max(0.0);
            if overlap.is_some_and(|threshold| {
                [q[from].pool_command_w, q[from].ev_w, q[from].charge_w]
                    .iter()
                    .filter(|v| **v > threshold)
                    .count()
                    >= 2
            }) && delta > 0.0
            {
                for ev in [true, false] {
                    let power = if ev { q[from].ev_w } else { q[from].charge_w };
                    if power > overlap.unwrap() {
                        offer(
                            &mut queues,
                            days,
                            OVERLAP,
                            Trial {
                                source: from,
                                priority: delta * power,
                                proposal: Proposal::Overlap { from, to, ev },
                            },
                            cap,
                        );
                    }
                }
            }
            if scope == Scope::Scored {
                continue;
            }
            // Forecast opportunities can repair the plan. Publication gates
            // penalty points only, never the causal proposal catalogue.
            if commands[from].ev_amps > 0 && (delta > 0.0 || dest_surplus > source_surplus) {
                offer(
                    &mut queues,
                    days,
                    11,
                    Trial {
                        source: from,
                        priority: delta * q[from].ev_w + dest_surplus,
                        proposal: Proposal::Ev { from, to },
                    },
                    cap,
                );
            }
            if commands[from].pool_on && !commands[to].pool_on {
                let mut end = from + 1;
                while end < n && commands[end].pool_on {
                    end += 1;
                }
                for length in [1, end - from] {
                    if length > 1 && from > 0 && commands[from - 1].pool_on {
                        continue;
                    }
                    if to + length > n
                        || (to..to + length).any(|i| commands[i].pool_on || locked(p, i))
                        || (from..from + length).any(|i| locked(p, i))
                    {
                        continue;
                    }
                    let family = if dest_surplus > EPS {
                        if to < from {
                            4
                        } else {
                            5
                        }
                    } else {
                        10
                    };
                    if delta > 0.0
                        || dest_surplus > source_surplus
                        || p.slots[to].outdoor_c > p.slots[from].outdoor_c
                    {
                        offer(
                            &mut queues,
                            days,
                            family,
                            Trial {
                                source: from,
                                priority: (delta * q[from].pool_w + dest_surplus) * length as f64,
                                proposal: Proposal::Pool { from, to, length },
                            },
                            cap,
                        );
                    }
                }
            }
            let Some(model) = &p.battery else {
                continue;
            };
            let mut battery = |family, transfer, priority| {
                offer(
                    &mut queues,
                    days,
                    family,
                    Trial {
                        source: from,
                        priority,
                        proposal: Proposal::Battery { from, to, transfer },
                    },
                    cap,
                )
            };
            // All eleven economic families have an explicit causal proposal mapping.
            if from < to && source_surplus > EPS && dest_import > EPS {
                battery(2, Transfer::AddCycle, source_surplus * dest_import);
            }
            if from > to && source_surplus > EPS && dest_import > EPS {
                battery(3, Transfer::AddCycle, source_surplus * dest_import);
            }
            if q[from].charge_w > EPS && dest_surplus > EPS {
                battery(
                    if to > from { 3 } else { 2 },
                    Transfer::ChargeMove,
                    q[from].charge_w * dest_surplus,
                );
            }
            if from < to
                && dest_import > EPS
                && p.slots[to].import_price
                    > p.slots[from].import_price
                        / (model.charge_efficiency * model.discharge_efficiency)
            {
                battery(
                    7,
                    Transfer::AddCycle,
                    (p.slots[to].import_price - p.slots[from].import_price) * dest_import,
                );
            }
            if q[from].discharge_w > EPS
                && dest_import > EPS
                && p.slots[to].import_price > p.slots[from].import_price
            {
                battery(
                    if to > from { 8 } else { 6 },
                    Transfer::DischargeMove,
                    (p.slots[to].import_price - p.slots[from].import_price) * dest_import,
                );
            }
            if q[from].charge_w > EPS && delta > 0.0 {
                battery(7, Transfer::ChargeMove, delta * q[from].charge_w);
            }
            if p.limits.battery_export_enabled
                && p.slots[to].export_price >= p.limits.battery_export_min_price
            {
                if p.slots[to].export_price
                    > p.slots[from].import_price
                        / (model.charge_efficiency * model.discharge_efficiency)
                {
                    battery(
                        EXPORT,
                        Transfer::AddCycle,
                        (p.slots[to].export_price - p.slots[from].import_price)
                            * model.discharge_max_w,
                    );
                }
                if q[from].discharge_w > EPS
                    && p.slots[to].export_price > p.slots[from].import_price
                {
                    battery(
                        EXPORT,
                        Transfer::DischargeMove,
                        q[from].discharge_w * p.slots[to].export_price,
                    );
                }
            }
            if q[from].charge_w > EPS && q[to].discharge_w > EPS {
                battery(12, Transfer::CutCycle, q[from].charge_w + q[to].discharge_w);
            }
        }
        // Every source's cheapest quarter is tried before any source's second.
        for (device, choices) in early_to.iter().enumerate() {
            for (choice, &to) in choices.iter().enumerate() {
                let ev = device == 1;
                let saved =
                    (p.slots[from].import_price - p.slots[to].import_price) * bought(&q[from], ev);
                offer(
                    &mut queues,
                    days,
                    EARLY,
                    Trial {
                        source: from,
                        priority: saved + if choice == 0 { 1e9 } else { 0.0 },
                        proposal: Proposal::Early { from, to, ev },
                    },
                    cap,
                );
            }
        }
    }
    for queue in &mut queues {
        queue.sort_by(|a, b| {
            b.priority
                .total_cmp(&a.priority)
                .then(a.source.cmp(&b.source))
        });
    }
    queues
}

fn edit(
    p: &Problem,
    original: &[Command],
    q: &[Quarter],
    proposal: Proposal,
    family: usize,
) -> Option<Edit> {
    let mut commands = original.to_vec();
    let mut deliveries = Vec::new();
    match proposal {
        Proposal::Gap {
            left,
            right,
            trim_left,
            trim_right,
            ..
        } => {
            let start = left + trim_left;
            let end = right.checked_sub(trim_right)?;
            if start >= end {
                return None;
            }
            // The joined run books the energy the two runs did.
            let booked = |commands: &[Command]| {
                (left..right)
                    .filter(|i| commands[*i].pool_on)
                    .map(|i| heater_w(p) * projected_hours(&p.slots[i]))
                    .sum::<f64>()
            };
            let old_energy = booked(&commands);
            for (i, c) in commands.iter_mut().enumerate().take(right).skip(left) {
                c.pool_on = i >= start && i < end;
            }
            if (booked(&commands) - old_energy).abs() > EPS {
                return None;
            }
        }
        Proposal::Pool { from, to, length } => {
            for c in &mut commands[from..from + length] {
                c.pool_on = false;
            }
            for c in &mut commands[to..to + length] {
                c.pool_on = true;
            }
        }
        Proposal::Ev { from, to }
        | Proposal::Overlap { from, to, ev: true }
        | Proposal::Early { from, to, ev: true } => {
            let source = commands[from].ev_amps;
            let dest = commands[to].ev_amps;
            let ha = projected_hours(&p.slots[from]);
            let hb = projected_hours(&p.slots[to]);
            let mut selected = None;
            // Choose largest executable native transfer, preserving booked energy.
            for remaining in 0..source {
                if !valid_amps(p, remaining) {
                    continue;
                }
                let target = f64::from(dest) + f64::from(source - remaining) * ha / hb;
                let target_a = target.round() as u32;
                if (target - f64::from(target_a)).abs() > EPS || !valid_amps(p, target_a) {
                    continue;
                }
                let added =
                    p.charger.as_ref()?.watts(target_a)? - p.charger.as_ref()?.watts(dest)?;
                if added > (p.limits.import_w - q[to].net_w).max(0.0) + EPS {
                    continue;
                }
                selected = Some((remaining, target_a));
                break;
            }
            let (a, b) = selected?;
            commands[from].ev_amps = a;
            commands[to].ev_amps = b;
            deliveries.push(Delivery {
                slot: from,
                flow: Flow::Ev,
                watts: p.charger.as_ref()?.watts(a)?,
            });
            deliveries.push(Delivery {
                slot: to,
                flow: Flow::Ev,
                watts: p.charger.as_ref()?.watts(b)?,
            });
        }
        Proposal::Overlap {
            from,
            to,
            ev: false,
        } => {
            battery_edit(
                p,
                q,
                &mut commands,
                &mut deliveries,
                (from, to),
                Transfer::ChargeMove,
                false,
            )?;
        }
        Proposal::Early {
            from,
            to,
            ev: false,
        } => {
            // Only what was bought moves; charging the sun carried stays.
            battery_edit(
                p,
                q,
                &mut commands,
                &mut deliveries,
                (from, to),
                Transfer::BoughtMove,
                false,
            )?;
        }
        Proposal::Battery { from, to, transfer } => {
            battery_edit(
                p,
                q,
                &mut commands,
                &mut deliveries,
                (from, to),
                transfer,
                family == EXPORT,
            )?;
        }
    }
    if commands
        .iter()
        .zip(original)
        .enumerate()
        .any(|(i, (a, b))| a != b && locked(p, i))
        || commands == original
    {
        return None;
    }
    Some(Edit {
        commands,
        deliveries,
    })
}

fn battery_edit(
    p: &Problem,
    q: &[Quarter],
    commands: &mut [Command],
    expected: &mut Vec<Delivery>,
    endpoints: (usize, usize),
    kind: Transfer,
    export: bool,
) -> Option<()> {
    let battery = p.battery.as_ref()?;
    let (a, b) = endpoints;
    let ha = projected_hours(&p.slots[a]);
    let hb = projected_hours(&p.slots[b]);
    let ce = battery.charge_efficiency;
    let de = battery.discharge_efficiency;
    let charge_room = |i: usize| {
        if q[i].discharge_w > EPS {
            0.0
        } else {
            (battery.charge_max_w - q[i].charge_w)
                .min((p.limits.import_w - q[i].net_w).max(0.0))
                .max(0.0)
        }
    };
    let discharge_room = |i: usize| {
        if q[i].charge_w > EPS {
            0.0
        } else {
            (battery.discharge_max_w - q[i].discharge_w)
                .min(if export {
                    (p.limits.export_w + q[i].net_w).max(0.0)
                } else {
                    q[i].net_w.max(0.0)
                })
                .max(0.0)
        }
    };
    let (mut energy, increase_between) = match kind {
        Transfer::AddCycle => (
            (charge_room(a) * ha * ce).min(discharge_room(b) * hb / de) / 1000.0,
            a < b,
        ),
        Transfer::CutCycle => (
            (q[a].charge_w * ha * ce).min(q[b].discharge_w * hb / de) / 1000.0,
            a > b,
        ),
        Transfer::ChargeMove => (
            (q[a].charge_w * ha * ce).min(charge_room(b) * hb * ce) / 1000.0,
            a > b,
        ),
        Transfer::BoughtMove => (
            (bought(&q[a], false) * ha * ce).min(charge_room(b) * hb * ce) / 1000.0,
            a > b,
        ),
        Transfer::DischargeMove => (
            (q[a].discharge_w * ha / de).min(discharge_room(b) * hb / de) / 1000.0,
            a < b,
        ),
    };
    for state in &q[a.min(b)..a.max(b)] {
        let margin = if increase_between {
            battery.capacity_kwh * battery.max_soc - state.battery_kwh?
        } else {
            state.battery_kwh? - battery.capacity_kwh * battery.min_soc
        };
        energy = energy.min(margin.max(0.0));
    }
    if energy <= EPS {
        return None;
    }
    let (af, bf, av, bv) = match kind {
        Transfer::AddCycle => (
            Flow::Charge,
            Flow::Discharge,
            q[a].charge_w + energy * 1000.0 / (ha * ce),
            q[b].discharge_w + energy * 1000.0 * de / hb,
        ),
        Transfer::CutCycle => (
            Flow::Charge,
            Flow::Discharge,
            q[a].charge_w - energy * 1000.0 / (ha * ce),
            q[b].discharge_w - energy * 1000.0 * de / hb,
        ),
        Transfer::ChargeMove | Transfer::BoughtMove => (
            Flow::Charge,
            Flow::Charge,
            q[a].charge_w - energy * 1000.0 / (ha * ce),
            q[b].charge_w + energy * 1000.0 / (hb * ce),
        ),
        Transfer::DischargeMove => (
            Flow::Discharge,
            Flow::Discharge,
            q[a].discharge_w - energy * 1000.0 * de / ha,
            q[b].discharge_w + energy * 1000.0 * de / hb,
        ),
    };
    for (i, flow, value) in [(a, af, av), (b, bf, bv)] {
        match flow {
            Flow::Charge => set_charge(&mut commands[i], value),
            Flow::Discharge => set_discharge(
                &mut commands[i],
                value,
                if i == b {
                    export || q[i].net_w < 0.0
                } else {
                    q[i].net_w < 0.0
                },
                battery,
            ),
            Flow::Ev => unreachable!(),
        }
        expected.push(Delivery {
            slot: i,
            flow,
            watts: value.max(0.0),
        });
    }
    Some(())
}

/// Match primary economic attribution to the flows the certificate actually
/// moved, not the heuristic family that proposed it. Prior cumulative edits
/// can consume forecast surplus or imported demand. Tags never add points.
fn economic_key(proposal: Proposal, before: &[Quarter], after: &[Quarter]) -> EconomicKey {
    use EconomicKey::*;
    let share =
        |available: f64, extra: f64| extra > EPS && available.max(0.0).min(extra) / extra >= 0.5;
    match proposal {
        Proposal::Pool { from, to, length } => {
            let added: f64 = (to..to + length)
                .map(|i| (after[i].pool_w - before[i].pool_w).max(0.0))
                .sum();
            let solar: f64 = (to..to + length)
                .map(|i| {
                    (-before[i].net_w)
                        .max(0.0)
                        .min((after[i].pool_w - before[i].pool_w).max(0.0))
                })
                .sum();
            if share(solar, added) {
                if to > from {
                    PoolWaitForSun
                } else {
                    PoolSolarPreheat
                }
            } else {
                PoolCheaperHeating
            }
        }
        Proposal::Ev { .. } => EvTiming,
        Proposal::Battery { from, to, transfer } => {
            let offsets_import = share(
                before[to].net_w,
                after[to].discharge_w - before[to].discharge_w,
            );
            match transfer {
                Transfer::CutCycle => UneconomicCycling,
                Transfer::ChargeMove | Transfer::BoughtMove => {
                    let solar = share(-before[to].net_w, after[to].charge_w - before[to].charge_w);
                    if solar {
                        if to > from {
                            BatteryHeadroomSolar
                        } else {
                            ExportBeforeImport
                        }
                    } else {
                        BatteryPriceSpread
                    }
                }
                Transfer::DischargeMove => {
                    if !offsets_import {
                        HighValueExport
                    } else if to > from {
                        BatteryPreserve
                    } else {
                        ImportAvoidableByStorage
                    }
                }
                Transfer::AddCycle => {
                    let solar = share(
                        -before[from].net_w,
                        after[from].charge_w - before[from].charge_w,
                    );
                    if from > to && solar {
                        BatteryHeadroomSolar
                    } else if !offsets_import {
                        HighValueExport
                    } else if solar {
                        ExportBeforeImport
                    } else {
                        BatteryPriceSpread
                    }
                }
            }
        }
        Proposal::Gap { .. } | Proposal::Overlap { .. } | Proposal::Early { .. } => {
            unreachable!("only economic proposals have economic attribution")
        }
    }
}

/// Route candidates before editing so a published certificate cannot borrow
/// inventory or command changes from the forecast repair sequence.
fn proposal_published(p: &Problem, proposal: Proposal) -> bool {
    match proposal {
        Proposal::Pool { from, to, length } => (from..from + length)
            .chain(to..to + length)
            .all(|i| p.slots[i].published),
        Proposal::Ev { from, to }
        | Proposal::Battery { from, to, .. }
        | Proposal::Overlap { from, to, .. }
        | Proposal::Early { from, to, .. } => p.slots[from].published && p.slots[to].published,
        Proposal::Gap { left, right, .. } => (left..right).all(|i| p.slots[i].published),
    }
}

pub(crate) fn audit(
    p: &Problem,
    commands: &[Command],
    quarters: &[Quarter],
    index: &policy::Index,
    work: &mut Work,
    quota: usize,
    scope: Scope,
) -> WitnessAudit {
    let n = commands.len();
    let days = n.div_ceil(96);
    let mut out = WitnessAudit {
        gaps: vec![false; n],
        overlap: vec![false; n],
        early: vec![false; n],
        coverage: FAMILIES
            .iter()
            .map(|f| WitnessCoverage {
                family: (*f).into(),
                trials: 0,
                proven: 0,
                quota_exhausted: false,
            })
            .collect(),
        ..WitnessAudit::default()
    };
    // Prepay bounded candidate enumeration, bounded top-list maintenance, gap
    // construction and sorting. Cap is per family/day, not a horizon prefix.
    let cap = quota.clamp(1, 16);
    if !work.spend(preparation(p, n, cap, scope)) {
        for c in &mut out.coverage {
            c.quota_exhausted = true;
        }
        out.stopped = true;
        return out;
    }
    let queues = enumerate(p, commands, quarters, cap, scope);
    // Nothing to try: the usual end of a scored audit, before any ledger is copied.
    if queues.iter().all(Vec::is_empty) {
        return out;
    }
    let before_exposure = [
        exposure(p, quarters, index, 0),
        exposure(p, quarters, index, 1),
    ];
    let mut overlap_commands = commands.to_vec();
    let mut overlap_q = quarters.to_vec();
    let mut destinations = vec![false; n];
    let mut prior_delivery = Vec::new();
    // Early charges accumulate too, and one cheap quarter may take several.
    let mut early_commands = commands.to_vec();
    let mut early_q = quarters.to_vec();
    let mut early_delivery: Vec<Delivery> = Vec::new();
    // Each causal basis starts at the original plan and accumulates only its
    // own accepted edits. Both ledgers are covered by preparation's copy charge.
    let mut economic_commands = [commands.to_vec(), commands.to_vec()];
    let mut economic_q = [quarters.to_vec(), quarters.to_vec()];
    let mut cursors = vec![0usize; queues.len()];
    let mut trials = 0usize;
    let mut stopped = false;
    'rounds: loop {
        let mut progressed = false;
        // Days alternate within each family, then the next family gets a turn.
        for family in 0..FAMILIES.len() {
            for day in 0..days {
                let qi = family * days + day;
                if cursors[qi] >= queues[qi].len() {
                    continue;
                }
                if trials >= quota {
                    break 'rounds;
                }
                if !work.spend(trial_cost(p, n)) {
                    stopped = true;
                    break 'rounds;
                }
                let candidate = queues[qi][cursors[qi]];
                cursors[qi] += 1;
                progressed = true;
                trials += 1;
                work.witness_trials += 1;
                out.coverage[family].trials += 1;
                let published_proposal = proposal_published(p, candidate.proposal);
                let economic_ledger = usize::from(!published_proposal);
                let (base, baseline): (&[Command], &[Quarter]) = if family == OVERLAP {
                    (&overlap_commands, &overlap_q)
                } else if family == EARLY {
                    (&early_commands, &early_q)
                } else if family >= ECONOMIC {
                    (
                        &economic_commands[economic_ledger],
                        &economic_q[economic_ledger],
                    )
                } else {
                    (commands, quarters)
                };
                if let Proposal::Overlap { from, to, .. } = candidate.proposal {
                    if destinations[to] || out.overlap[from] {
                        continue;
                    }
                }
                if let Proposal::Gap { from, to, .. } = candidate.proposal {
                    if out.gaps[from..to].iter().any(|fired| *fired) {
                        continue;
                    }
                }
                if let Proposal::Early { from, .. } = candidate.proposal {
                    if out.early[from] {
                        continue;
                    }
                }
                let Some(edited) = edit(p, base, baseline, candidate.proposal, family) else {
                    continue;
                };
                let Some(after) = project_metered(p, &edited.commands, work) else {
                    if work.used + work.reserved + n as u64 * work.unit_cost * 2 > work.limit {
                        stopped = true;
                        break 'rounds;
                    }
                    continue;
                };
                if !preserve(
                    p,
                    quarters,
                    &after,
                    index,
                    before_exposure,
                    &edited.deliveries,
                ) {
                    continue;
                }
                if family == OVERLAP
                    && !prior_delivery.iter().all(|e: &Delivery| {
                        (delivered(&after[e.slot], e.flow) - e.watts).abs() <= 1.0
                    })
                {
                    continue;
                }
                let changed: Vec<usize> = base
                    .iter()
                    .zip(&edited.commands)
                    .enumerate()
                    .filter_map(|(i, (a, b))| (a != b).then_some(i))
                    .collect();
                if family == GAP {
                    let Proposal::Gap { from, to, .. } = candidate.proposal else {
                        unreachable!()
                    };
                    out.gaps[from..to].fill(true);
                } else if family == OVERLAP {
                    let Proposal::Overlap { from, to, .. } = candidate.proposal else {
                        unreachable!()
                    };
                    out.overlap[from] = true;
                    destinations[to] = true;
                    prior_delivery.extend(edited.deliveries);
                    overlap_commands = edited.commands.clone();
                    overlap_q = after;
                } else if family == EARLY {
                    let Proposal::Early { from, to, ev } = candidate.proposal else {
                        unreachable!()
                    };
                    // All the plan bought here has left the quarter, no other
                    // accepted move is curtailed, and the bill is no higher.
                    if bought(&after[from], ev)
                        > bought(&baseline[from], ev) - bought(&quarters[from], ev) + 1.0
                        || cost(&after) > cost(baseline) + 1e-9
                        || !early_delivery.iter().all(|e| {
                            e.slot == from
                                || e.slot == to
                                || (delivered(&after[e.slot], e.flow) - e.watts).abs() <= 1.0
                        })
                    {
                        continue;
                    }
                    out.early[from] = true;
                    // The cheaper quarter's booking has to stand from here on,
                    // and so does a source that an earlier move had filled.
                    let refilled = early_delivery.iter().any(|e| e.slot == from);
                    early_delivery.retain(|e| e.slot != from && e.slot != to);
                    early_delivery.extend(
                        edited
                            .deliveries
                            .iter()
                            .filter(|e| e.slot == to || refilled),
                    );
                    early_commands = edited.commands.clone();
                    early_q = after;
                } else {
                    let saving = cost(baseline) - cost(&after);
                    if saving <= 1e-7 {
                        continue;
                    }
                    // Verify the complete certificate, not only this transfer:
                    // every cumulative command edit of a known-price witness
                    // must still lie in the originally published price set.
                    if published_proposal
                        && edited
                            .commands
                            .iter()
                            .zip(commands)
                            .enumerate()
                            .any(|(i, (a, b))| a != b && !p.slots[i].published)
                    {
                        continue;
                    }
                    let published = published_proposal;
                    out.economic.push(EconomicHit {
                        published,
                        rule: economic_key(candidate.proposal, baseline, &after),
                        quarters: changed.clone(),
                        saving_sek: saving,
                    });
                    economic_commands[economic_ledger] = edited.commands.clone();
                    economic_q[economic_ledger] = after;
                }
                out.coverage[family].proven += 1;
                // A proposal only: the search scores it like any other plan.
                out.repairs.push(edited.commands);
            }
        }
        if !progressed {
            break;
        }
    }
    out.stopped = stopped;
    for (family, c) in out.coverage.iter_mut().enumerate() {
        // A full retained queue may have omitted other shapes; report incomplete
        // enumeration even when every retained candidate was tried.
        c.quota_exhausted = stopped
            || (0..days).any(|day| {
                let i = family * days + day;
                cursors[i] < queues[i].len() || queues[i].len() == cap
            });
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use shs_planner_models::{Response, StandingLoss};

    pub(crate) fn problem(n: usize) -> Problem {
        Problem {
            abi: 7,
            // No end credit unless a test asks for one.
            end_credit: EndCreditTerms {
                reference_sek_per_kwh: 0.0,
                battery: None,
                pool: None,
                ev: None,
            },
            pool_cycle_seconds: 43200.0,
            work_grant: 100_000_000,
            recipe: Recipe {
                beam_width: 8,
                max_actions: 24,
                finalists: 3,
                witness_trials: 192,
                repair_trials: 24,
            },
            slots: (0..n)
                .map(|i| Slot {
                    local_month: 7,
                    start_seconds: i as f64 * 900.0,
                    hours: 0.25,
                    base_w: 0.0,
                    solar_w: 0.0,
                    outdoor_c: 20.0,
                    import_price: 1.0,
                    export_price: 0.0,
                    published: true,
                    ev_available: true,
                })
                .collect(),
            battery: Some(Battery {
                capacity_kwh: 10.0,
                min_soc: 0.0,
                max_soc: 1.0,
                charge_max_w: 4000.0,
                discharge_max_w: 4000.0,
                charge_efficiency: 1.0,
                discharge_efficiency: 1.0,
            }),
            car: Some(CarBattery {
                capacity_kwh: 60.0,
                kwh_per_km: 0.2,
                charge_efficiency: 1.0,
            }),
            charger: Some(Charger {
                voltage_v: 230.0,
                phase_count: 1,
                min_current_a: 6,
                max_current_a: 16,
                current_step_a: 1,
            }),
            pool_store: Some(ThermalStore {
                capacity_kwh_per_c: 10.0,
                loss: StandingLoss::Linear {
                    kw_per_c: 0.0,
                    surroundings_c: None,
                },
            }),
            heater: Some(Heater {
                compressor_w: 3000.0,
                auxiliary_w: 0.0,
                heat_w: 12000.0,
                response: Response::Steady,
            }),
            pool_stop_c: None,
            initial: Initial {
                battery_kwh: Some(5.0),
                ev_kwh: Some(10.0),
                pool_c: Some(30.0),
                heater_state: Some(HeaterState::OffUnobserved),
            },
            targets: Targets {
                pool_c: Some(30.0),
                ev_km: Some(0.0),
                ev_limit_kwh: Some(60.0),
            },
            limits: Limits {
                import_w: 7000.0,
                export_w: 7000.0,
                battery_export_enabled: true,
                battery_export_reserve_kwh: 0.0,
                battery_export_min_price: 0.0,
                wear_per_kwh: 0.0,
                pool_start_cost_sek: 0.0,
            },
            rules: vec![
                Rule {
                    key: RuleKey::PoolShortGap,
                    threshold: 0.1,
                    points: -1,
                    required: false,
                    unless: None,
                },
                Rule {
                    key: RuleKey::LargeLoadOverlap,
                    threshold: 2000.0,
                    points: -1,
                    required: false,
                    unless: None,
                },
            ],
            service_guard: ServiceGuard {
                pool: [1.0, 2.0],
                ev: [50.0, 100.0],
            },
            accepted: None,
            locked_through_seconds: 0.0,
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
    fn run(p: &Problem, commands: &[Command], quota: usize) -> WitnessAudit {
        run_scoped(p, commands, quota, Scope::All)
    }
    fn run_scoped(p: &Problem, commands: &[Command], quota: usize, scope: Scope) -> WitnessAudit {
        let mut work = Work {
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
        };
        let index = policy::index(p, &mut work).unwrap();
        let q = physics::projection(p, commands).unwrap();
        let audit = audit(p, commands, &q, &index, &mut work, quota, scope);
        assert!(work.used + work.reserved <= work.limit);
        assert!(work.witness_trials <= quota as u64);
        for repair in &audit.repairs {
            for c in repair {
                if matches!(
                    c.battery,
                    Operation::Hold | Operation::SupplyHouse | Operation::SolarCharge
                ) {
                    assert_eq!(c.charge_limit_w, p.battery.as_ref().unwrap().charge_max_w);
                }
                if c.battery == Operation::Idle {
                    assert_eq!((c.charge_limit_w, c.discharge_limit_w), (0.0, 0.0));
                }
            }
        }
        audit
    }
    #[test]
    fn joins_pool_gap_only_with_feasible_inventory_preserving_witness() {
        let mut p = problem(3);
        let mut c = vec![idle(); 3];
        c[0].pool_on = true;
        c[2].pool_on = true;
        let yes = run(&p, &c, 192);
        assert!(yes.gaps[1]);
        assert_eq!(yes.coverage[GAP].proven, 1);
        // The joined run fills the gap and keeps the two quarters of heating.
        assert!(yes
            .repairs
            .iter()
            .all(|r| r[1].pool_on && r.iter().filter(|c| c.pool_on).count() == 2));
        // Neither joined alternative fits the occupied middle quarter.
        p.slots[1].base_w = p.limits.import_w;
        let no = run(&p, &c, 192);
        assert!(!no.gaps[1]);
    }
    #[test]
    fn a_scored_audit_tries_only_what_a_rule_of_the_problem_scores_by() {
        let mut p = problem(4);
        p.rules.truncate(1);
        assert_eq!(p.rules[0].key, RuleKey::PoolShortGap);
        // A pool pause, and a battery cycle that loses money.
        p.slots[0].import_price = 3.0;
        p.slots[3].base_w = 1000.0;
        let mut c = vec![idle(); 4];
        c[0].pool_on = true;
        c[2].pool_on = true;
        set_charge(&mut c[0], 1000.0);
        set_discharge(&mut c[3], 1000.0, false, p.battery.as_ref().unwrap());
        let scored = run_scoped(&p, &c, 192, Scope::Scored);
        assert!(scored.gaps[1] && scored.economic.is_empty());
        assert!(scored.coverage[ECONOMIC..].iter().all(|c| c.trials == 0));
        // Every family proves the cycle's saving as well.
        assert!(!run(&p, &c, 192).economic.is_empty());
        // The restart rule charges the pause: the score has nothing to
        // certify, and joining the runs stays a proposal of the full audit.
        p.rules.push(Rule {
            key: RuleKey::PoolRestart,
            threshold: 12.0,
            points: -2,
            required: false,
            unless: None,
        });
        let owned = run_scoped(&p, &c, 192, Scope::Scored);
        assert!(!owned.fires() && owned.repairs.is_empty());
        assert!(owned.coverage.iter().all(|c| c.trials == 0));
        assert!(run(&p, &c, 192).gaps[1]);
    }
    #[test]
    fn overlap_needs_cheaper_available_destination() {
        let mut p = problem(2);
        p.slots[0].import_price = 2.0;
        let mut c = vec![idle(); 2];
        c[0].pool_on = true;
        c[0].ev_amps = 16;
        assert!(run(&p, &c, 192).overlap[0]);
        p.slots[1].base_w = p.limits.import_w;
        assert!(!run(&p, &c, 192).overlap[0]);
    }
    #[test]
    fn uneconomic_cycle_proves_saving_and_a_forecast_saving_counts_like_a_published_one() {
        let mut p = problem(2);
        p.slots[0].import_price = 3.0;
        p.slots[1].base_w = 1000.0;
        let mut c = vec![idle(); 2];
        set_charge(&mut c[0], 1000.0);
        set_discharge(&mut c[1], 1000.0, false, p.battery.as_ref().unwrap());
        let yes = run(&p, &c, 192);
        assert!(yes
            .economic
            .iter()
            .any(|h| h.rule == EconomicKey::UneconomicCycling && h.saving_sek > 0.0));
        p.slots[1].published = false;
        let forecast = run(&p, &c, 192);
        assert!(forecast
            .economic
            .iter()
            .any(|h| h.rule == EconomicKey::UneconomicCycling
                && h.saving_sek > 0.0
                && !h.published));
        assert!(forecast.economic.iter().all(|h| !h.published));
    }
    #[test]
    fn published_certificates_never_inherit_forecast_repairs() {
        let mut p = problem(4);
        let mut commands = vec![idle(); 4];
        for from in [0, 2] {
            p.slots[from].import_price = 3.0;
            p.slots[from + 1].import_price = 1.0;
            p.slots[from + 1].base_w = 1000.0;
            set_charge(&mut commands[from], 1000.0);
            set_discharge(
                &mut commands[from + 1],
                1000.0,
                false,
                p.battery.as_ref().unwrap(),
            );
        }
        p.slots[0].published = false;
        p.slots[1].published = false;
        let result = run(&p, &commands, 192);
        assert!(result.economic.iter().any(|hit| hit.published));
        assert!(result.economic.iter().any(|hit| !hit.published));
        // Each economic certificate leaves one repair, in the same order,
        // and this plan has no other kind.
        let repairs = &result.repairs;
        assert_eq!(repairs.len(), result.economic.len());
        let forecast_at = result.economic.iter().position(|h| !h.published).unwrap();
        let known_at = result.economic.iter().position(|h| h.published).unwrap();
        assert!(
            forecast_at < known_at,
            "exercise a known repair after a forecast repair"
        );
        for (hit, repair) in result.economic.iter().zip(repairs) {
            // Only the known ledger must stay clear of forecast edits.
            if hit.published {
                assert_eq!(&repair[..2], &commands[..2]);
            }
        }
        for hit in result.economic.iter().filter(|hit| hit.published) {
            assert!(hit.quarters.iter().all(|&i| p.slots[i].published));
        }
    }

    #[test]
    fn accepted_hour_is_never_changed_and_zero_quota_is_explicit() {
        let mut p = problem(8);
        let mut c = vec![idle(); 8];
        c[0].pool_on = true;
        c[2].pool_on = true;
        p.accepted = Some(c[..4].to_vec());
        p.locked_through_seconds = 3600.0;
        let result = run(&p, &c, 192);
        assert!(!result.gaps[1]);
        assert!(result.repairs.iter().all(|r| r[..4] == c[..4]));
        p.accepted = None;
        p.locked_through_seconds = 0.0;
        let none = run(&p, &c, 0);
        assert!(none
            .coverage
            .iter()
            .any(|r| r.family == "pool_short_gap" && r.trials == 0 && r.quota_exhausted));
        assert!(none.economic.is_empty());
    }
    #[test]
    fn witness_supply_retains_solar_permission_and_zero_booking_is_idle() {
        let mut p = problem(1);
        p.slots[0].solar_w = 2000.0;
        let mut c = idle();
        set_discharge(&mut c, 500.0, false, p.battery.as_ref().unwrap());
        let rows = physics::projection(&p, &[c.clone()]).unwrap();
        assert_eq!(rows[0].charge_w, 2000.0);
        assert_eq!(rows[0].discharge_w, 0.0);
        set_discharge(&mut c, 0.0, false, p.battery.as_ref().unwrap());
        assert_eq!(c.battery, Operation::Idle);
        assert_eq!(
            physics::projection(&p, &[c.clone()]).unwrap()[0].charge_w,
            0.0
        );
        set_charge(&mut c, 0.0);
        assert_eq!(c.battery, Operation::Idle);
        assert_eq!(c.charge_limit_w, 0.0);
    }
    #[test]
    fn dearer_pool_gap_is_excused_only_when_it_would_have_to_be_bought() {
        let mut p = problem(3);
        p.slots[1].import_price = 2.0;
        let mut c = vec![idle(); 3];
        c[0].pool_on = true;
        c[2].pool_on = true;
        // A half-full battery could have carried the heat pump: the gap counts.
        assert!(run(&p, &c, 192).gaps[1]);
        // An empty one leaves only the grid, and the dearer quarter excuses it.
        p.initial.battery_kwh = Some(0.0);
        assert!(!run(&p, &c, 192).gaps[1]);
        // The sun carries it instead.
        p.slots[1].solar_w = 3000.0;
        assert!(run(&p, &c, 192).gaps[1]);
        // A cheaper gap is never an excuse.
        p.slots[1].solar_w = 0.0;
        p.slots[1].import_price = 0.5;
        assert!(run(&p, &c, 192).gaps[1]);
    }
    #[test]
    fn early_grid_charges_move_into_one_clearly_cheaper_quarter() {
        let mut p = problem(4);
        p.rules.push(Rule {
            key: RuleKey::EarlyGridCharge,
            threshold: 0.1,
            points: -1,
            required: false,
            unless: None,
        });
        for s in &mut p.slots[..3] {
            s.import_price = 1.4;
        }
        let mut c = vec![idle(); 4];
        set_charge(&mut c[0], 1000.0);
        set_charge(&mut c[2], 1000.0);
        let yes = run(&p, &c, 192);
        assert_eq!(yes.early, vec![true, false, true, false]);
        // The last repair holds both moves: one cheap quarter takes all of it.
        assert_eq!(yes.coverage[EARLY].proven, 2);
        let repair = yes.repairs.last().unwrap();
        let after = physics::projection(&p, repair).unwrap();
        assert!(after[0].charge_w < EPS && after[2].charge_w < EPS);
        assert!((after[3].charge_w - 2000.0).abs() < EPS);
        // Charging the sun carries is not bought, so it stays.
        p.slots[0].solar_w = 1000.0;
        assert_eq!(run(&p, &c, 192).early, vec![false, false, true, false]);
        p.slots[0].solar_w = 0.0;
        // 14 öre is 10% of 1.40: exactly that is not clearly cheaper.
        p.slots[3].import_price = 1.26;
        assert!(!run(&p, &c, 192).early[0]);
        // No power left in the cheaper quarter for all that was bought.
        p.slots[3].import_price = 1.0;
        set_charge(&mut c[3], 3500.0);
        assert!(!run(&p, &c, 192).early[0]);
    }
    #[test]
    fn early_grid_charge_stays_where_a_later_purchase_would_cost_more() {
        let mut p = problem(4);
        p.rules.push(Rule {
            key: RuleKey::EarlyGridCharge,
            threshold: 0.1,
            points: -1,
            required: false,
            unless: None,
        });
        for s in &mut p.slots[..3] {
            s.import_price = 1.4;
        }
        // The charge is sold at 3.00 before the cheaper quarter comes.
        p.initial.battery_kwh = Some(0.0);
        p.slots[1].export_price = 3.0;
        let mut c = vec![idle(); 4];
        set_charge(&mut c[0], 1000.0);
        set_discharge(&mut c[1], 1000.0, true, p.battery.as_ref().unwrap());
        assert!(!run(&p, &c, 192).early[0]);
    }
}
