//! Energy-preserving charging moves scored with the complete household plan.
use crate::commitments;

use crate::{physics, Command, Problem, Work};

#[derive(Clone, Copy, Debug)]
pub(crate) struct Packing {
    start: usize,
    end: usize,
    descending: bool,
}
impl Packing {
    pub fn apply(self, commands: &[Command]) -> Vec<Command> {
        let mut amps: Vec<_> = commands[self.start..self.end]
            .iter()
            .map(|c| c.ev_amps)
            .collect();
        amps.sort_unstable();
        if self.descending {
            amps.reverse();
        }
        let mut out = commands.to_vec();
        for (c, amps) in out[self.start..self.end].iter_mut().zip(amps) {
            c.ev_amps = amps;
        }
        out
    }
}

/// Spend two complete battery trials on the most fragmented active session.
/// Equal-duration exchanges preserve EV energy. Other durations, availability
/// and commitments partition this neighbourhood; they never reject a plan.
pub(crate) fn permutations(
    p: &Problem,
    commands: &[Command],
    work: &mut Work,
) -> Option<Vec<Packing>> {
    let n = commands.len();
    // Scan, two command copies and two native-current sorts.
    if !work.spend(n as u64 * (n.max(1).ilog2() as u64 + 8) * 4) {
        return None;
    }
    let eligible = |i: usize| {
        !commitments::hold(p, i).has(commitments::Owner::Ev)
            && p.slots[i].ev_available
            && commands[i].ev_amps > 0
    };
    let mut windows = Vec::new();
    let mut start = 0;
    while start < n {
        if !eligible(start) {
            start += 1;
            continue;
        }
        let mut end = start + 1;
        while end < n
            && eligible(end)
            && physics::projected_hours(&p.slots[end]) == physics::projected_hours(&p.slots[start])
        {
            end += 1;
        }
        let changes = commands[start..end]
            .windows(2)
            .filter(|pair| pair[0].ev_amps != pair[1].ev_amps)
            .count();
        if changes > 0 {
            windows.push((changes, end - start, start, end));
        }
        start = end;
    }
    let Some((_, _, start, end)) = windows
        .into_iter()
        .max_by_key(|&(changes, len, start, _)| (changes, len, std::cmp::Reverse(start)))
    else {
        return Some(Vec::new());
    };
    Some(
        [false, true]
            .into_iter()
            .filter(|&descending| {
                commands[start..end].windows(2).any(|pair| {
                    if descending {
                        pair[0].ev_amps < pair[1].ev_amps
                    } else {
                        pair[0].ev_amps > pair[1].ev_amps
                    }
                })
            })
            .map(|descending| Packing {
                start,
                end,
                descending,
            })
            .collect(),
    )
}

/// A complete proposal owns its replacement battery commands, or requests a
/// response to a changed EV schedule. The builder alone projects and adopts it.
pub(crate) struct Trial {
    pub commands: Vec<Command>,
    pub battery_response: bool,
}
#[derive(Clone, Copy, PartialEq)]
struct Window {
    gain: f64,
    source: usize,
    start: usize,
    shape: usize,
}
fn ev_cost(p: &Problem, amps: &[u32]) -> f64 {
    let mut previous = p.charging_before.ev_amps;
    let mut changes = 0;
    for &a in amps {
        changes += usize::from(previous.is_some_and(|old| old != a));
        previous = Some(a);
    }
    changes as f64 * p.limits.ev_change_preference_sek
}
fn shape(total: u32, level: u32, charger: &crate::Charger) -> Option<Vec<u32>> {
    let n = total / level;
    let remainder = total % level;
    let legal = |a| charger.watts(a).is_some();
    let mut out = vec![level; n as usize];
    if remainder > 0 {
        if legal(remainder) {
            out.push(remainder);
        } else {
            out.pop()?;
            let sum = level + remainder;
            let a = (charger.min_current_a..=charger.max_current_a)
                .rev()
                .find(|&a| a < sum && legal(a) && legal(sum - a))?;
            out.extend([a, sum - a]);
        }
    }
    (!out.is_empty()).then_some(out)
}

/// EV relocations. Eligibility is an index, not a new validity rule.
/// Bounded source groups × starts × native currents; no start/end cross product.
pub(crate) fn proposals(
    p: &Problem,
    commands: &[Command],
    q: &[crate::Quarter],
    work: &mut Work,
) -> Option<Vec<Trial>> {
    let n = commands.len();
    let levels = p.charger.as_ref().map_or(1, |c| {
        (c.max_current_a - c.min_current_a) / c.current_step_a + 1
    });
    if !work.spend(n as u64 * (u64::from(levels) * 448 + 4096)) {
        return None;
    }
    let mut trials: Vec<Trial> = permutations(p, commands, work)?
        .into_iter()
        .map(|edit| Trial {
            commands: edit.apply(commands),
            battery_response: true,
        })
        .collect();
    let Some(charger) = p.charger.as_ref() else {
        battery_trials(p, commands, q, &mut trials, work);
        return Some(trials);
    };
    let movable = |i: usize| {
        !commitments::hold(p, i).has(commitments::Owner::Ev)
            && p.slots[i].ev_available
            && !commitments::unavailable(p, i, commitments::Owner::Ev)
    };
    let mut sessions: Vec<Vec<usize>> = Vec::new();
    let mut at = 0;
    while at < n {
        if !movable(at) || commands[at].ev_amps == 0 {
            at += 1;
            continue;
        }
        let hours = physics::projected_hours(&p.slots[at]);
        let start = at;
        at += 1;
        while at < n
            && movable(at)
            && commands[at].ev_amps > 0
            && physics::projected_hours(&p.slots[at]) == hours
        {
            at += 1;
        }
        sessions.push((start..at).collect());
    }
    let mut sources = sessions.clone();
    sources.extend(sessions.windows(2).map(|pair| pair.concat()));
    sources.sort_by_key(|source| {
        let changes = source
            .windows(2)
            .filter(|pair| {
                pair[1] != pair[0] + 1 || commands[pair[0]].ev_amps != commands[pair[1]].ev_amps
            })
            .count();
        (
            std::cmp::Reverse(changes),
            std::cmp::Reverse(source.len()),
            source[0],
        )
    });
    sources.truncate(3);
    if !sessions.is_empty() {
        sources.insert(0, sessions.concat());
    }
    for source in &mut sources {
        let hours = physics::projected_hours(&p.slots[source[0]]);
        source.retain(|&i| physics::projected_hours(&p.slots[i]) == hours);
    }
    sources.dedup();
    let full_sources = sources.len();
    // A whole session can be too big for earlier free quarters. Try a few
    // prefixes of the first movable long session, keeping its tail in place.
    if let Some(first) = sessions.iter().find(|s| s.len() > 2) {
        for len in 2..first.len().min(5) {
            sources.push(first[..len].to_vec());
        }
    }
    let old_amps: Vec<_> = commands.iter().map(|c| c.ev_amps).collect();
    let old_preference = ev_cost(p, &old_amps);
    let mut windows = Vec::new();
    let mut representatives = Vec::new();
    let mut early_partial: Option<Window> = None;
    let mut shapes = Vec::new();
    for (source_id, source) in sources.iter().enumerate() {
        let partial = source_id >= full_sources;
        let hours = physics::projected_hours(&p.slots[source[0]]);
        let mut daily: Vec<Option<Window>> = vec![None; n.div_ceil(96)];
        let mut earliest: Option<Window> = None;
        let mut adjacent: Option<Window> = None;
        let total = source.iter().map(|&i| commands[i].ev_amps).sum();
        let mut cleared = old_amps.clone();
        for &i in source {
            cleared[i] = 0;
        }
        let clear_preference = ev_cost(p, &cleared);
        let removed_cash: f64 = source
            .iter()
            .map(|&i| q[i].ev_w * hours / 1000.0 * p.slots[i].import_price)
            .sum();
        let free: Vec<_> = (0..n)
            .map(|i| {
                (!partial || i < source[0])
                    && movable(i)
                    && cleared[i] == 0
                    && physics::projected_hours(&p.slots[i]) == hours
            })
            .collect();
        let caps: Vec<_> = (0..n)
            .map(|i| {
                let s = &p.slots[i];
                // A relaxed equipment bound: eligible house demand may be supplied
                // by storage. Actual inventory and permissions are projected later.
                let support = p
                    .battery
                    .as_ref()
                    .map_or(0.0, |b| b.maximum_discharge_ac_w());
                let headroom = if partial {
                    // This lane deliberately seeks space with the current
                    // battery plan intact. The full-session lane may reallocate it.
                    p.limits.import_w - q[i].net_w
                } else {
                    let house = (s.base_w + q[i].pool_command_w - support).max(0.0);
                    p.limits.import_w + s.solar_w - house
                };
                let cap = charger.fitting_amps(headroom.max(0.0));
                s.ev_current_ceiling_a
                    .map_or(cap, |ceiling| cap.min(ceiling))
            })
            .collect();
        let mut cash_prefix = vec![0.0; n + 1];
        for i in 0..n {
            cash_prefix[i + 1] = cash_prefix[i]
                + p.slots[i].import_price
                    * hours
                    * charger.voltage_v
                    * f64::from(charger.phase_count)
                    / 1000.0;
        }
        for level in
            (charger.min_current_a..=charger.max_current_a).step_by(charger.current_step_a as usize)
        {
            let Some(amps) = shape(total, level, charger) else {
                continue;
            };
            if amps.len() > n {
                continue;
            }
            let mut blocked = vec![0usize; n + 1];
            for i in 0..n {
                blocked[i + 1] = blocked[i] + usize::from(!free[i] || caps[i] < level);
            }
            let main = amps.iter().take_while(|&&a| a == level).count();
            let internal_changes = amps.windows(2).filter(|a| a[0] != a[1]).count();
            let shape = shapes.len();
            for start in 0..=n - amps.len() {
                let end = start + amps.len();
                if blocked[start + main] != blocked[start]
                    || amps[main..]
                        .iter()
                        .enumerate()
                        .any(|(j, &a)| !free[start + main + j] || caps[start + main + j] < a)
                {
                    continue;
                }
                let mut cash = f64::from(level) * (cash_prefix[start + main] - cash_prefix[start]);
                for (j, &a) in amps[main..].iter().enumerate() {
                    let i = start + main + j;
                    cash += f64::from(a) * (cash_prefix[i + 1] - cash_prefix[i]);
                }
                let before = if start == 0 {
                    p.charging_before.ev_amps
                } else {
                    Some(cleared[start - 1])
                };
                let old_edges = usize::from(before.is_some_and(|a| a != 0))
                    + usize::from(end < n && cleared[end] != 0);
                let new_edges = usize::from(before.is_some_and(|a| a != amps[0]))
                    + internal_changes
                    + usize::from(end < n && cleared[end] != *amps.last().unwrap());
                let gain = removed_cash - cash + old_preference - clear_preference
                    + (old_edges as f64 - new_edges as f64) * p.limits.ev_change_preference_sek;
                let window = Window {
                    gain,
                    source: source_id,
                    start,
                    shape,
                };
                let day = &mut daily[start / 96];
                if day.is_none_or(|old| gain > old.gain) {
                    *day = Some(window);
                }
                if earliest
                    .is_none_or(|old| start < old.start || (start == old.start && gain > old.gain))
                {
                    earliest = Some(window);
                }
                if (before == Some(amps[0]) || end < n && cleared[end] == *amps.last().unwrap())
                    && adjacent.is_none_or(|old| gain > old.gain)
                {
                    adjacent = Some(window);
                }
            }
            shapes.push(amps);
        }
        let best = daily
            .iter()
            .flatten()
            .copied()
            .max_by(|a, b| a.gain.total_cmp(&b.gain));
        if partial {
            if let Some(window) = daily.into_iter().flatten().next() {
                if early_partial.is_none_or(|old| {
                    window.start / 96 < old.start / 96
                        || window.start / 96 == old.start / 96 && window.gain > old.gain
                }) {
                    early_partial = Some(window);
                }
            }
            continue;
        }
        representatives.extend(best);
        // The whole demand gets temporal and adjacency representatives even
        // when its isolated import estimate is unfavourable.
        if source_id == 0 {
            representatives.extend(earliest);
            representatives.extend(adjacent);
        }
        windows.extend(daily.into_iter().flatten());
    }
    // Reserve a scored slot for the earlier partial block.
    if let Some(window) = early_partial {
        representatives.insert(1.min(representatives.len()), window);
    }
    windows.sort_by(|a, b| b.gain.total_cmp(&a.gain).then(a.start.cmp(&b.start)));
    representatives.extend(windows);
    let mut relocations = Vec::new();
    for window in representatives {
        let mut next = commands.to_vec();
        for &i in &sources[window.source] {
            next[i].ev_amps = 0;
        }
        for (i, &a) in shapes[window.shape].iter().enumerate() {
            next[window.start + i].ev_amps = a;
        }
        if next != commands
            && !relocations
                .iter()
                .chain(trials.iter())
                .any(|t: &Trial| t.commands == next)
        {
            relocations.push(Trial {
                commands: next,
                battery_response: true,
            });
        }
    }
    relocations.extend(trials);
    let mut combined = paired_trials(p, commands, q, &sessions, work);
    combined.extend(relocations);
    battery_trials(p, commands, q, &mut combined, work);
    Some(combined)
}

fn grid_charge(c: &Command) -> bool {
    c.battery == crate::Operation::GridCharge
}

/// Lowest whole-watt request delivering the target at the proposal's headroom.
fn level_charge(target: f64, room: f64, stored: impl Fn(f64) -> f64) -> Option<f64> {
    if room <= 0.0 || stored(room) + 1e-9 < target {
        return None;
    }
    let (mut low, mut high) = (0.0, room.ceil());
    for _ in 0..64 {
        let mid = ((low + high) / 2.0).floor();
        if mid <= low || mid >= high {
            break;
        }
        if stored(mid) < target {
            low = mid;
        } else {
            high = mid;
        }
    }
    Some(high)
}

struct BatteryBlock {
    from: usize,
    to: usize,
    power_w: f64,
    cost: f64,
}

struct PairedBlock<'a> {
    rank: f64,
    ev_from: usize,
    amps: Vec<u32>,
    battery: &'a BatteryBlock,
}

/// Test a handoff in both orders when nearby EV sessions and grid charging
/// compete. The neighborhood moves both energy allocations in one trial.
/// Serial charging is a proposal shape, not a restriction on valid plans.
fn paired_trials(
    p: &Problem,
    commands: &[Command],
    q: &[crate::Quarter],
    sessions: &[Vec<usize>],
    work: &mut Work,
) -> Vec<Trial> {
    const MAX_WINDOW: usize = 32;
    const MAX_WINDOWS: usize = 2;
    let Some((battery, charger)) = p.battery.as_ref().zip(p.charger.as_ref()) else {
        return Vec::new();
    };
    let n = commands.len();
    if !work.spend(n as u64 * (MAX_WINDOW as u64 * 16 + work.unit_cost)) {
        return Vec::new();
    }
    let editable = |i| {
        !commitments::hold(p, i).has(commitments::Owner::Ev)
            && !commitments::hold(p, i).has(commitments::Owner::Battery)
            && !commitments::unavailable(p, i, commitments::Owner::Ev)
            && !commitments::unavailable(p, i, commitments::Owner::Battery)
            && p.slots[i].ev_available
    };
    let mut windows = Vec::new();
    for count in [2, 3] {
        for group in sessions.windows(count) {
            let mut start = group[0][0];
            let mut end = group[count - 1].last().unwrap() + 1;
            // Include the full grid block at either boundary when it overlaps.
            while start > 0
                && end - start < MAX_WINDOW
                && grid_charge(&commands[start])
                && grid_charge(&commands[start - 1])
            {
                start -= 1;
            }
            while end < n
                && end - start < MAX_WINDOW
                && grid_charge(&commands[end - 1])
                && grid_charge(&commands[end])
            {
                end += 1;
            }
            let span = start..end;
            if span.len() > MAX_WINDOW
                || (start > 0 && grid_charge(&commands[start]) && grid_charge(&commands[start - 1]))
                || (end < n && grid_charge(&commands[end - 1]) && grid_charge(&commands[end]))
                || !span.clone().any(|i| grid_charge(&commands[i]))
                || !span.clone().all(|i| {
                    editable(i)
                        && physics::projected_hours(&p.slots[i])
                            == physics::projected_hours(&p.slots[start])
                })
            {
                continue;
            }
            let changes = commands[span.clone()]
                .windows(2)
                .map(|c| {
                    let a = crate::charging::Settings::commanded(&c[0]);
                    let b = crate::charging::Settings::commanded(&c[1]);
                    usize::from(a.ev != b.ev) + usize::from(a.battery_grid != b.battery_grid)
                })
                .sum::<usize>();
            windows.push((std::cmp::Reverse(changes), start, end));
        }
    }
    windows.sort_unstable();
    windows.dedup();
    let mut trials = Vec::new();
    for (_, start, end) in windows.into_iter().take(MAX_WINDOWS) {
        let m = (end - start) as u64;
        if !work.spend(64 * m.pow(3) + m * work.unit_cost) {
            break;
        }
        let hours = physics::projected_hours(&p.slots[start]);
        let total_amps = commands[start..end]
            .iter()
            .map(|c| u64::from(c.ev_amps))
            .sum::<u64>();
        let target_dc = (start..end)
            .filter(|&i| grid_charge(&commands[i]))
            .map(|i| q[i].charge_dc_w)
            .sum::<f64>();
        if target_dc <= 0.0 {
            continue;
        }
        let house = |i: usize| p.slots[i].base_w + q[i].pool_w;
        let headroom = |i: usize| p.limits.import_w + p.slots[i].solar_w - house(i);
        let mut battery_blocks = Vec::new();
        for from in start..end {
            let mut room = battery.maximum_charge_ac_w();
            let mut price = 0.0;
            for to in from + 1..=end {
                let i = to - 1;
                // Leave useful solar capture and supply in place.
                if !grid_charge(&commands[i])
                    && (q[i].charge_dc_w > 0.0 || q[i].discharge_dc_w > 0.0)
                    || commands[i].battery == crate::Operation::Export
                {
                    break;
                }
                let pv = p.slots[i].solar_w;
                room = room
                    .min(battery.charge_grid_room_w(headroom(i).max(0.0), pv, house(i)))
                    .min(battery.charge_ac_w(battery.charge_max_w, pv, house(i)));
                price += p.slots[i].import_price;
                let stored = |w| {
                    (from..to)
                        .map(|j| battery.charge_dc_w(w, p.slots[j].solar_w, house(j)))
                        .sum::<f64>()
                };
                if let Some(power) = level_charge(target_dc, room.floor(), stored) {
                    battery_blocks.push(BatteryBlock {
                        from,
                        to,
                        power_w: power,
                        cost: power * price * hours / 1000.0,
                    });
                }
            }
        }
        let ev_caps: Vec<_> = (start..end)
            .map(|i| {
                let room = (headroom(i)
                    - (q[i].pool_command_w - q[i].pool_w).max(0.0)
                    - battery.conversion.idle_loss_w)
                    .max(0.0);
                let cap = charger.fitting_amps(room);
                p.slots[i].ev_current_ceiling_a.map_or(cap, |c| cap.min(c))
            })
            .collect();
        let mut best: Option<PairedBlock<'_>> = None;
        // The cheapest battery block that fits before or after each boundary
        // is sufficient for ranking any disjoint pair.
        let cheaper = |a: &BatteryBlock, b: &BatteryBlock| a.cost.total_cmp(&b.cost);
        let before: Vec<_> = (start..=end)
            .map(|i| {
                battery_blocks
                    .iter()
                    .filter(|b| b.to <= i)
                    .min_by(|a, b| cheaper(a, b))
            })
            .collect();
        let after: Vec<_> = (start..=end)
            .map(|i| {
                battery_blocks
                    .iter()
                    .filter(|b| b.from >= i)
                    .min_by(|a, b| cheaper(a, b))
            })
            .collect();
        let watt_per_amp = charger.voltage_v * f64::from(charger.phase_count);
        for len in 1..=end - start {
            let slots = len as u64;
            let min = u64::from(charger.min_current_a);
            let step = u64::from(charger.current_step_a);
            let Some(extra) = total_amps.checked_sub(min * slots) else {
                break;
            };
            if !extra.is_multiple_of(step) {
                continue;
            }
            let steps = extra / step;
            let low = min + (steps / slots) * step;
            let raised = (steps % slots) as usize;
            let high = low + u64::from(raised > 0) * step;
            if high > u64::from(charger.max_current_a) {
                continue;
            }
            let (low, high) = (low as u32, high as u32);
            for high_first in [true, false] {
                if !high_first && raised == 0 {
                    continue;
                }
                let amps = |j| {
                    if (high_first && j < raised) || (!high_first && j >= len - raised) {
                        high
                    } else {
                        low
                    }
                };
                for from in start..=end - len {
                    if (0..len).any(|j| amps(j) > ev_caps[from + j - start]) {
                        continue;
                    }
                    let cost = (0..len)
                        .map(|j| f64::from(amps(j)) * p.slots[from + j].import_price)
                        .sum::<f64>()
                        * watt_per_amp
                        * hours
                        / 1000.0
                        + if raised > 0 {
                            p.limits.ev_change_preference_sek
                        } else {
                            0.0
                        };
                    for battery in [before[from - start], after[from + len - start]]
                        .into_iter()
                        .flatten()
                    {
                        let rank = cost + battery.cost;
                        if best.as_ref().is_none_or(|old| rank < old.rank) {
                            best = Some(PairedBlock {
                                rank,
                                ev_from: from,
                                amps: (0..len).map(amps).collect(),
                                battery,
                            });
                        }
                    }
                }
            }
        }
        if let Some(block) = best {
            let mut next = commands.to_vec();
            for c in &mut next[start..end] {
                c.ev_amps = 0;
                if grid_charge(c) {
                    c.battery = crate::Operation::Idle;
                    c.charge_limit_w = 0.0;
                    c.discharge_limit_w = 0.0;
                }
            }
            for (i, a) in block.amps.into_iter().enumerate() {
                next[block.ev_from + i].ev_amps = a;
            }
            for c in &mut next[block.battery.from..block.battery.to] {
                c.battery = crate::Operation::GridCharge;
                c.charge_limit_w = block.battery.power_w;
                c.discharge_limit_w = 0.0;
            }
            if next != commands && !trials.iter().any(|t: &Trial| t.commands == next) {
                trials.push(Trial {
                    commands: next,
                    battery_response: false,
                });
            }
        }
    }
    trials
}

fn battery_trials(
    p: &Problem,
    commands: &[Command],
    q: &[crate::Quarter],
    out: &mut Vec<Trial>,
    work: &mut Work,
) {
    let Some(battery) = p.battery.as_ref() else {
        return;
    };
    let n = commands.len();
    if !work.spend(n as u64 * (work.unit_cost * 256 + 4096)) {
        return;
    }
    let eligible = |i| {
        !commitments::hold(p, i).has(commitments::Owner::Battery)
            && !commitments::unavailable(p, i, commitments::Owner::Battery)
    };
    let mut runs = Vec::new();
    let mut i = 0;
    while i < n {
        if !eligible(i) || commands[i].battery != crate::Operation::GridCharge {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        while i < n && eligible(i) && commands[i].battery == crate::Operation::GridCharge {
            i += 1;
        }
        runs.push((start, i));
    }
    let mut groups = runs.clone();
    groups.extend(runs.windows(2).map(|pair| (pair[0].0, pair[1].1)));
    let changes = |(from, to): (usize, usize)| {
        commands[from..to]
            .windows(2)
            .filter(|c| {
                crate::charging::Settings::commanded(&c[0]).battery_grid
                    != crate::charging::Settings::commanded(&c[1]).battery_grid
            })
            .count()
    };
    groups.retain(|&span| changes(span) > 0);
    groups.sort_by_key(|&(from, to)| (std::cmp::Reverse(changes((from, to))), from));
    for (from, to) in groups.into_iter().take(2) {
        let target: f64 = (from..to)
            .map(|i| q[i].charge_dc_w * physics::projected_hours(&p.slots[i]) / 1000.0)
            .sum();
        if target <= 0.0 {
            continue;
        }
        for (start, end) in [
            (from, to),
            (from.saturating_sub(1), to),
            (from, to.saturating_add(1).min(n)),
            (from.saturating_sub(2), to),
        ] {
            if (start..end).any(|i| {
                !eligible(i)
                    || q[i].discharge_w > 0.0
                    || (commands[i].battery == crate::Operation::GridCharge
                        && !(from..to).contains(&i))
            }) {
                continue;
            }
            let room = (start..end)
                .map(|i| {
                    let s = &p.slots[i];
                    let house = s.base_w + q[i].pool_w + q[i].ev_w;
                    battery
                        .charge_grid_room_w(
                            (p.limits.import_w + s.solar_w - house).max(0.0),
                            s.solar_w,
                            house,
                        )
                        .min(battery.maximum_charge_ac_w())
                })
                .fold(f64::INFINITY, f64::min);
            let stored = |power| {
                (start..end)
                    .map(|i| {
                        let s = &p.slots[i];
                        battery.charge_dc_w(power, s.solar_w, s.base_w + q[i].pool_w + q[i].ev_w)
                            * physics::projected_hours(s)
                            / 1000.0
                    })
                    .sum::<f64>()
            };
            let Some(power) = level_charge(target, room, stored) else {
                continue;
            };
            let excess = (stored(power) - target).max(0.0);
            let last = end - 1;
            let s = &p.slots[last];
            let house = s.base_w + q[last].pool_w + q[last].ev_w;
            let dc = (battery.charge_dc_w(power, s.solar_w, house)
                - excess * 1000.0 / physics::projected_hours(s))
            .max(0.0);
            let edge = battery.charge_ac_w(dc, s.solar_w, house).ceil();
            let mut next = commands.to_vec();
            for c in &mut next[start..end] {
                c.battery = crate::Operation::GridCharge;
                c.charge_limit_w = power;
                c.discharge_limit_w = 0.0;
            }
            next[last].charge_limit_w = edge;
            if edge == 0.0 {
                next[last].battery = crate::Operation::Idle;
            }
            if next != commands && !out.iter().any(|t| t.commands == next) {
                out.push(Trial {
                    commands: next,
                    battery_response: false,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Operation, Work};
    fn idle() -> Command {
        Command {
            pool_on: false,
            ev_amps: 0,
            battery: Operation::Idle,
            charge_limit_w: 0.0,
            discharge_limit_w: 0.0,
        }
    }
    fn work() -> Work {
        Work {
            used: 0,
            limit: 1_520_000_000,
            reserved: 0,
            unit_cost: 120,
            expansions: 0,
            evaluations: 0,
            witness_trials: 0,
            repairs: 0,
            move_resize_trials: 0,
            move_resize_passes: 0,
            move_resize_improvements: 0,
            charging_block_trials: 0,
            charging_block_improvements: 0,
        }
    }
    fn no_pool(p: &mut Problem) {
        p.heater = None;
        p.pool_store = None;
        p.targets.pool_c = None;
        p.pool_stop_c = None;
        p.initial.pool_c = None;
        p.initial.pool_pending_heat_kwh = None;
        p.initial.heater_state = None;
        p.end_credit.pool = None;
    }
    #[test]
    fn a_whole_ev_session_can_move_to_an_earlier_lower_current_block() {
        // Independent synthetic 72-hour capacity and tariff windows.
        let mut p = crate::witnesses::tests::problem(288);
        no_pool(&mut p);
        p.battery = None;
        p.initial.battery_kwh = None;
        p.end_credit.battery = None;
        p.limits.import_w = 15_000.0;
        let charger = p.charger.as_mut().unwrap();
        charger.voltage_v = 230.0;
        charger.phase_count = 3;
        charger.min_current_a = 5;
        charger.max_current_a = 16;
        charger.current_step_a = 1;
        for (i, s) in p.slots.iter_mut().enumerate() {
            s.base_w = if (12..16).contains(&i) {
                6500.0
            } else if (218..221).contains(&i) {
                1000.0
            } else {
                13000.0
            };
            s.solar_w = 0.0;
            s.import_price = if (12..16).contains(&i) { 0.9 } else { 1.4 };
            s.export_price = 0.0;
        }
        let mut before = vec![idle(); 288];
        for c in &mut before[218..221] {
            c.ev_amps = 16;
        }
        let q = physics::projection(&p, &before).unwrap();
        let offered = proposals(&p, &before, &q, &mut work()).unwrap();
        let trial = offered
            .iter()
            .find(|t| t.commands[12..16].iter().all(|c| c.ev_amps == 12))
            .expect("complete earlier window");
        let after = physics::projection(&p, &trial.commands).unwrap();
        assert_eq!(
            trial.commands[218..221]
                .iter()
                .map(|c| c.ev_amps)
                .sum::<u32>(),
            0
        );
        assert!(
            (after.last().unwrap().ev_kwh.unwrap() - q.last().unwrap().ev_kwh.unwrap()).abs()
                < 1e-9
        );
        assert!(after.iter().map(|q| q.cost).sum::<f64>() < q.iter().map(|q| q.cost).sum::<f64>());

        // The early window cannot hold the entire longer session. A partial
        // block still moves the same energy and leaves the later tail intact.
        for (s, c) in p.slots[221..223].iter_mut().zip(&mut before[221..223]) {
            s.base_w = 1000.0;
            c.ev_amps = 16;
        }
        let q = physics::projection(&p, &before).unwrap();
        let offered = proposals(&p, &before, &q, &mut work()).unwrap();
        let trial = offered
            .iter()
            .find(|t| {
                t.commands[12..16].iter().all(|c| c.ev_amps == 12)
                    && t.commands[218..221].iter().all(|c| c.ev_amps == 0)
                    && t.commands[221..223].iter().all(|c| c.ev_amps == 16)
            })
            .expect("an early block for part of a longer session");
        let after = physics::projection(&p, &trial.commands).unwrap();
        assert!(
            (after.last().unwrap().ev_kwh.unwrap() - q.last().unwrap().ev_kwh.unwrap()).abs()
                < 1e-9
        );
        assert!(after.iter().map(|q| q.cost).sum::<f64>() < q.iter().map(|q| q.cost).sum::<f64>());
    }
    #[test]
    fn interleaved_sessions_can_become_two_continuous_blocks() {
        let mut p = crate::witnesses::tests::problem(20);
        no_pool(&mut p);
        p.initial.battery_kwh = Some(1.0);
        p.limits.ev_change_preference_sek = 0.125;
        p.limits.battery_change_preference_sek = 0.125;
        for s in &mut p.slots {
            s.base_w = 1800.0;
            s.solar_w = 0.0;
            s.import_price = 1.0;
        }
        let mut before = vec![idle(); 20];
        for i in [2, 3, 6, 13] {
            before[i].ev_amps = 10;
        }
        for i in [4, 5, 7, 8, 9, 10, 11] {
            before[i].battery = Operation::GridCharge;
            before[i].charge_limit_w = if i % 2 == 0 { 3000.0 } else { 2400.0 };
        }
        let q = physics::projection(&p, &before).unwrap();
        let trials = proposals(&p, &before, &q, &mut work()).unwrap();
        let starts = |commands: &[Command], active: fn(&Command) -> bool| {
            commands
                .windows(2)
                .filter(|pair| !active(&pair[0]) && active(&pair[1]))
                .count()
        };
        let paired = trials
            .iter()
            .find(|trial| {
                starts(&trial.commands, |c| c.ev_amps > 0) == 1
                    && starts(&trial.commands, grid_charge) == 1
                    && trial
                        .commands
                        .iter()
                        .all(|c| c.ev_amps == 0 || !grid_charge(c))
            })
            .expect("one non-overlapping block per device");
        let after = physics::projection(&p, &paired.commands).unwrap();
        let (previous, new) = (q.last().unwrap(), after.last().unwrap());
        assert!((previous.ev_kwh.unwrap() - new.ev_kwh.unwrap()).abs() < 1e-9);
        assert!((previous.battery_kwh.unwrap() - new.battery_kwh.unwrap()).abs() < 0.001);
        assert!(
            crate::policy::account(&p, &after).score_sek > crate::policy::account(&p, &q).score_sek
        );
    }

    #[test]
    fn battery_blocks_can_merge_across_an_off_gap_without_erasing_supply() {
        let mut p = crate::witnesses::tests::problem(3);
        no_pool(&mut p);
        p.car = None;
        p.charger = None;
        p.car_policy = None;
        p.initial.ev_kwh = None;
        p.end_credit.ev = None;
        for s in &mut p.slots {
            s.base_w = 1000.0;
            s.solar_w = 0.0;
        }
        let mut before = vec![idle(); 3];
        for i in [0, 2] {
            before[i].battery = Operation::GridCharge;
            before[i].charge_limit_w = 1000.0;
        }
        let q = physics::projection(&p, &before).unwrap();
        let offered = proposals(&p, &before, &q, &mut work()).unwrap();
        assert!(offered.iter().any(|t| !t.battery_response
            && t.commands
                .iter()
                .all(|c| c.battery == Operation::GridCharge)));
        before[1].battery = Operation::SelfConsumption;
        before[1].discharge_limit_w = 1000.0;
        let q = physics::projection(&p, &before).unwrap();
        assert!(q[1].discharge_w > 0.0);
        assert!(proposals(&p, &before, &q, &mut work())
            .unwrap()
            .iter()
            .all(|t| t.commands[1] == before[1]));
    }
}
