use crate::physics::projected_hours;
use crate::*;

#[derive(Clone)]
pub(crate) struct FutureNeeds {
    pub pool_goal: f64,
    pub ev_goal: f64,
    pub buffer_quarters: f64,
    pub next_cheaper: usize,
    pub demand_kwh: f64,
    pub refill_demand_kwh: f64,
}
pub(crate) struct Index {
    pub due: [usize; 4],
    pub cheap: Vec<f64>,
    pub dear: Vec<f64>,
    pub buffer: Vec<Option<bool>>,
    pub thermal_buffer: thermal_buffer::Evidence,
    pub future: Vec<FutureNeeds>,
    pub first_sale: Option<usize>,
}
pub(crate) fn applicable(p: &Problem, key: RuleKey) -> bool {
    use RuleKey::*;
    match key {
        PoolLow | PoolCold | PoolHot | PoolBuffer | PoolRestart | PoolShortGap => {
            p.heater.is_some()
        }
        EvLow | EvShort | EvShortGap => p.car.is_some(),
        BaseLoadDearImport | BaseLoadDearestImport | ArbitrageNotFull => p.battery.is_some(),
        EvFromHomeBattery => p.car.is_some() && p.battery.is_some(),
        _ => true,
    }
}
pub(crate) fn rule(p: &Problem, key: RuleKey) -> Option<&Rule> {
    p.rules.iter().find(|r| r.key == key && applicable(p, key))
}
/// Forecast incentive only: actual draw, source attribution and overheating
/// still decide whether the projected quarter earns this reward.
pub(crate) fn cheap_load_incentive(p: &Problem, index: &Index, i: usize) -> i32 {
    let fires = |r: &Rule| {
        matches!(r.key, RuleKey::CheapBuy | RuleKey::CheapestBuy) && index.cheap[i] < r.threshold
    };
    let fired: Vec<_> = p.rules.iter().map(fires).collect();
    contributions(&p.rules, &fired).iter().sum()
}
/// How far a cheap share may stretch along a valley: 25 % reaches 30 %.
/// The bench referee applies the same stretch (`VALLEY_SHARE_STRETCH`, score.ts).
pub(crate) const VALLEY_SHARE_STRETCH: f64 = 1.2;
/// Cheap ranks with every valley widened. Prices come in waves, and a fixed
/// share cuts through them: quarters a hair over the line split one valley into
/// runs too short to use. For any share, a quarter counts when an unbroken run
/// of quarters, each within `VALLEY_SHARE_STRETCH` times the share, joins it to
/// a quarter in the share. The returned rank is the share a quarter counts
/// from, so it holds for every threshold. A quarter beyond the stretch ends the
/// valley, and a quarter within it that touches no valley gains nothing.
pub(crate) fn valley_ranks(prices: &[f64]) -> Vec<f64> {
    let n = prices.len();
    let rank: Vec<f64> = prices
        .iter()
        .map(|v| prices.iter().filter(|a| *a < v).count() as f64 / n as f64)
        .collect();
    // The lowest share with a quarter in it on that side and nothing beyond
    // its stretch in between.
    let mut left = vec![f64::INFINITY; n];
    let mut right = vec![f64::INFINITY; n];
    for i in 1..n {
        left[i] = rank[i - 1].min(left[i - 1].max(rank[i - 1] / VALLEY_SHARE_STRETCH));
        let j = n - 1 - i;
        right[j] = rank[j + 1].min(right[j + 1].max(rank[j + 1] / VALLEY_SHARE_STRETCH));
    }
    (0..n)
        .map(|i| rank[i].min((rank[i] / VALLEY_SHARE_STRETCH).max(left[i].min(right[i]))))
        .collect()
}
pub(crate) fn index(p: &Problem, work: &mut Work) -> Result<Index, String> {
    let n = p.slots.len();
    if !work.spend(n as u64 * work.unit_cost * 4 + (n * n) as u64 * 2) {
        return Err("work_grant_cannot_prepare".into());
    }
    let prices: Vec<f64> = p
        .slots
        .iter()
        .map(|s| measured(s.import_price, 10000.0))
        .collect();
    let cheap = valley_ranks(&prices);
    let dear = prices
        .iter()
        .map(|v| prices.iter().filter(|a| *a > v).count() as f64 / n as f64)
        .collect();
    let mean = |from: usize, to: usize, solar: bool| {
        p.slots[from..to]
            .iter()
            .map(|s| {
                if solar {
                    s.solar_w
                } else {
                    measured(s.import_price, 10000.0)
                }
            })
            .sum::<f64>()
            / (to - from) as f64
    };
    let buffer: Vec<Option<bool>> = (0..n)
        .map(|i| {
            let d = i / 96 * 96;
            let next = d + 96;
            (next + 96 <= n).then(|| {
                mean(next, next + 96, false) > mean(d, next, false) * 1.1
                    || mean(next, next + 96, true) < mean(d, next, true) * 0.9
            })
        })
        .collect();
    let first_sale = rule(p, RuleKey::ArbitrageNotFull).and_then(|r| {
        p.slots
            .iter()
            .position(|s| measured(s.export_price, 10000.0) > r.threshold)
    });
    let thermal_buffer = thermal_buffer::prepare(p, work)?;
    let due = eligibility(p);
    let ev_goal = p.car.as_ref().map_or(0.0, |car| {
        (p.targets.ev_km.unwrap() * car.kwh_per_km).min(p.targets.ev_limit_kwh.unwrap())
    });
    let mut future = vec![
        FutureNeeds {
            pool_goal: p.targets.pool_c.unwrap_or(0.0),
            ev_goal,
            buffer_quarters: 0.0,
            next_cheaper: n,
            demand_kwh: 0.0,
            refill_demand_kwh: 0.0,
        };
        n
    ];
    let mut demand = 0.0_f64;
    // Reverse opportunity sweep. Estimates guide construction, never add earned points.
    for i in (0..n).rev() {
        let s = &p.slots[i];
        let h = projected_hours(s);
        let buffer_rule = rule(p, RuleKey::PoolBuffer).filter(|r| r.points > 0);
        let goal = if thermal_buffer.causes[i].is_some() {
            buffer_rule.map_or(p.targets.pool_c.unwrap_or(0.0), |r| {
                p.targets.pool_c.unwrap_or(0.0) + r.threshold
            })
        } else {
            p.targets.pool_c.unwrap_or(0.0)
        };
        let heat_load =
            p.pool_store
                .as_ref()
                .zip(p.heater.as_ref())
                .map_or(0.0, |(store, heater)| {
                    (-store.idle_per_hour(goal, s.outdoor_c)).max(0.0)
                        * store.capacity_kwh_per_c
                        * 1000.0
                        / heater.heat_w
                        * (heater.compressor_w + heater.auxiliary_w)
                });
        demand += (s.base_w + heat_load - s.solar_w).max(0.0) * h / 1000.0;
        let next_cheaper = (i + 1..n)
            .find(|j| {
                p.slots[*j].import_price < s.import_price
                    || p.slots[*j].solar_w
                        > p.slots[*j].base_w
                            + p.heater
                                .as_ref()
                                .map_or(0.0, |h| h.compressor_w + h.auxiliary_w)
            })
            .unwrap_or(n);
        future[i] = FutureNeeds {
            pool_goal: goal,
            ev_goal,
            buffer_quarters: thermal_buffer.best[i]
                * buffer_rule.map_or(0.0, |r| f64::from(r.points)),
            next_cheaper,
            demand_kwh: demand,
            refill_demand_kwh: 0.0,
        };
    }
    // Useful refill quantities stop at the next cheaper or solar opportunity.
    // Time-dependent inventory values belong to opportunity tables.
    for (i, f) in future.iter_mut().enumerate() {
        let end = (i + 1..n)
            .find(|&j| {
                p.slots[j].solar_w
                    > p.slots[j].base_w
                        + p.heater
                            .as_ref()
                            .map_or(0.0, |h| h.compressor_w + h.auxiliary_w)
                    || p.slots[j].import_price < p.slots[i].import_price
            })
            .unwrap_or(n);
        for j in i + 1..end {
            let s = &p.slots[j];
            let maintenance =
                p.pool_store
                    .as_ref()
                    .zip(p.heater.as_ref())
                    .map_or(0.0, |(store, heater)| {
                        (-store.idle_per_hour(f.pool_goal, s.outdoor_c)).max(0.0)
                            * store.capacity_kwh_per_c
                            * 1000.0
                            / heater.heat_w
                            * (heater.compressor_w + heater.auxiliary_w)
                    });
            let demand =
                (s.base_w + maintenance - s.solar_w).max(0.0) * projected_hours(s) / 1000.0;
            f.refill_demand_kwh += demand;
        }
    }
    Ok(Index {
        due,
        cheap,
        dear,
        buffer,
        thermal_buffer,
        future,
        first_sale,
    })
}

pub(crate) fn witnessed(
    p: &Problem,
    account: &mut Account,
    audit: &WitnessAudit,
    q: &[Quarter],
    index: &Index,
) {
    let prepared = prepared(p, q, index);
    let mut episode = thermal_buffer::Credit::new(p.slots.len(), p.initial.pool_c.unwrap_or(0.0));
    for (i, row) in account.contributions.iter_mut().enumerate() {
        let earns = buffer_credit(p, index, i, &q[i], &mut episode);
        let mut fired = raw_quarter(p, index, i, &q[i], prepared, earns);
        for (j, r) in p.rules.iter().enumerate() {
            match r.key {
                RuleKey::PoolShortGap => fired[j] = audit.gaps[i][0],
                RuleKey::EvShortGap => fired[j] = audit.gaps[i][1],
                RuleKey::LargeLoadOverlap => fired[j] = audit.overlap[i],
                _ => {}
            }
        }
        *row = contributions(&p.rules, &fired);
    }
    account.points = account.contributions.iter().flatten().sum::<i32>();
    let mut keys = std::collections::HashSet::new();
    for hit in audit.economic.iter().filter(|hit| hit.published) {
        for &i in &hit.quarters {
            keys.insert((hit.rule, i));
        }
    }
    account.points -= keys.len() as i32;
}
pub(crate) fn better(a: &Account, b: &Account) -> bool {
    a.points > b.points
        || a.points == b.points && a.cash_sek + a.wear_sek < b.cash_sek + b.wear_sek - 1e-9
}
pub(crate) fn eligibility(p: &Problem) -> [usize; 4] {
    let mut reach_pool = p.initial.pool_c.unwrap_or(0.0);
    let mut reach_ev = p.initial.ev_kwh.unwrap_or(0.0);
    let mut age = p
        .initial
        .heater_state
        .unwrap_or(HeaterState::OffUnobserved)
        .age();
    let thresholds = [
        p.service_guard.pool[0],
        p.service_guard.pool[1],
        p.service_guard.ev[0],
        p.service_guard.ev[1],
    ];
    let mut due = [usize::MAX; 4];
    for (k, threshold) in thresholds.iter().enumerate() {
        if k < 2 && p.heater.is_none() || k >= 2 && p.car.is_none() {
            continue;
        }
        let (start, target) = if k < 2 {
            (reach_pool, p.targets.pool_c.unwrap_or(0.0))
        } else {
            (
                p.car
                    .as_ref()
                    .map_or(0.0, |c| measured(reach_ev / c.kwh_per_km, 10.0)),
                p.targets.ev_km.unwrap_or(0.0),
            )
        };
        if start >= target - threshold {
            due[k] = 0;
        }
    }
    for (i, s) in p.slots.iter().enumerate() {
        let hours = projected_hours(s);
        if let Some((heater, store)) = p.heater.as_ref().zip(p.pool_store.as_ref()) {
            let state = match age {
                shs_planner_models::RunAge::Off => HeaterState::OffUnobserved,
                shs_planner_models::RunAge::Running { seconds } => HeaterState::Running { seconds },
                shs_planner_models::RunAge::Steady => HeaterState::Steady,
            };
            let step = heater.pool_transition(
                store,
                state,
                true,
                shs_planner_models::PoolConditions {
                    water_c: reach_pool,
                    outdoor_c: s.outdoor_c,
                    seconds: hours * 3600.0,
                    stop_c: p.pool_stop_c,
                },
            );
            age = step.next.age();
            reach_pool = step.water_c;
        }
        if let Some((car, charger)) = p.car.as_ref().zip(p.charger.as_ref()) {
            if s.ev_available {
                reach_ev = (reach_ev
                    + charger.watts(charger.max_current_a).unwrap() * hours / 1000.0
                        * car.charge_efficiency)
                    .min(
                        p.targets
                            .ev_limit_kwh
                            .unwrap()
                            .max(p.initial.ev_kwh.unwrap()),
                    );
            }
        }
        for (k, threshold) in thresholds.iter().enumerate() {
            if k < 2 && p.heater.is_none() || k >= 2 && p.car.is_none() {
                continue;
            }
            let (now, target) = if k < 2 {
                (measured(reach_pool, 100.0), p.targets.pool_c.unwrap_or(0.0))
            } else {
                (
                    p.car
                        .as_ref()
                        .map_or(0.0, |c| measured(reach_ev / c.kwh_per_km, 10.0)),
                    p.targets.ev_km.unwrap_or(0.0),
                )
            };
            if due[k] == usize::MAX && now >= target - threshold {
                due[k] = i + 96;
            }
        }
    }
    due
}

// Match the declared stored measurement precision, without rounding physics.
pub(crate) fn measured(value: f64, scale: f64) -> f64 {
    (value * scale + 0.5).floor() / scale
}
pub(crate) fn account(p: &Problem, q: &[Quarter], index: &Index) -> Account {
    let prepared = prepared(p, q, index);
    let mut episode = thermal_buffer::Credit::new(p.slots.len(), p.initial.pool_c.unwrap_or(0.0));
    let contributions: Vec<Vec<i32>> = q
        .iter()
        .enumerate()
        .map(|(i, v)| quarter(p, index, i, v, prepared, &mut episode))
        .collect();
    Account {
        points: contributions.iter().flatten().sum(),
        cash_sek: q.iter().map(|v| v.cost).sum(),
        wear_sek: q.iter().map(|v| v.wear).sum(),
        contributions,
    }
}

struct PoolScoring {
    earns_buffer: bool,
    before_c: f64,
}
fn buffer_credit(
    p: &Problem,
    index: &Index,
    i: usize,
    v: &Quarter,
    episode: &mut thermal_buffer::Credit,
) -> PoolScoring {
    let before_c = measured(episode.water_c, 1000.0);
    episode.water_c = v.pool_c.unwrap_or(0.0);
    let buffer = rule(p, RuleKey::PoolBuffer);
    let warm = buffer.is_some_and(|r| {
        measured(v.pool_c.unwrap_or(0.0), 1000.0) > p.targets.pool_c.unwrap_or(0.0) + r.threshold
    });
    let earns_buffer = thermal_buffer::advance(
        episode,
        v.pool_start,
        p.pool_cycle_seconds,
        i,
        thermal_buffer::Warmth {
            warm,
            heating_past_target: buffer
                .is_some_and(|r| before_c >= p.targets.pool_c.unwrap_or(0.0) + r.threshold)
                && (measured(v.pool_w, 10.0) > 0.0 || v.pool_start.is_some()),
            month: p.slots[i].local_month,
        },
        index.thermal_buffer.causes[i],
    );
    PoolScoring {
        earns_buffer,
        before_c,
    }
}
fn raw_quarter(
    p: &Problem,
    index: &Index,
    i: usize,
    v: &Quarter,
    prepared: bool,
    pool: PoolScoring,
) -> Vec<bool> {
    let s = &p.slots[i];
    let pool_w = measured(v.pool_w, 10.0);
    let ev_w = measured(v.ev_w, 10.0);
    let charge = measured(v.charge_w, 10.0);
    let discharge = measured(v.discharge_w, 10.0);
    let pool_c = measured(v.pool_c.unwrap_or(0.0), 1000.0);
    let ev_km = p
        .car
        .as_ref()
        .map_or(0.0, |c| measured(v.ev_kwh.unwrap() / c.kwh_per_km, 10.0));
    let soc = p.battery.as_ref().map_or(0.0, |b| {
        measured(v.battery_kwh.unwrap() / b.capacity_kwh * 100.0, 10.0)
    });
    let imported = measured(v.net_w.max(0.0), 10.0);
    let export = measured((-v.net_w).max(0.0), 10.0);
    let load = measured(s.base_w + v.pool_w + v.ev_w, 10.0);
    let flexible = pool_w + ev_w + charge;
    let heating = pool_w > 0.0 || v.pool_start.is_some();
    let past_hot_target = |t: f64| pool.before_c >= p.targets.pool_c.unwrap_or(0.0) + t;
    let rewarding_flexible = ev_w
        + charge
        + if rule(p, RuleKey::PoolHot).is_some_and(|r| past_hot_target(r.threshold)) {
            0.0
        } else {
            pool_w
        };
    let house_battery = (discharge - export).max(0.0);
    let flexible_grid = measured((flexible - house_battery).max(0.0).min(imported), 10.0);
    let base_grid = measured(
        (imported - flexible_grid)
            .max(0.0)
            .min((load - pool_w - ev_w).max(0.0)),
        10.0,
    );
    let ev_battery = measured(
        (house_battery - charge - (load - ev_w).max(0.0))
            .max(0.0)
            .min(ev_w),
        10.0,
    );
    let spare = (v.spare_battery_cover_w * 10.0).floor() / 10.0;
    let rule_fires = |r: &Rule| {
        use RuleKey::*;
        if !applicable(p, r.key) {
            return false;
        }
        let t = r.threshold;
        match r.key {
            PoolLow => i >= index.due[0] && pool_c < p.targets.pool_c.unwrap_or(0.0) - t,
            PoolCold => i >= index.due[1] && pool_c < p.targets.pool_c.unwrap_or(0.0) - t,
            PoolHot => {
                heating && past_hot_target(t)
                    || pool_c > p.targets.pool_c.unwrap_or(0.0) + t
                        && index.buffer[i] == Some(false)
            }
            PoolRestart => v
                .pool_start
                .is_some_and(|s| s.off_seconds.is_some_and(|off| off < t * 3600.0)),
            PoolBuffer => pool.earns_buffer,
            EvLow => i >= index.due[2] && ev_km < p.targets.ev_km.unwrap_or(0.0) - t,
            EvShort => i >= index.due[3] && ev_km < p.targets.ev_km.unwrap_or(0.0) - t,
            CheapBuy | CheapestBuy => rewarding_flexible >= 500.0 && index.cheap[i] < t,
            DearLoad | DearestLoad => flexible_grid >= 500.0 && index.dear[i] < t,
            BaseLoadDearImport | BaseLoadDearestImport => {
                base_grid >= 500.0 && spare >= base_grid && index.dear[i] < t
            }
            MissedCheapQuarter => {
                measured(s.import_price, 10000.0) < t
                    && (p.battery.is_some() && soc < 100.0
                        || p.car.is_some() && ev_km < p.targets.ev_km.unwrap_or(0.0)
                        || p.heater.is_some() && pool_c < p.targets.pool_c.unwrap_or(0.0))
                    && charge < 500.0
                    && ev_w < 500.0
                    && pool_w < 500.0
            }
            ArbitrageNoExport => measured(s.export_price, 10000.0) > t && export <= 0.0,
            ArbitrageNotFull => measured(s.export_price, 10000.0) > t && !prepared,
            EvFromHomeBattery => ev_battery > t,
            LargeLoadOverlap | PoolShortGap | EvShortGap => false,
        }
    };
    p.rules.iter().map(rule_fires).collect()
}
fn contributions(rules: &[Rule], fired: &[bool]) -> Vec<i32> {
    let active = |key| rules.iter().zip(fired).any(|(r, f)| r.key == key && *f);
    rules
        .iter()
        .zip(fired)
        .map(|(r, f)| {
            if *f && !r.unless.is_some_and(active) {
                r.points
            } else {
                0
            }
        })
        .collect()
}
/// Relaxed continuation tables share the actual rule predicates. Episode and
/// charge-history rules are excluded by the table owner, not approximated here.
pub(crate) fn guidance_quarter(
    p: &Problem,
    index: &Index,
    i: usize,
    v: &Quarter,
    before_c: f64,
) -> i32 {
    contributions(
        &p.rules,
        &raw_quarter(
            p,
            index,
            i,
            v,
            false,
            PoolScoring {
                earns_buffer: false,
                before_c: measured(before_c, 1000.0),
            },
        ),
    )
    .iter()
    .sum()
}
pub(crate) fn quarter(
    p: &Problem,
    index: &Index,
    i: usize,
    v: &Quarter,
    prepared: bool,
    episode: &mut thermal_buffer::Credit,
) -> Vec<i32> {
    let earns = buffer_credit(p, index, i, v, episode);
    contributions(&p.rules, &raw_quarter(p, index, i, v, prepared, earns))
}
fn prepared(p: &Problem, q: &[Quarter], index: &Index) -> bool {
    index.first_sale.is_some_and(|sale| {
        let soc = q[..sale]
            .iter()
            .rev()
            .find(|v| measured(v.charge_w, 10.0) > 0.0)
            .map_or(p.initial.battery_kwh.unwrap_or(0.0), |v| {
                v.battery_kwh.unwrap_or(0.0)
            });
        p.battery
            .as_ref()
            .is_some_and(|b| measured(soc / b.capacity_kwh * 100.0, 10.0) >= 100.0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserve_crossing_coasts_but_extra_heating_loses_both_buffer_and_cheap_credit() {
        let mut p = crate::witnesses::tests::problem(288);
        p.initial.pool_c = Some(31.99);
        p.heater.as_mut().unwrap().heat_w = 4000.0;
        p.pool_store.as_mut().unwrap().loss = shs_planner_models::StandingLoss::Measured {
            points: vec![shs_planner_models::LossPoint {
                at_c: 30.0,
                c_per_h: -0.04,
            }],
        };
        p.rules = [
            (RuleKey::PoolBuffer, 2.0, 1),
            (RuleKey::PoolHot, 2.0, -1),
            (RuleKey::CheapestBuy, 0.1, 2),
        ]
        .map(|(key, threshold, points)| Rule {
            key,
            threshold,
            points,
            required: false,
            unless: None,
        })
        .to_vec();
        for s in &mut p.slots[96..] {
            s.import_price = 2.0;
        }
        // The final day remains cheap: overheating cannot escape via missing next-day evidence.
        p.slots[287].import_price = 1.0;
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
        let index = index(&p, &mut work).unwrap();
        let off = Command {
            pool_on: false,
            ev_amps: 0,
            battery: Operation::Idle,
            charge_limit_w: 0.0,
            discharge_limit_w: 0.0,
        };
        let mut coast = vec![off.clone(); 288];
        coast[0].pool_on = true;
        let q = crate::physics::projection(&p, &coast).unwrap();
        let good = account(&p, &q, &index);
        assert_eq!(good.contributions.iter().map(|r| r[0]).sum::<i32>(), 8);
        assert_eq!(good.contributions[0], vec![1, 0, 2]);
        assert_eq!(good.contributions[1], vec![1, 0, 0]);
        let mut heat = vec![off; 288];
        for c in &mut heat {
            c.pool_on = true;
        }
        let q = crate::physics::projection(&p, &heat).unwrap();
        let bad = account(&p, &q, &index);
        assert_eq!(bad.contributions[0], vec![1, 0, 2]);
        assert_eq!(bad.contributions[1], vec![0, -1, 0]);
        assert_eq!(bad.contributions[287], vec![0, -1, 0]);
        assert!(good.points > bad.points);
        // A concurrent useful car load earns the ordinary household cheap reward.
        heat[287].ev_amps = 6;
        let q = crate::physics::projection(&p, &heat).unwrap();
        assert_eq!(account(&p, &q, &index).contributions[287], vec![0, -1, 2]);
    }
    #[test]
    fn cheap_ranks_widen_a_valley_within_the_share_stretch_only() {
        // Twenty quarters: the cheapest quarter of them is the five from 1.00 to
        // 1.04, and the stretch takes the sixth, 1.06, where it touches them.
        let mut prices = vec![1.07, 1.06, 1.00, 1.01, 3.00, 1.02, 1.03, 1.04, 1.07];
        prices.extend((0..11).map(|i| 2.0 + f64::from(i) / 100.0));
        let cheap: Vec<bool> = valley_ranks(&prices).iter().map(|r| *r < 0.25).collect();
        // 1.06 widens the valley at its start; the seventh cheapest (1.07), the
        // spike and everything dearer stay out.
        let expected = [0, 1, 1, 1, 0, 1, 1, 1, 0];
        assert_eq!(cheap[..9], expected.map(|v| v == 1));
        assert!(cheap[9..].iter().all(|v| !v));
        // The same sixth-cheapest price gains nothing where no valley touches it.
        let mut apart = vec![1.00, 1.01, 1.02, 1.03, 1.04, 3.00, 1.06];
        apart.extend((0..13).map(|i| 2.0 + f64::from(i) / 100.0));
        assert_eq!(valley_ranks(&apart)[6], 0.25);
        // A gap inside a valley closes too, and no rank ever rises.
        let mut gap = vec![1.00, 1.01, 1.06, 1.02, 1.03, 1.04];
        gap.extend((0..14).map(|i| 2.0 + f64::from(i) / 100.0));
        let ranks = valley_ranks(&gap);
        assert!(ranks[2] < 0.25);
        assert!(ranks.iter().zip(&gap).all(|(rank, price)| {
            *rank <= gap.iter().filter(|a| *a < price).count() as f64 / 20.0
        }));
    }
    #[test]
    fn exclusions_use_raw_firing_across_direct_and_witness_rules() {
        let rules = vec![
            Rule {
                key: RuleKey::PoolLow,
                threshold: 1.0,
                points: -1,
                required: false,
                unless: Some(RuleKey::PoolShortGap),
            },
            Rule {
                key: RuleKey::PoolShortGap,
                threshold: 0.2,
                points: -2,
                required: false,
                unless: None,
            },
        ];
        assert_eq!(contributions(&rules, &[true, true]), vec![0, -2]);
        assert_eq!(contributions(&rules, &[true, false]), vec![-1, 0]);
        assert_eq!(contributions(&rules, &[false, true]), vec![0, -2]);
    }
}
