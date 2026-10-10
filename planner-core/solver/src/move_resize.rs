//! Local command-span proposals. Eligibility is physical projection, never a cash certificate.
use crate::{physics, *};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Device {
    Pool,
    Ev,
}
impl Device {
    fn active(self, c: &Command) -> bool {
        match self {
            Self::Pool => c.pool_on,
            Self::Ev => c.ev_amps > 0,
        }
    }
    fn same(self, a: &Command, b: &Command) -> bool {
        match self {
            Self::Pool => a.pool_on == b.pool_on,
            Self::Ev => a.ev_amps == b.ev_amps,
        }
    }
    fn clear(self, c: &mut Command) {
        match self {
            Self::Pool => c.pool_on = false,
            Self::Ev => c.ev_amps = 0,
        }
    }
    fn copy(self, to: &mut Command, from: &Command) {
        match self {
            Self::Pool => to.pool_on = from.pool_on,
            Self::Ev => to.ev_amps = from.ev_amps,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Destination {
    pub device: Device,
    pub day: usize,
    pub duration: u32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Edit {
    device: Device,
    from: usize,
    to: usize,
    start: usize,
    end: usize,
}
impl Edit {
    pub fn destination(self) -> Destination {
        Destination {
            device: self.device,
            day: self.start / 96,
            duration: (self.end - self.start).ilog2(),
        }
    }
    pub fn apply(self, commands: &[Command]) -> Vec<Command> {
        let setting = &commands[self.from];
        let mut out = commands.to_vec();
        for c in &mut out[self.from..self.to] {
            self.device.clear(c);
        }
        for c in &mut out[self.start..self.end] {
            self.device.copy(c, setting);
        }
        out
    }
}

/// What the quarters cost and save a device that would draw `watts` in them,
/// on the incumbent's own flows, in kronor and as running sums. An estimate
/// that orders proposals only: every proposal tried is scored exactly.
struct Estimate {
    /// Running sum of what drawing `watts` in a quarter that does not would cost.
    add: Vec<f64>,
    /// Running sum of what the device's own draw in a quarter costs there.
    remove: Vec<f64>,
    /// Running sum of the points the direct tariff rules give that draw.
    /// Running sum of the grid energy `watts` books, kWh.
    booked: Vec<f64>,
    /// Running sum of the grid energy the device draws now, kWh.
    drawn: Vec<f64>,
    /// What a kWh more in the device's store is credited at the end.
    stored: f64,
    /// Grid-equivalent energy before the terminal store credit reaches its cap.
    room: f64,
}
impl Estimate {
    fn new(p: &Problem, device: Device, watts: f64, q: &[Quarter]) -> Self {
        let n = q.len();
        let mut out = Self {
            add: vec![0.0; n + 1],
            remove: vec![0.0; n + 1],
            booked: vec![0.0; n + 1],
            drawn: vec![0.0; n + 1],
            stored: 0.0,
            room: 0.0,
        };
        for (i, v) in q.iter().enumerate() {
            let s = &p.slots[i];
            let kwh = physics::projected_hours(s) / 1000.0;
            let own = match device {
                Device::Pool => v.pool_w,
                Device::Ev => v.ev_w,
            };
            // Sun the export limit curtails is free; exported sun is worth its
            // sale price; the rest is bought.
            let surplus = (-v.net_w).max(0.0);
            let extra = watts;
            let unpaid = (extra - v.curtailed_w).max(0.0);
            let add =
                unpaid.min(surplus) * s.export_price + (unpaid - surplus).max(0.0) * s.import_price;
            let imported = v.net_w.max(0.0);
            let remove =
                own.min(imported) * s.import_price + (own - imported).max(0.0) * s.export_price;
            out.add[i + 1] = out.add[i] + add * kwh;
            out.remove[i + 1] = out.remove[i] + remove * kwh;
            out.booked[i + 1] = out.booked[i] + watts * kwh;
            out.drawn[i + 1] = out.drawn[i] + own * kwh;
        }
        // A store short of its cap at the end is credited for what it gains,
        // near enough the reference price per kWh bought for it.
        let (term, end) = match device {
            Device::Pool => (&p.end_credit.pool, q.last().and_then(|v| v.pool_c)),
            Device::Ev => (&p.end_credit.ev, q.last().and_then(|v| v.ev_kwh)),
        };
        if let Some((term, end)) = term.as_ref().zip(end) {
            out.stored = p.end_credit.reference_sek_per_kwh;
            out.room = (term.cap - end) * term.grid_kwh_per_unit;
        }
        out
    }
    /// What the edit should add to the score, in kronor.
    fn gain(&self, e: &Edit) -> f64 {
        let sum = |v: &[f64], from: usize, to: usize| v[to.max(from)] - v[from];
        // Quarters in both spans keep their draw: only the rest moves.
        let (keep_from, keep_to) = (e.from.max(e.start), e.to.min(e.end));
        let outside = |v: &[f64], from: usize, to: usize| {
            if keep_from >= keep_to {
                sum(v, from, to)
            } else {
                sum(v, from, keep_from.min(to)) + sum(v, keep_to.max(from), to)
            }
        };
        let saved = outside(&self.remove, e.from, e.to);
        let cost = outside(&self.add, e.start, e.end);
        let energy = outside(&self.booked, e.start, e.end) - outside(&self.drawn, e.from, e.to);
        let credit = (energy.min(self.room) - 0.0_f64.min(self.room)) * self.stored;
        saved - cost + credit
    }
}

pub(crate) struct Proposals {
    pub singles: Vec<Edit>,
    pub coordinated: Vec<Edit>,
}

pub(crate) fn proposals(
    p: &Problem,
    commands: &[Command],
    quarters: &[Quarter],
    work: &mut Work,
) -> Option<Proposals> {
    let n = commands.len();
    let mut sources = Vec::new();
    for device in [Device::Pool, Device::Ev] {
        let mut i = 0;
        while i < n {
            if physics::locked(p, i) || !device.active(&commands[i]) {
                i += 1;
                continue;
            }
            let from = i;
            i += 1;
            while i < n && !physics::locked(p, i) && device.same(&commands[from], &commands[i]) {
                i += 1;
            }
            sources.push((device, from, i, false));
            // Prefix/suffix transfers can move expensive quarters into a
            // cheaper gap without moving the rest of a useful run. A pool
            // split still pays its actual new start in exact scoring.
            let mut length = 1;
            while length < i - from {
                sources.push((device, from, from + length, true));
                sources.push((device, i - length, i, true));
                length *= 2;
            }
        }
    }
    sources.sort_by_key(|(device, from, to, partial)| (*partial, to - from, *device, *from));
    let mut ranked = Vec::new();
    for (device, from, to, partial) in sources {
        // Bound enumeration and ordering as well as model projection.
        if !work.spend(n as u64 * ((to - from) as u64 * 12 + 512)) {
            return None;
        }
        let c = &commands[from];
        let watts = match device {
            Device::Pool => p
                .heater
                .as_ref()
                .map_or(0.0, |h| h.compressor_w + h.auxiliary_w),
            Device::Ev => p.charger.as_ref().map_or(0.0, |h| {
                c.ev_amps as f64 * h.voltage_v * h.phase_count as f64
            }),
        };
        let estimate = Estimate::new(p, device, watts, quarters);
        let free = |i: usize| {
            !physics::locked(p, i) && (from <= i && i < to || !device.active(&commands[i]))
        };
        let length = to - from;
        if partial {
            // Fixed-length transfers only. Resizing belongs to the whole
            // source, so nested subspans do not multiply the same proposals.
            for start in 0..=n - length {
                let end = start + length;
                if start == from || !(start..end).all(free) {
                    continue;
                }
                let edit = Edit {
                    device,
                    from,
                    to,
                    start,
                    end,
                };
                let gain = estimate.gain(&edit);
                if gain > 0.0 {
                    ranked.push((0, gain, edit));
                }
            }
            continue;
        }
        let mut lengths = BTreeSet::from([1, length.saturating_sub(1).max(1), length, length + 1]);
        // Geometric duration coverage complements adjacent-quarter resizing:
        // a three-quarter source must be able to try a seven-quarter run in
        // one complete trial rather than need four successful passes.
        let mut scale = 2usize;
        while scale <= n {
            lengths.insert(scale);
            lengths.insert(scale - 1);
            scale = scale.saturating_mul(2);
        }
        let mut edits = Vec::new();
        let mut start = 0;
        while start < n {
            if !free(start) {
                start += 1;
                continue;
            }
            let mut end = start + 1;
            while end < n && free(end) {
                end += 1;
            }
            for len in 1..=end - start {
                edits.push(Edit {
                    device,
                    from,
                    to,
                    start,
                    end: start + len,
                });
                edits.push(Edit {
                    device,
                    from,
                    to,
                    start: end - len,
                    end,
                });
            }
            // Try each quarter, including schedules ending at a tariff change,
            // with adjacent and geometric durations.
            for at in start..end {
                for &len in &lengths {
                    let stop = at.saturating_add(len);
                    if stop <= n && (at..stop).all(free) {
                        edits.push(Edit {
                            device,
                            from,
                            to,
                            start: at,
                            end: stop,
                        });
                    }
                    if at + 1 >= len {
                        let begin = at + 1 - len;
                        if (begin..=at).all(free) {
                            edits.push(Edit {
                                device,
                                from,
                                to,
                                start: begin,
                                end: at + 1,
                            });
                        }
                    }
                }
            }
            start = end;
        }
        // The run where it is, stepped: either end moved, or the whole run
        // shifted, by one quarter, two, four and so on. These need no estimate
        // to be worth a trial, and they refine what a coarser edit placed.
        let mut steps = BTreeSet::new();
        let mut step = 1usize;
        while step < n {
            let spans = [
                (from.checked_sub(step), Some(to)),
                (Some(from + step), Some(to)),
                (Some(from), Some(to + step)),
                (Some(from), to.checked_sub(step)),
                (from.checked_sub(step), to.checked_sub(step)),
                (Some(from + step), Some(to + step)),
            ];
            for (start, end) in spans {
                let Some((start, end)) = start.zip(end) else {
                    continue;
                };
                if start < end && end <= n && (start..end).all(free) {
                    steps.insert(Edit {
                        device,
                        from,
                        to,
                        start,
                        end,
                    });
                }
            }
            step *= 2;
        }
        edits.extend(steps.iter().copied());
        edits.sort_unstable();
        edits.dedup();
        let mut edits: Vec<(f64, Edit)> = edits
            .into_iter()
            .filter(|e| e.start != from || e.end != to)
            .map(|e| (estimate.gain(&e), e))
            .collect();
        edits.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        // Distinct durations and days come before near-duplicate starts: after
        // the steps, an edit's rank is its place among those of its source
        // and destination.
        let mut seen = std::collections::BTreeMap::<Destination, usize>::new();
        for (gain, edit) in edits {
            if steps.contains(&edit) {
                ranked.push((0, gain, edit));
                continue;
            }
            let rank = seen.entry(edit.destination()).or_insert(1);
            ranked.push((*rank, gain, edit));
            *rank += 1;
        }
    }
    // Every run's steps first, then the likeliest edit of every source and
    // destination, then the next of each: no run or device takes every trial.
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.total_cmp(&a.1)).then(a.2.cmp(&b.2)));
    // Charge the additional copy, economic ordering and shortlist traversal.
    let ordering = ranked.len() as u64 * (ranked.len().max(1).ilog2() as u64 + 2) * 2;
    if !work.spend(ordering) {
        return None;
    }
    let mut joint = ranked.clone();
    joint.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.2.cmp(&b.2)));
    let mut seen = BTreeSet::new();
    let mut per_device = [0; 2];
    let coordinated = joint
        .into_iter()
        .filter_map(|(_, _, edit)| {
            let k = if edit.device == Device::Pool { 0 } else { 1 };
            if per_device[k] >= 2
                || !seen.insert((edit.device, edit.from, edit.to, edit.destination()))
            {
                return None;
            }
            per_device[k] += 1;
            Some(edit)
        })
        .collect();
    Some(Proposals {
        singles: ranked.into_iter().map(|(_, _, edit)| edit).collect(),
        coordinated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_estimate_counts_the_bill_of_what_moves_and_nothing_for_what_stays() {
        let mut p = crate::witnesses::tests::problem(12);
        p.rules.clear();
        for (i, slot) in p.slots.iter_mut().enumerate() {
            slot.import_price = if i < 4 { 0.5 } else { 2.0 };
        }
        // Three kilowatts of sun in one quarter, sold for 0.20.
        p.slots[6].solar_w = 3000.0;
        p.slots[6].export_price = 0.2;
        let mut commands = vec![
            Command {
                pool_on: false,
                ev_amps: 0,
                battery: Operation::Idle,
                charge_limit_w: 0.0,
                discharge_limit_w: 0.0,
            };
            12
        ];
        commands[9].pool_on = true;
        let mut work = Work {
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
        };
        let q = physics::projection(&p, &commands).unwrap();
        let estimate = Estimate::new(&p, Device::Pool, 3000.0, &q);
        let gain = |start, end| {
            estimate.gain(&Edit {
                device: Device::Pool,
                from: 9,
                to: 10,
                start,
                end,
            })
        };
        // 0.75 kWh bought at 2.00: at 0.50 instead, or on sun worth 0.20.
        assert!((gain(1, 2) - 1.125).abs() < 1e-9);
        assert!((gain(6, 7) - 1.35).abs() < 1e-9);
        // A quarter as dear changes nothing; a second one costs what it buys,
        // the first staying where it is.
        assert!(gain(10, 11).abs() < 1e-9);
        assert!((gain(9, 11) + 1.5).abs() < 1e-9);
        // The steps come first, a shift of eight quarters onto cheap power
        // ahead of the others; then the rest by what they should gain.
        let edits = proposals(&p, &commands, &q, &mut work).unwrap().singles;
        let at = |start, end| {
            edits
                .iter()
                .position(|e| (e.start, e.end) == (start, end))
                .unwrap()
        };
        assert_eq!(at(1, 2), 0);
        assert!(at(5, 6) < at(6, 7) && at(6, 7) < at(0, 1) && at(0, 1) < at(4, 5));
    }
    #[test]
    fn compound_edit_changes_only_its_device_and_keeps_the_original_setting() {
        let base: Vec<_> = (0..8)
            .map(|i| Command {
                pool_on: i == 6,
                ev_amps: 7,
                battery: Operation::Hold,
                charge_limit_w: 1000.0,
                discharge_limit_w: 2000.0,
            })
            .collect();
        let edited = Edit {
            device: Device::Pool,
            from: 6,
            to: 7,
            start: 2,
            end: 4,
        }
        .apply(&base);
        assert!(edited[2].pool_on && edited[3].pool_on && !edited[6].pool_on);
        for (a, b) in edited.iter().zip(&base) {
            assert_eq!(a.ev_amps, b.ev_amps);
            assert_eq!(a.battery, b.battery);
            assert_eq!(a.charge_limit_w, b.charge_limit_w);
        }
        let ev = Edit {
            device: Device::Ev,
            from: 6,
            to: 8,
            start: 2,
            end: 5,
        }
        .apply(&base);
        assert_eq!(ev[6].ev_amps, 0);
        assert_eq!(ev[2].ev_amps, 7);
        assert_eq!(ev[6].pool_on, base[6].pool_on);
    }
    #[test]
    fn terminal_credit_ordering_stops_at_the_store_cap_and_debits_below_it() {
        let mut p = crate::witnesses::tests::problem(12);
        p.rules.clear();
        p.end_credit.reference_sek_per_kwh = 2.0;
        p.end_credit.ev = Some(StoreTerm {
            cap: 10.5,
            grid_kwh_per_unit: 1.0,
        });
        let mut commands = vec![
            Command {
                pool_on: false,
                ev_amps: 0,
                battery: Operation::Idle,
                charge_limit_w: 0.0,
                discharge_limit_w: 0.0,
            };
            12
        ];
        commands[9].ev_amps = 6;
        let q = physics::projection(&p, &commands).unwrap();
        let estimate = Estimate::new(&p, Device::Ev, 1380.0, &q);
        let edit = Edit {
            device: Device::Ev,
            from: 9,
            to: 10,
            start: 9,
            end: 12,
        };
        // The extra 0.69 kWh costs 0.69 kr but only 0.155 kWh fits below the cap.
        assert!((estimate.gain(&edit) - (-0.69 + 0.155 * 2.0)).abs() < 1e-9);
        p.end_credit.ev.as_mut().unwrap().cap = 10.2;
        let estimate = Estimate::new(&p, Device::Ev, 1380.0, &q);
        assert!((estimate.gain(&edit) + 0.69).abs() < 1e-9);
    }
    #[test]
    fn a_cheaper_single_quarter_can_receive_the_tail_of_a_long_ev_run() {
        let mut p = crate::witnesses::tests::problem(12);
        p.rules.clear();
        p.slots[2].import_price = 0.1;
        let mut commands = vec![
            Command {
                pool_on: false,
                ev_amps: 0,
                battery: Operation::Idle,
                charge_limit_w: 0.0,
                discharge_limit_w: 0.0,
            };
            12
        ];
        for c in &mut commands[6..10] {
            c.ev_amps = 6;
        }
        let q = physics::projection(&p, &commands).unwrap();
        let mut work = Work {
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
        };
        let edit = proposals(&p, &commands, &q, &mut work)
            .unwrap()
            .singles
            .into_iter()
            .find(|e| {
                e.device == Device::Ev && e.from == 9 && e.to == 10 && e.start == 2 && e.end == 3
            })
            .unwrap();
        let after = physics::projection(&p, &edit.apply(&commands)).unwrap();
        assert_eq!(q.last().unwrap().ev_kwh, after.last().unwrap().ev_kwh);
        assert!(after.iter().map(|q| q.cost).sum::<f64>() < q.iter().map(|q| q.cost).sum::<f64>());
        assert_eq!(edit.apply(&commands)[6..9], commands[6..9]);
    }
}
