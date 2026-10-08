//! Point policy for a first observed warm episode and its modeled future need.
use crate::{physics::projected_hours, *};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Episode {
    Available,
    Active(Need),
    Spent,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Cause {
    HighPrices,
    LowSummerSolar,
    Both,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Need {
    pub quarter: usize,
    pub event: usize,
    pub cause: Cause,
}
#[derive(Clone)]
pub(crate) struct Credit {
    pub episode: Episode,
    claimed: Vec<bool>,
}
impl Credit {
    pub fn new(quarters: usize) -> Self {
        Self {
            episode: Episode::Available,
            claimed: vec![false; quarters.div_ceil(96)],
        }
    }
    pub fn available(&self, need: Option<Need>) -> bool {
        self.episode == Episode::Available && need.is_some_and(|n| !self.claimed[n.event])
    }
}
pub(crate) struct Evidence {
    pub causes: Vec<Option<Need>>,
    pub best: Vec<f64>,
}

/// The first episode observed in this plan owns its event; renewal cannot reuse it.
pub(crate) fn advance(
    credit: &mut Credit,
    start: Option<HeaterStart>,
    cycle_seconds: f64,
    i: usize,
    warm: bool,
    month: u8,
    need: Option<Need>,
) -> bool {
    if let Some(off) = start.and_then(|s| s.off_seconds) {
        if off >= cycle_seconds {
            credit.episode = Episode::Available;
        } else if matches!(credit.episode, Episode::Active(_)) {
            credit.episode = Episode::Spent;
        }
    }
    if credit.episode == Episode::Available && warm && credit.available(need) {
        let need = need.unwrap();
        credit.claimed[need.event] = true;
        credit.episode = Episode::Active(need);
    }
    if let Episode::Active(event) = credit.episode {
        let supported = event.cause != Cause::LowSummerSolar || (5..=9).contains(&month);
        if warm && supported && i <= event.quarter {
            return true;
        }
        credit.episode = Episode::Spent;
    }
    false
}

pub(crate) fn prepare(p: &Problem, work: &mut Work) -> Result<Evidence, String> {
    let n = p.slots.len();
    let mut causes = vec![None; n];
    if let Some(store) = p.pool_store.as_ref() {
        let target = p.targets.pool_c.unwrap();
        let trigger = target - p.service_guard.pool[0];
        // Preserve the existing full, horizon-relative 24-hour comparison blocks.
        let days: Vec<(f64, f64)> = p
            .slots
            .chunks(96)
            .map(|slots| {
                let hours: f64 = slots.iter().map(projected_hours).sum();
                let price = slots
                    .iter()
                    .map(|s| crate::policy::measured(s.import_price, 10000.0) * projected_hours(s))
                    .sum::<f64>()
                    / hours;
                let solar = slots
                    .iter()
                    .map(|s| s.solar_w * projected_hours(s) / 1000.0)
                    .sum();
                (price, solar)
            })
            .collect();
        for (i, cause) in causes.iter_mut().enumerate() {
            let mut water = target;
            for j in i + 1..n {
                if !work.spend(work.unit_cost) {
                    return Err("work_grant_cannot_prepare_buffer".into());
                }
                let slot = &p.slots[j];
                water = store.step(water, 0.0, slot.outdoor_c, projected_hours(slot));
                if water >= trigger {
                    continue;
                }
                let today = i / 96;
                let future = j / 96;
                if future > today && (future + 1) * 96 <= n {
                    let high = days[future].0 > days[today].0 * 1.1;
                    let solar = (5..=9).contains(&p.slots[i].local_month)
                        && (5..=9).contains(&slot.local_month)
                        && days[future].1 < days[today].1 * 0.9;
                    let reason = match (high, solar) {
                        (true, true) => Some(Cause::Both),
                        (true, false) => Some(Cause::HighPrices),
                        (false, true) => Some(Cause::LowSummerSolar),
                        _ => None,
                    };
                    *cause = reason.map(|cause| Need {
                        quarter: j,
                        event: future,
                        cause,
                    });
                }
                break;
            }
        }
    }
    let best = causes
        .iter()
        .enumerate()
        .map(|(i, need)| {
            need.map_or(0.0, |event| {
                (i..=event.quarter)
                    .take_while(|j| {
                        event.cause != Cause::LowSummerSolar
                            || (5..=9).contains(&p.slots[*j].local_month)
                    })
                    .count() as f64
            })
        })
        .collect();
    Ok(Evidence { causes, best })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn need(event: usize) -> Option<Need> {
        Some(Need {
            quarter: 200,
            event,
            cause: Cause::HighPrices,
        })
    }
    #[test]
    fn first_run_coasts_but_restarts_cannot_repeat_an_event() {
        let mut c = Credit::new(288);
        assert!(advance(&mut c, None, 43200.0, 0, true, 7, need(1)));
        assert!(advance(&mut c, None, 43200.0, 1, true, 7, need(2))); // event stays 1
        assert!(!advance(
            &mut c,
            Some(HeaterStart {
                off_seconds: Some(43199.0)
            }),
            43200.0,
            2,
            true,
            7,
            need(1)
        ));
        assert!(!advance(
            &mut c,
            Some(HeaterStart {
                off_seconds: Some(43200.0)
            }),
            43200.0,
            3,
            true,
            7,
            need(1)
        ));
        assert!(advance(&mut c, None, 43200.0, 4, true, 7, need(2)));
        assert!(!advance(&mut c, None, 43200.0, 5, false, 7, need(2)));
        assert!(!advance(&mut c, None, 43200.0, 6, true, 7, need(2)));
    }
    #[test]
    fn unknown_stop_does_not_restore_spent_credit() {
        let mut c = Credit::new(288);
        c.episode = Episode::Spent;
        assert!(!advance(
            &mut c,
            Some(HeaterStart { off_seconds: None }),
            43200.0,
            0,
            true,
            7,
            need(1)
        ));
    }
}
