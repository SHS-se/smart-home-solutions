//! Energy-preserving EV permutations for coupled battery refinement.
//! Off-destination span moves cannot exchange two already-positive currents.
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
pub(crate) fn proposals(
    p: &Problem,
    commands: &[Command],
    work: &mut Work,
) -> Option<Vec<Packing>> {
    let n = commands.len();
    // Scan, two command copies and two native-current sorts.
    if !work.spend(n as u64 * (n.max(1).ilog2() as u64 + 8) * 4) {
        return None;
    }
    let eligible =
        |i: usize| !physics::locked(p, i) && p.slots[i].ev_available && commands[i].ev_amps > 0;
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
