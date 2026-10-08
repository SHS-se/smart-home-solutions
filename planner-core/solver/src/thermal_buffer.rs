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
    pub water_c: f64,
}
impl Credit {
    pub fn new(quarters: usize, water_c: f64) -> Self {
        Self {
            episode: Episode::Available,
            water_c,
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

pub(crate) struct Warmth {
    pub warm: bool,
    pub heating_past_target: bool,
    pub month: u8,
}

/// The first episode observed in this plan owns its event; renewal cannot reuse it.
pub(crate) fn advance(
    credit: &mut Credit,
    start: Option<HeaterStart>,
    cycle_seconds: f64,
    i: usize,
    state: Warmth,
    need: Option<Need>,
) -> bool {
    if let Some(off) = start.and_then(|s| s.off_seconds) {
        if off >= cycle_seconds {
            credit.episode = Episode::Available;
        } else if matches!(credit.episode, Episode::Active(_)) {
            credit.episode = Episode::Spent;
        }
    }
    // Reaching the reserve is allowed; continuing to heat after it is reached
    // spends this cycle's credit, rather than buying a longer paid episode.
    if state.heating_past_target {
        credit.episode = Episode::Spent;
    }
    if credit.episode == Episode::Available && state.warm && credit.available(need) {
        let need = need.unwrap();
        credit.claimed[need.event] = true;
        credit.episode = Episode::Active(need);
    }
    if let Episode::Active(event) = credit.episode {
        let supported = event.cause != Cause::LowSummerSolar || (5..=9).contains(&state.month);
        if state.warm && supported && i <= event.quarter {
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
    // Guidance values the natural coast after at most one crossing quarter,
    // never the entire interval in which continued heating could hold it warm.
    let mut best = vec![0.0; n];
    if let Some((store, heater)) = p.pool_store.as_ref().zip(p.heater.as_ref()) {
        if let Some(rule) = crate::policy::rule(p, RuleKey::PoolBuffer) {
            let cap = p.targets.pool_c.unwrap() + rule.threshold;
            for (i, need) in causes.iter().enumerate() {
                let Some(event) = need else { continue };
                let mut water = store.step(
                    cap,
                    heater.heat_w,
                    p.slots[i].outdoor_c,
                    projected_hours(&p.slots[i]),
                );
                for j in i..=event.quarter {
                    if !work.spend(work.unit_cost) {
                        return Err("work_grant_cannot_prepare_buffer".into());
                    }
                    if j > i {
                        water = store.step(
                            water,
                            0.0,
                            p.slots[j].outdoor_c,
                            projected_hours(&p.slots[j]),
                        );
                    }
                    if crate::policy::measured(water, 1000.0) <= cap
                        || event.cause == Cause::LowSummerSolar
                            && !(5..=9).contains(&p.slots[j].local_month)
                    {
                        break;
                    }
                    best[i] += 1.0;
                }
            }
        }
    }
    Ok(Evidence { causes, best })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn warm(warm: bool) -> Warmth {
        Warmth {
            warm,
            heating_past_target: false,
            month: 7,
        }
    }
    fn need(event: usize) -> Option<Need> {
        Some(Need {
            quarter: 200,
            event,
            cause: Cause::HighPrices,
        })
    }
    #[test]
    fn first_run_coasts_but_restarts_cannot_repeat_an_event() {
        let mut c = Credit::new(288, 30.5);
        assert!(advance(&mut c, None, 43200.0, 0, warm(true), need(1)));
        assert!(advance(&mut c, None, 43200.0, 1, warm(true), need(2))); // event stays 1
        assert!(!advance(
            &mut c,
            Some(HeaterStart {
                off_seconds: Some(43199.0)
            }),
            43200.0,
            2,
            warm(true),
            need(1)
        ));
        assert!(!advance(
            &mut c,
            Some(HeaterStart {
                off_seconds: Some(43200.0)
            }),
            43200.0,
            3,
            warm(true),
            need(1)
        ));
        assert!(advance(&mut c, None, 43200.0, 4, warm(true), need(2)));
        assert!(!advance(&mut c, None, 43200.0, 5, warm(false), need(2)));
        assert!(!advance(&mut c, None, 43200.0, 6, warm(true), need(2)));
    }
    #[test]
    fn unknown_stop_does_not_restore_spent_credit() {
        let mut c = Credit::new(288, 30.5);
        c.episode = Episode::Spent;
        assert!(!advance(
            &mut c,
            Some(HeaterStart { off_seconds: None }),
            43200.0,
            0,
            warm(true),
            need(1)
        ));
    }
    #[test]
    fn continued_heating_spends_the_episode_and_later_coasting_cannot_restore_it() {
        let mut c = Credit::new(288, 32.49);
        assert!(advance(&mut c, None, 43200.0, 0, warm(true), need(1)));
        assert!(advance(&mut c, None, 43200.0, 1, warm(true), need(1)));
        let mut heating = warm(true);
        heating.heating_past_target = true;
        assert!(!advance(&mut c, None, 43200.0, 2, heating, need(1)));
        assert!(!advance(&mut c, None, 43200.0, 3, warm(true), need(2)));
    }
}
