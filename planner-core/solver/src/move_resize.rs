//! Local command-span proposals. Eligibility is physical projection, never a cash certificate.
use crate::{physics, policy, *};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Device {
    Pool,
    Ev,
    Battery,
}
impl Device {
    fn active(self, c: &Command) -> bool {
        match self {
            Self::Pool => c.pool_on,
            Self::Ev => c.ev_amps > 0,
            Self::Battery => c.battery == Operation::GridCharge,
        }
    }
    fn same(self, a: &Command, b: &Command) -> bool {
        match self {
            Self::Pool => a.pool_on == b.pool_on,
            Self::Ev => a.ev_amps == b.ev_amps,
            Self::Battery => {
                a.battery == b.battery
                    && a.charge_limit_w == b.charge_limit_w
                    && a.discharge_limit_w == b.discharge_limit_w
            }
        }
    }
    fn clear(self, c: &mut Command) {
        match self {
            Self::Pool => c.pool_on = false,
            Self::Ev => c.ev_amps = 0,
            Self::Battery => {
                c.battery = Operation::SelfConsumption;
            }
        }
    }
    fn copy(self, to: &mut Command, from: &Command) {
        match self {
            Self::Pool => to.pool_on = from.pool_on,
            Self::Ev => to.ev_amps = from.ev_amps,
            Self::Battery => {
                to.battery = from.battery;
                to.charge_limit_w = from.charge_limit_w;
                to.discharge_limit_w = from.discharge_limit_w;
            }
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

// Direct tariff rules order proposals only. Every retained alternative is fully scored.
fn tariff_points(p: &Problem, index: &policy::Index, i: usize, watts: f64) -> i32 {
    let fires = |r: &Rule| match r.key {
        RuleKey::CheapBuy | RuleKey::CheapestBuy => index.cheap_price(r, i),
        RuleKey::DearLoad | RuleKey::DearestLoad => {
            index.dear[i] < r.threshold && p.slots[i].solar_w < p.slots[i].base_w + watts
        }
        _ => false,
    };
    p.rules
        .iter()
        .filter(|r| {
            fires(r)
                && r.unless
                    .is_none_or(|key| !p.rules.iter().any(|other| other.key == key && fires(other)))
        })
        .map(|r| r.points)
        .sum()
}

pub(crate) fn proposals(
    p: &Problem,
    index: &policy::Index,
    commands: &[Command],
    work: &mut Work,
) -> Option<Vec<Edit>> {
    let n = commands.len();
    let mut sources = Vec::new();
    for device in [Device::Pool, Device::Ev, Device::Battery] {
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
            sources.push((device, from, i));
        }
    }
    sources.sort_by_key(|(device, from, to)| (to - from, *device, *from));
    let mut per_source = Vec::new();
    for (device, from, to) in sources {
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
            Device::Battery => c.charge_limit_w,
        };
        let points: Vec<i32> = (0..n).map(|i| tariff_points(p, index, i, watts)).collect();
        let mut prefix = vec![0; n + 1];
        for i in 0..n {
            prefix[i + 1] = prefix[i] + points[i];
        }
        let free = |i: usize| {
            !physics::locked(p, i) && (from <= i && i < to || !device.active(&commands[i]))
        };
        let length = to - from;
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
        let mut edits = BTreeSet::new();
        let mut start = 0;
        while start < n {
            if !free(start) {
                start += 1;
                continue;
            }
            let mut end = start + 1;
            while end < n && free(end) && points[end] == points[start] {
                end += 1;
            }
            for len in 1..=end - start {
                edits.insert(Edit {
                    device,
                    from,
                    to,
                    start,
                    end: start + len,
                });
                edits.insert(Edit {
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
                        edits.insert(Edit {
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
                            edits.insert(Edit {
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
        let mut edits: Vec<_> = edits
            .into_iter()
            .filter(|e| e.start != from || e.end != to)
            .collect();
        edits.sort_by(|a, b| {
            let score = |e: &Edit| prefix[e.end] - prefix[e.start] - (prefix[to] - prefix[from]);
            score(b).cmp(&score(a)).then(a.cmp(b))
        });
        // Preview distinct durations and days before near-duplicate starts.
        let mut groups = std::collections::BTreeMap::<Destination, Vec<Edit>>::new();
        for edit in edits {
            groups.entry(edit.destination()).or_default().push(edit);
        }
        let mut diverse = Vec::new();
        for rank in 0..groups.values().map(Vec::len).max().unwrap_or(0) {
            for group in groups.values() {
                if let Some(edit) = group.get(rank) {
                    diverse.push(*edit);
                }
            }
        }
        per_source.push(diverse);
    }
    // Round-robin sources so one device/run cannot consume every preview.
    let mut out = Vec::new();
    for rank in 0..per_source.iter().map(Vec::len).max().unwrap_or(0) {
        for edits in &per_source {
            if let Some(edit) = edits.get(rank) {
                out.push(*edit);
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let mut charging = base.clone();
        charging[6].battery = Operation::GridCharge;
        let battery = Edit {
            device: Device::Battery,
            from: 6,
            to: 7,
            start: 2,
            end: 4,
        }
        .apply(&charging);
        assert_eq!(battery[6].battery, Operation::SelfConsumption);
        assert_eq!(battery[2].battery, Operation::GridCharge);
        assert_eq!(battery[6].pool_on, charging[6].pool_on);
    }
}
