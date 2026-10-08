//! Bounded causal certificates. Shapes suggest trials; only projected, service-
//! and inventory-preserving alternatives produce penalties or repair commands.
use crate::physics::{locked, project_metered, projected_hours};
use crate::*;

const EPS: f64 = 1e-6;
const FAMILIES: [&str; 14] = [
    "pool_short_gap",
    "ev_short_gap",
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
];

#[derive(Clone, Copy)]
enum Transfer {
    AddCycle,
    CutCycle,
    ChargeMove,
    DischargeMove,
}
#[derive(Clone, Copy)]
enum Proposal {
    Gap {
        device: usize,
        from: usize,
        to: usize,
        left: usize,
        right: usize,
        trim_left: usize,
        trim_right: usize,
        reverse: bool,
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
fn watts(p: &Problem, c: &Command, device: usize) -> f64 {
    if device == 0 {
        if c.pool_on {
            p.heater
                .as_ref()
                .map_or(0.0, |h| h.compressor_w + h.auxiliary_w)
        } else {
            0.0
        }
    } else {
        p.charger
            .as_ref()
            .and_then(|cgr| cgr.watts(c.ev_amps))
            .unwrap_or(0.0)
    }
}
fn running(c: &Command, device: usize) -> bool {
    if device == 0 {
        c.pool_on
    } else {
        c.ev_amps > 0
    }
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

fn enumerate(p: &Problem, commands: &[Command], q: &[Quarter], cap: usize) -> Vec<Vec<Trial>> {
    let n = commands.len();
    let days = n.div_ceil(96);
    let mut queues = vec![Vec::new(); FAMILIES.len() * days];
    for device in 0..2 {
        let key = if device == 0 {
            RuleKey::PoolShortGap
        } else {
            RuleKey::EvShortGap
        };
        let Some(rule) = policy::rule(p, key) else {
            continue;
        };
        for from in 1..n {
            if running(&commands[from], device) || !running(&commands[from - 1], device) {
                continue;
            }
            let mut to = from;
            while to < n && !running(&commands[to], device) {
                to += 1;
            }
            if to == n || to - from > 4 {
                continue;
            }
            if (from..to).any(|i| {
                let price = p.slots[i].import_price;
                let tol = rule.threshold.max(0.1 * price.abs());
                (price - p.slots[from - 1].import_price).abs() > tol + 1e-9
                    || (price - p.slots[to].import_price).abs() > tol + 1e-9
            }) {
                continue;
            }
            let mut left = from - 1;
            let mut right = to + 1;
            while left > 0 && running(&commands[left - 1], device) {
                left -= 1;
            }
            while right < n && running(&commands[right], device) {
                right += 1;
            }
            for trim in 0..=to - from {
                for trim_left in 0..=trim {
                    for reverse in [false, true] {
                        // Binary pool commands need exactly one donor per gap
                        // quarter; partial intervals are checked by energy below.
                        if device == 0 && (trim != to - from || reverse) {
                            continue;
                        }
                        offer(
                            &mut queues,
                            days,
                            device,
                            Trial {
                                source: from,
                                priority: (to - from) as f64 - trim as f64 * 0.001,
                                proposal: Proposal::Gap {
                                    device,
                                    from,
                                    to,
                                    left,
                                    right,
                                    trim_left,
                                    trim_right: trim - trim_left,
                                    reverse,
                                },
                            },
                            cap,
                        );
                    }
                }
            }
        }
    }
    let overlap = policy::rule(p, RuleKey::LargeLoadOverlap).map(|r| r.threshold);
    for from in 0..n {
        if locked(p, from) {
            continue;
        }
        let source_surplus = (-q[from].net_w).max(0.0);
        for to in 0..n {
            if to == from || locked(p, to) {
                continue;
            }
            let delta = p.slots[from].import_price - p.slots[to].import_price;
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
                            2,
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
            // Forecast opportunities can repair the plan. Publication gates
            // penalty points only, never the causal proposal catalogue.
            if commands[from].ev_amps > 0 && (delta > 0.0 || dest_surplus > source_surplus) {
                offer(
                    &mut queues,
                    days,
                    12,
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
                            5
                        } else {
                            6
                        }
                    } else {
                        11
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
                battery(3, Transfer::AddCycle, source_surplus * dest_import);
            }
            if from > to && source_surplus > EPS && dest_import > EPS {
                battery(4, Transfer::AddCycle, source_surplus * dest_import);
            }
            if q[from].charge_w > EPS && dest_surplus > EPS {
                battery(
                    if to > from { 4 } else { 3 },
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
                    8,
                    Transfer::AddCycle,
                    (p.slots[to].import_price - p.slots[from].import_price) * dest_import,
                );
            }
            if q[from].discharge_w > EPS
                && dest_import > EPS
                && p.slots[to].import_price > p.slots[from].import_price
            {
                battery(
                    if to > from { 9 } else { 7 },
                    Transfer::DischargeMove,
                    (p.slots[to].import_price - p.slots[from].import_price) * dest_import,
                );
            }
            if q[from].charge_w > EPS && delta > 0.0 {
                battery(8, Transfer::ChargeMove, delta * q[from].charge_w);
            }
            if p.limits.battery_export_enabled
                && p.slots[to].export_price >= p.limits.battery_export_min_price
            {
                if p.slots[to].export_price
                    > p.slots[from].import_price
                        / (model.charge_efficiency * model.discharge_efficiency)
                {
                    battery(
                        10,
                        Transfer::AddCycle,
                        (p.slots[to].export_price - p.slots[from].import_price)
                            * model.discharge_max_w,
                    );
                }
                if q[from].discharge_w > EPS
                    && p.slots[to].export_price > p.slots[from].import_price
                {
                    battery(
                        10,
                        Transfer::DischargeMove,
                        q[from].discharge_w * p.slots[to].export_price,
                    );
                }
            }
            if q[from].charge_w > EPS && q[to].discharge_w > EPS {
                battery(13, Transfer::CutCycle, q[from].charge_w + q[to].discharge_w);
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
            device,
            from: _,
            to: _,
            left,
            right,
            trim_left,
            trim_right,
            reverse,
        } => {
            let start = left + trim_left;
            let end = right.checked_sub(trim_right)?;
            if start >= end {
                return None;
            }
            let old_energy = (left..right)
                .map(|i| watts(p, &commands[i], device) * projected_hours(&p.slots[i]))
                .sum::<f64>();
            for (i, c) in commands.iter_mut().enumerate().take(right).skip(left) {
                if device == 0 {
                    c.pool_on = i >= start && i < end;
                } else {
                    c.ev_amps = if i < start || i >= end {
                        0
                    } else {
                        c.ev_amps.max(p.charger.as_ref()?.min_current_a)
                    };
                }
            }
            let mut excess = (left..right)
                .map(|i| watts(p, &commands[i], device) * projected_hours(&p.slots[i]))
                .sum::<f64>()
                - old_energy;
            if device == 1 {
                let order: Vec<usize> = if reverse {
                    (start..end).rev().collect()
                } else {
                    (start..end).collect()
                };
                for i in order {
                    let before = commands[i].ev_amps;
                    let unit = f64::from(p.charger.as_ref()?.phase_count)
                        * p.charger.as_ref()?.voltage_v
                        * projected_hours(&p.slots[i]);
                    let steps = (excess.abs()
                        / unit
                        / f64::from(p.charger.as_ref()?.current_step_a)
                        + 1e-8)
                        .floor() as u32;
                    let amps = if excess > 0.0 {
                        before
                            .saturating_sub(
                                steps.saturating_mul(p.charger.as_ref()?.current_step_a),
                            )
                            .max(p.charger.as_ref()?.min_current_a)
                    } else {
                        before
                            .saturating_add(
                                steps.saturating_mul(p.charger.as_ref()?.current_step_a),
                            )
                            .min(p.charger.as_ref()?.max_current_a)
                    };
                    commands[i].ev_amps = amps;
                    excess += (f64::from(amps) - f64::from(before)) * unit;
                }
                for (i, c) in commands.iter().enumerate().take(right).skip(left) {
                    deliveries.push(Delivery {
                        slot: i,
                        flow: Flow::Ev,
                        watts: p.charger.as_ref()?.watts(c.ev_amps)?,
                    });
                }
            }
            if excess.abs() > EPS {
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
        Proposal::Ev { from, to } | Proposal::Overlap { from, to, ev: true } => {
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
        Proposal::Battery { from, to, transfer } => {
            battery_edit(
                p,
                q,
                &mut commands,
                &mut deliveries,
                (from, to),
                transfer,
                family == 10,
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
        Transfer::ChargeMove => (
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
                Transfer::ChargeMove => {
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
        Proposal::Gap { .. } | Proposal::Overlap { .. } => {
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
        | Proposal::Overlap { from, to, .. } => p.slots[from].published && p.slots[to].published,
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
) -> WitnessAudit {
    let n = commands.len();
    let days = n.div_ceil(96);
    let mut out = WitnessAudit {
        gaps: vec![[false; 2]; n],
        overlap: vec![false; n],
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
    let preparation = (n as u64)
        .saturating_mul(n as u64)
        .saturating_mul((32 + cap * 8) as u64)
        + (n as u64) * (256 + u64::from(p.charger.as_ref().map_or(0, |c| c.max_current_a)) * 4);
    if !work.spend(preparation) {
        for c in &mut out.coverage {
            c.quota_exhausted = true;
        }
        return out;
    }
    let queues = enumerate(p, commands, quarters, cap);
    let before_exposure = [
        exposure(p, quarters, index, 0),
        exposure(p, quarters, index, 1),
    ];
    let mut overlap_commands = commands.to_vec();
    let mut overlap_q = quarters.to_vec();
    let mut destinations = vec![false; n];
    let mut prior_delivery = Vec::new();
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
        for (family, family_name) in FAMILIES.iter().enumerate() {
            for day in 0..days {
                let qi = family * days + day;
                if cursors[qi] >= queues[qi].len() {
                    continue;
                }
                if trials >= quota {
                    break 'rounds;
                }
                // Pay copying, comparisons, exposure, native amp enumeration,
                // interval margins and explanation materialization before trial.
                if !work.spend(
                    n as u64 * (96 + u64::from(p.charger.as_ref().map_or(0, |c| c.max_current_a))),
                ) {
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
                let (base, baseline): (&[Command], &[Quarter]) = if family == 2 {
                    (&overlap_commands, &overlap_q)
                } else if family >= 3 {
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
                if let Proposal::Gap {
                    device, from, to, ..
                } = candidate.proposal
                {
                    if (from..to).any(|i| out.gaps[i][device]) {
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
                if family == 2
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
                let points;
                if family < 2 {
                    let Proposal::Gap {
                        device, from, to, ..
                    } = candidate.proposal
                    else {
                        unreachable!()
                    };
                    for row in &mut out.gaps[from..to] {
                        row[device] = true;
                    }
                    points = -policy::rule(
                        p,
                        if device == 0 {
                            RuleKey::PoolShortGap
                        } else {
                            RuleKey::EvShortGap
                        },
                    )
                    .map_or(0, |r| r.points)
                        * (to - from) as i32;
                } else if family == 2 {
                    let Proposal::Overlap { from, to, .. } = candidate.proposal else {
                        unreachable!()
                    };
                    out.overlap[from] = true;
                    destinations[to] = true;
                    prior_delivery.extend(edited.deliveries);
                    overlap_commands = edited.commands.clone();
                    overlap_q = after;
                    points = -policy::rule(p, RuleKey::LargeLoadOverlap).map_or(0, |r| r.points);
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
                    points = if published { changed.len() as i32 } else { 0 };
                    economic_commands[economic_ledger] = edited.commands.clone();
                    economic_q[economic_ledger] = after;
                }
                out.coverage[family].proven += 1;
                out.repairs.push(Repair {
                    commands: edited.commands,
                    family: (*family_name).into(),
                    expected_points: points,
                });
            }
        }
        if !progressed {
            break;
        }
    }
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
            abi: 5,
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
                    key: RuleKey::EvShortGap,
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
        let audit = audit(p, commands, &q, &index, &mut work, quota);
        assert!(work.used + work.reserved <= work.limit);
        assert!(work.witness_trials <= quota as u64);
        for repair in &audit.repairs {
            for c in &repair.commands {
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
        assert!(yes.gaps[1][0]);
        assert!(yes.repairs.iter().any(|r| r.family == "pool_short_gap"));
        // Neither joined alternative fits the occupied middle quarter.
        p.slots[1].base_w = p.limits.import_w;
        let no = run(&p, &c, 192);
        assert!(!no.gaps[1][0]);
    }
    #[test]
    fn equal_price_native_ev_gap_is_repaired_without_minimum_run_rule() {
        let p = problem(3);
        let mut c = vec![idle(); 3];
        c[0].ev_amps = 16;
        c[2].ev_amps = 16;
        let result = run(&p, &c, 192);
        assert!(result.gaps[1][1]);
        for repair in result.repairs.iter().filter(|r| r.family == "ev_short_gap") {
            let after = physics::projection(&p, &repair.commands).unwrap();
            let before = physics::projection(&p, &c).unwrap();
            assert!(
                (after.last().unwrap().ev_kwh.unwrap() - before.last().unwrap().ev_kwh.unwrap())
                    .abs()
                    < EPS
            );
        }
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
    fn uneconomic_cycle_proves_saving_and_never_scores_unpublished_prices() {
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
        assert!(forecast
            .repairs
            .iter()
            .filter(|r| r.family == "uneconomic_cycling")
            .all(|r| r.expected_points == 0));
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
        let forecast_at = result
            .repairs
            .iter()
            .position(|r| r.family == "uneconomic_cycling" && r.expected_points == 0)
            .unwrap();
        let known_at = result
            .repairs
            .iter()
            .position(|r| r.family == "uneconomic_cycling" && r.expected_points > 0)
            .unwrap();
        assert!(
            forecast_at < known_at,
            "exercise a known repair after a forecast repair"
        );
        for repair in result.repairs.iter().filter(|r| r.expected_points > 0) {
            assert_eq!(&repair.commands[..2], &commands[..2]);
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
        assert!(!result.gaps[1][0]);
        assert!(result.repairs.iter().all(|r| r.commands[..4] == c[..4]));
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
}
