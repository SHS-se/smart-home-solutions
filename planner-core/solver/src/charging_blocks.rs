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
    battery_trials(p, commands, q, &mut relocations, work);
    Some(relocations)
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
            if stored(room) + 1e-9 < target {
                continue;
            }
            let (mut low, mut high) = (0.0, room);
            for _ in 0..64 {
                let mid = (low + high) / 2.0;
                if stored(mid) < target {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            let power = high.ceil();
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
