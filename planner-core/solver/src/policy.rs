/// A planned pool start costs 10 kr with its wear. The scheduling part falls by
/// 1 kr for each quarter the run lasts beyond four, to nothing at eleven, and
/// is charged when the run ends, so a run's length is known before it is paid.
const POOL_RUN_START_SEK: f64 = 7.0;
const POOL_RUN_FREE_QUARTERS: u32 = 4;
const POOL_RUN_SEK_PER_QUARTER: f64 = 1.0;
pub(crate) fn pool_run_charge(quarters: u32) -> f64 {
    (POOL_RUN_START_SEK
        - POOL_RUN_SEK_PER_QUARTER * f64::from(quarters.saturating_sub(POOL_RUN_FREE_QUARTERS)))
    .max(0.0)
}

use crate::physics::projected_hours;
use crate::*;

#[derive(Clone)]
pub(crate) struct FutureNeeds {
    pub pool_goal: f64,
    pub ev_goal: f64,
    pub next_cheaper: usize,
    pub refill_demand_kwh: f64,
}
pub(crate) struct Index {
    pub future: Vec<FutureNeeds>,
}
pub(crate) fn applicable(p: &Problem, key: RuleKey) -> bool {
    match key {
        RuleKey::PoolShortfall => p.heater.is_some(),
        RuleKey::CarFloor => p.car.is_some(),
    }
}
pub(crate) fn index(p: &Problem, work: &mut Work) -> Result<Index, String> {
    let n = p.slots.len();
    if !work.spend(n as u64 * work.unit_cost * 4 + (n * n) as u64 * 2) {
        return Err("work_grant_cannot_prepare".into());
    }
    // Where a quarter's charging should aim: the floor, and as high up the tiers
    // as this quarter's electricity costs less than the energy is worth.
    let ev_goal = |s: &Slot| {
        p.car_policy
            .as_ref()
            .filter(|_| s.ev_available)
            .map_or(0.0, |car| {
                p.end_credit
                    .ev
                    .iter()
                    .flat_map(|t| &t.tiers)
                    .filter(|tier| tier.sek_per_kwh > s.import_price)
                    .fold(car.floor_kwh, |goal, tier| goal.max(tier.up_to))
                    .min(car.limit_kwh)
            })
    };
    let mut future = vec![
        FutureNeeds {
            pool_goal: p.targets.pool_c.unwrap_or(0.0),
            ev_goal: 0.0,
            next_cheaper: n,
            refill_demand_kwh: 0.0,
        };
        n
    ];
    // Reverse opportunity sweep. Estimates guide construction, never add earned points.
    for i in (0..n).rev() {
        let s = &p.slots[i];
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
            pool_goal: p.targets.pool_c.unwrap_or(0.0),
            ev_goal: ev_goal(s),
            next_cheaper,
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
    Ok(Index { future })
}

/// A thousandth of a krona separates two plans; less is rounding.
pub(crate) const MIN_GAIN_SEK: f64 = 1e-3;
impl Account {
    /// The score from its parts, after any of them changed.
    pub(crate) fn rescore(&mut self) {
        self.score_sek =
            self.points - (self.cash_sek + self.wear_sek + self.continuity_sek - self.credit_sek);
    }
}
/// What the battery is credited for ending where it does.
pub(crate) fn battery_credit(p: &Problem, end_kwh: f64) -> f64 {
    store_credit(p, &p.end_credit.battery, p.initial.battery_kwh, end_kwh)
}
/// The level of a store that counts: no further than its cap.
fn counted(start: f64, end: f64, cap: f64) -> f64 {
    end.min(cap) - start.min(cap)
}
/// One store's end credit in kronor from the level it ends at.
pub(crate) fn store_credit(
    p: &Problem,
    term: &Option<StoreTerm>,
    start: Option<f64>,
    end: f64,
) -> f64 {
    term.as_ref().zip(start).map_or(0.0, |(t, start)| {
        p.end_credit.reference_sek_per_kwh * t.grid_kwh_per_unit * counted(start, end, t.cap)
    })
}
/// What the car is credited for ending at this level, tier by tier (end-credit.ts).
pub(crate) fn car_credit(p: &Problem, end_kwh: f64) -> f64 {
    p.end_credit
        .ev
        .as_ref()
        .zip(p.initial.ev_kwh)
        .map_or(0.0, |(t, start)| {
            let value = |kwh: f64| {
                let mut from = 0.0;
                t.tiers.iter().fold(0.0, |sum, tier| {
                    let part = tier.sek_per_kwh * (kwh.min(tier.up_to) - kwh.min(from));
                    from = tier.up_to;
                    sum + part
                })
            };
            (value(end_kwh) - value(start)) * t.grid_kwh_per_unit
        })
}
/// Total pool energy expressed in degrees; comfort continues to use water alone.
pub(crate) fn pool_inventory(p: &Problem, water_c: f64, pending_heat_kwh: f64) -> f64 {
    p.pool_store
        .as_ref()
        .map_or(water_c, |s| s.inventory_c(water_c, pending_heat_kwh))
}
pub(crate) fn initial_pool_inventory(p: &Problem) -> Option<f64> {
    p.initial
        .pool_c
        .map(|water| pool_inventory(p, water, p.initial.pool_pending_heat_kwh.unwrap_or(0.0)))
}
/// What the stores are credited for ending where they do (end-credit.ts).
pub(crate) fn end_credit(
    p: &Problem,
    battery_kwh: f64,
    pool_c: f64,
    pending_heat_kwh: f64,
    ev_kwh: f64,
) -> f64 {
    store_credit(p, &p.end_credit.battery, p.initial.battery_kwh, battery_kwh)
        + store_credit(
            p,
            &p.end_credit.pool,
            initial_pool_inventory(p),
            pool_inventory(p, pool_c, pending_heat_kwh),
        )
        + car_credit(p, ev_kwh)
}
/// A plan's account with every quarter's contributions: the selected plan's.
pub(crate) fn account(p: &Problem, q: &[Quarter]) -> Account {
    tally(p, q, true)
}
/// A plan's account without its rows, which a candidate in the search is never
/// asked for. The totals are the same.
pub(crate) fn totals(p: &Problem, q: &[Quarter], _index: &Index) -> Account {
    tally(p, q, false)
}
fn tally(p: &Problem, q: &[Quarter], rows: bool) -> Account {
    let mut before_c = p.initial.pool_c.unwrap_or(0.0);
    let mut contributions = Vec::with_capacity(if rows { q.len() } else { 0 });
    let mut total = 0.0;
    for (i, v) in q.iter().enumerate() {
        let points = p.rules.iter().map(|r| contribution(p, r, i, v, before_c));
        if rows {
            let points: Vec<_> = points.collect();
            total += points.iter().sum::<f64>();
            contributions.push(points);
        } else {
            total += points.sum::<f64>();
        }
        before_c = v.pool_c.unwrap_or(0.0);
    }
    let last = q.last();
    let mut account = Account {
        score_sek: 0.0,
        points: total,
        cash_sek: q.iter().map(|v| v.cost).sum(),
        wear_sek: q.iter().map(|v| v.wear).sum(),
        continuity_sek: q.iter().map(|v| v.continuity).sum(),
        credit_sek: last.map_or(0.0, |v| {
            end_credit(
                p,
                v.battery_kwh.unwrap_or(0.0),
                v.pool_c.unwrap_or(0.0),
                v.pool_pending_heat_kwh.unwrap_or(0.0),
                v.ev_kwh.unwrap_or(0.0),
            )
        }),
        contributions,
    };
    account.rescore();
    account
}

/// The car's charge in permille of its battery, at the precision the lines use.
pub(crate) fn soc_permille(car: &CarBattery, kwh: f64) -> i32 {
    (kwh / car.capacity_kwh * 1000.0 + 0.5).floor() as i32
}
/// Cost per hour of remaining below the charge target. The marginal cost of
/// another missing kWh is higher at low charge.
fn car_readiness_cost(p: &Problem, i: usize, kwh: f64) -> f64 {
    p.car
        .as_ref()
        .zip(p.car_policy.as_ref())
        .and_then(|(car, policy)| policy.breach_permille[i].map(|line| (car, line)))
        .map_or(0.0, |(car, line)| {
            let target = f64::from(line + 1) / 1000.0;
            let charge = kwh / car.capacity_kwh;
            if charge >= target {
                return 0.0;
            }
            let low_exposure = ((1.0 - charge).powi(5) - (1.0 - target).powi(5)) / 5.0;
            (0.02 * (target - charge) + 0.35 * low_exposure)
                * car.capacity_kwh / car.charge_efficiency
        })
}
/// Degree-hours below target − 1°C, integrating the linear water interpolation.
/// This quadrature convention is not an assertion about subquarter physics.
pub(crate) fn pool_exposure(target: f64, before: f64, after: f64, hours: f64) -> f64 {
    let a = target - before - 1.0;
    let b = target - after - 1.0;
    if a <= 0.0 && b <= 0.0 {
        return 0.0;
    }
    if a >= 0.0 && b >= 0.0 {
        return (a + b) / 2.0 * hours;
    }
    let positive = a.max(b);
    positive * (positive / (b - a).abs()) / 2.0 * hours
}
fn contribution(p: &Problem, r: &Rule, i: usize, v: &Quarter, before_c: f64) -> f64 {
    if !applicable(p, r.key) {
        return 0.0;
    }
    match r.key {
        RuleKey::PoolShortfall => {
            let exposure = pool_exposure(
                p.targets.pool_c.unwrap(),
                before_c,
                v.pool_c.unwrap(),
                projected_hours(&p.slots[i]),
            );
            if exposure > 0.0 {
                r.points * exposure
            } else {
                0.0
            }
        }
        RuleKey::CarFloor => {
            let cost = car_readiness_cost(p, i, v.ev_kwh.unwrap());
            if cost > 0.0 {
                r.points / 2.0 * cost * projected_hours(&p.slots[i])
            } else {
                0.0
            }
        }
    }
}
/// Guidance and complete accounts use the same fractional monetary policy.
pub(crate) fn guidance_quarter(
    p: &Problem,
    _index: &Index,
    i: usize,
    v: &Quarter,
    before_c: f64,
) -> f64 {
    p.rules
        .iter()
        .map(|r| contribution(p, r, i, v, before_c))
        .sum()
}

#[cfg(test)]
mod service_tests {
    use super::*;
    fn work(p: &Problem) -> Work {
        Work {
            used: 0,
            limit: p.work_grant,
            reserved: 0,
            unit_cost: 128,
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
    fn rules() -> Vec<Rule> {
        vec![
            Rule {
                key: RuleKey::PoolShortfall,
                threshold: 0.0,
                points: -2.0,
                required: false,
            },
            Rule {
                key: RuleKey::CarFloor,
                threshold: 0.0,
                points: -1.0,
                required: false,
            },
        ]
    }
    #[test]
    fn terminal_pool_credit_counts_initial_and_final_latent_energy_once() {
        let mut p = crate::witnesses::tests::problem(1);
        p.pool_store.as_mut().unwrap().capacity_kwh_per_c = 5.0;
        p.initial.pool_c = Some(29.0);
        p.initial.pool_pending_heat_kwh = Some(5.0);
        p.end_credit.reference_sek_per_kwh = 2.0;
        p.end_credit.battery = None;
        p.end_credit.ev = None;
        p.end_credit.pool = Some(StoreTerm {
            cap: 40.0,
            grid_kwh_per_unit: 2.0,
        });
        // The same energy appears progressively in water after shutdown.
        assert_eq!(end_credit(&p, 0.0, 29.5, 2.5, 0.0), 0.0);
        assert_eq!(end_credit(&p, 0.0, 30.0, 0.0, 0.0), 0.0);
        assert_eq!(end_credit(&p, 0.0, 30.0, 5.0, 0.0), 4.0);
        assert_eq!(end_credit(&p, 0.0, 31.0, 0.0, 0.0), 4.0);
    }

    #[test]
    fn pending_heat_does_not_earn_water_comfort_points() {
        let mut p = crate::witnesses::tests::problem(1);
        p.initial.pool_c = Some(27.0);
        p.initial.pool_pending_heat_kwh = Some(100.0);
        p.pool_store.as_mut().unwrap().response_time_constant_h = 1000.0;
        p.rules = rules();
        let index = index(&p, &mut work(&p)).unwrap();
        let commands = vec![Command {
            pool_on: false,
            ev_amps: 0,
            battery: Operation::Idle,
            charge_limit_w: 0.0,
            discharge_limit_w: 0.0,
        }];
        let mut q = physics::projection(&p, &commands).unwrap();
        q[0].pool_c = Some(27.0);
        q[0].pool_pending_heat_kwh = Some(100.0);
        let a = guidance_quarter(&p, &index, 0, &q[0], 27.0);
        q[0].pool_pending_heat_kwh = Some(0.0);
        assert_eq!(a, guidance_quarter(&p, &index, 0, &q[0], 27.0));
    }

    #[test]
    fn pool_and_car_keep_distinct_fractional_contributions() {
        let mut p = crate::witnesses::tests::problem(1);
        p.rules = rules();
        p.initial.ev_kwh = Some(40.0);
        p.car_policy.as_mut().unwrap().breach_permille = vec![Some(399)];
        let idle = Command {
            pool_on: false,
            ev_amps: 0,
            battery: Operation::Idle,
            charge_limit_w: 0.0,
            discharge_limit_w: 0.0,
        };
        let mut q = physics::projection(&p, &[idle]).unwrap();
        p.initial.pool_c = Some(27.0);
        q[0].pool_c = Some(27.0);
        q[0].ev_kwh = Some(19.0);
        let car = account(&p, &q).contributions[0][1];
        assert!(car < 0.0 && car > -1.0);
        assert_eq!(account(&p, &q).contributions[0], [-1.0, car]);
        q[0].pool_c = Some(33.0);
        q[0].pool_w = 3000.0;
        p.initial.pool_c = Some(33.0);
        assert_eq!(account(&p, &q).contributions[0], [0.0, car]);
    }
    #[test]
    fn readiness_cost_decreases_as_charge_approaches_the_target() {
        let mut p = crate::witnesses::tests::problem(3);
        p.car_policy.as_mut().unwrap().breach_permille = vec![None, Some(250), Some(299)];
        // 60 kWh battery: 15 kWh is 250 permille.
        assert_eq!(car_readiness_cost(&p, 0, 0.0), 0.0);
        assert!(car_readiness_cost(&p, 1, 15.0) > 0.0);
        assert_eq!(car_readiness_cost(&p, 1, 15.06), 0.0);
        assert!(car_readiness_cost(&p, 2, 12.0) > car_readiness_cost(&p, 2, 17.9));
        assert!(car_readiness_cost(&p, 2, 17.9) > 0.0);
        assert_eq!(car_readiness_cost(&p, 2, 18.0), 0.0);
        assert_eq!(soc_permille(p.car.as_ref().unwrap(), 15.03), 251);
    }
    #[test]
    fn car_credit_prices_each_tier_and_nothing_above_the_limit() {
        let mut p = crate::witnesses::tests::problem(1);
        p.initial.ev_kwh = Some(10.0);
        p.end_credit.ev = Some(CarTerm {
            grid_kwh_per_unit: 2.0,
            tiers: vec![
                CarTier {
                    up_to: 30.0,
                    sek_per_kwh: 3.0,
                },
                CarTier {
                    up_to: 48.0,
                    sek_per_kwh: 1.0,
                },
            ],
        });
        assert_eq!(car_credit(&p, 10.0), 0.0);
        assert_eq!(car_credit(&p, 20.0), 60.0);
        assert_eq!(car_credit(&p, 40.0), 140.0);
        assert_eq!(car_credit(&p, 48.0), 156.0);
        assert_eq!(car_credit(&p, 60.0), 156.0);
        assert_eq!(car_credit(&p, 5.0), -30.0);
        p.initial.ev_kwh = Some(55.0);
        assert_eq!(car_credit(&p, 50.0), 0.0);
    }
    #[test]
    fn quarters_aim_at_the_floor_and_only_as_high_as_the_tiers_pay() {
        let mut p = crate::witnesses::tests::problem(3);
        p.car_policy.as_mut().unwrap().floor_kwh = 18.0;
        p.car_policy.as_mut().unwrap().limit_kwh = 48.0;
        p.end_credit.ev = Some(CarTerm {
            grid_kwh_per_unit: 1.0,
            tiers: vec![
                CarTier {
                    up_to: 33.0,
                    sek_per_kwh: 3.0,
                },
                CarTier {
                    up_to: 48.0,
                    sek_per_kwh: 2.0,
                },
            ],
        });
        for (s, price) in p.slots.iter_mut().zip([4.0, 2.5, 1.0]) {
            s.import_price = price;
            s.solar_w = 0.0;
            s.base_w = 500.0;
        }
        let index = index(&p, &mut work(&p)).unwrap();
        let goals: Vec<f64> = index.future.iter().map(|f| f.ev_goal).collect();
        assert_eq!(goals, [18.0, 33.0, 48.0]);
    }
    #[test]
    fn cold_initial_water_is_valid_and_has_continuous_exposure() {
        let mut p = crate::witnesses::tests::problem(1);
        p.rules = rules();
        p.initial.pool_c = Some(0.0);
        assert!(crate::validate(&p).is_ok());
        assert_eq!(pool_exposure(30.0, 0.0, 0.0, 0.25), 7.25);
    }
    #[test]
    fn pool_linear_shortfall_integrates_free_band_crossings_and_partial_intervals() {
        assert_eq!(pool_exposure(30.0, 29.5, 29.5, 1.0), 0.0);
        assert_eq!(pool_exposure(30.0, 29.0, 29.0, 1.0), 0.0);
        assert_eq!(pool_exposure(30.0, 28.0, 28.0, 1.0), 1.0);
        assert_eq!(pool_exposure(30.0, 27.5, 27.5, 1.0), 1.5);
        assert_eq!(pool_exposure(30.0, 20.0, 20.0, 1.0), 9.0);
        assert!((pool_exposure(30.0, 31.0, 27.0, 1.0) - 0.5).abs() < 1e-12);
        assert!((pool_exposure(30.0, 27.0, 31.0, 1.0) - 0.5).abs() < 1e-12);
        assert!((pool_exposure(30.0, 29.0, 27.0, 0.1) - 0.1).abs() < 1e-12);
    }
}
