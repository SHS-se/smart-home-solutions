use shs_planner_models::{Heater, HeaterState, PoolConditions, PoolTransition, ThermalStore};

const SETS: usize = 2048;
const WAYS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Key {
    water: u64,
    pending: u64,
    outdoor: u64,
    seconds: u64,
    stop: Option<u64>,
    age: u64,
    kind: u8,
    on: bool,
}
impl Key {
    fn new(state: HeaterState, on: bool, conditions: PoolConditions) -> Self {
        let PoolConditions {
            water_c,
            pending_heat_kwh,
            outdoor_c,
            seconds,
            stop_c,
        } = conditions;
        let (kind, age) = match state {
            HeaterState::OffUnobserved => (0, 0),
            HeaterState::Off { seconds } => (1, seconds.to_bits()),
            HeaterState::Running { seconds } => (2, seconds.to_bits()),
            HeaterState::Steady => (3, 0),
        };
        Self {
            water: water_c.to_bits(),
            pending: pending_heat_kwh.to_bits(),
            outdoor: outdoor_c.to_bits(),
            seconds: seconds.to_bits(),
            stop: stop_c.map(f64::to_bits),
            age,
            kind,
            on,
        }
    }
    fn set(self) -> usize {
        let mut hash = self.water
            ^ self.pending.rotate_left(31)
            ^ self.age.rotate_left(17)
            ^ self.outdoor.rotate_left(7)
            ^ self.seconds.rotate_left(43)
            ^ self.stop.unwrap_or(0).rotate_left(23)
            ^ u64::from(self.kind)
            ^ (u64::from(self.on) << 8);
        hash ^= hash >> 32;
        hash = hash.wrapping_mul(0xd6e8feb86659fd93);
        hash ^= hash >> 32;
        hash as usize & (SETS - 1)
    }
}
#[derive(Clone, Copy)]
struct Entry {
    key: Key,
    value: PoolTransition,
}
#[derive(Clone, Copy, Default)]
struct Set {
    entries: [Option<Entry>; WAYS],
    replace: usize,
}

/// One projector borrows immutable physical models. Exact conditions, rather
/// than slot identity, allow repeated intervals to share only the pure thermal
/// calculation; pricing, grid checks and declared search work remain separate.
/// Expanded keys retain the existing two-MiB allocation budget.
pub(super) struct PoolMemo<'p> {
    heater: &'p Heater,
    store: &'p ThermalStore,
    sets: Option<Box<[Set]>>,
    #[cfg(test)]
    hits: usize,
}
impl<'p> PoolMemo<'p> {
    pub(super) fn new(heater: &'p Heater, store: &'p ThermalStore) -> Self {
        Self {
            heater,
            store,
            sets: None,
            #[cfg(test)]
            hits: 0,
        }
    }
    #[cfg(test)]
    pub(super) fn hits(&self) -> usize {
        self.hits
    }
    pub(super) fn transition(
        &mut self,
        state: HeaterState,
        on: bool,
        conditions: PoolConditions,
    ) -> PoolTransition {
        // Disabled direct-response transitions are cheap. Delayed off states
        // still release reservoir heat, so they benefit from exact reuse too.
        if self.store.response_time_constant_h == 0.0
            && (!on
                || conditions
                    .stop_c
                    .is_some_and(|stop| conditions.water_c >= stop))
        {
            return self
                .heater
                .pool_transition(self.store, state, on, conditions);
        }
        let key = Key::new(state, on, conditions);
        let sets = self
            .sets
            .get_or_insert_with(|| vec![Set::default(); SETS].into_boxed_slice());
        let set = &mut sets[key.set()];
        for entry in set.entries.iter().flatten() {
            if entry.key == key {
                #[cfg(test)]
                {
                    self.hits += 1;
                }
                return entry.value;
            }
        }
        let value = self
            .heater
            .pool_transition(self.store, state, on, conditions);
        let position = set
            .entries
            .iter()
            .position(Option::is_none)
            .unwrap_or(set.replace);
        set.entries[position] = Some(Entry { key, value });
        set.replace = (position + 1) % WAYS;
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shs_planner_models::{Response, StandingLoss};

    fn models(tau: f64) -> (Heater, ThermalStore) {
        (
            Heater {
                compressor_w: 3000.0,
                auxiliary_w: 764.0,
                heat_w: 12000.0,
                response: Response::Steady,
            },
            ThermalStore {
                capacity_kwh_per_c: 5.0,
                response_time_constant_h: tau,
                loss: StandingLoss::Linear {
                    kw_per_c: 0.13,
                    surroundings_c: None,
                },
            },
        )
    }
    fn conditions() -> PoolConditions {
        PoolConditions {
            water_c: 30.0,
            pending_heat_kwh: 0.0,
            outdoor_c: 20.0,
            seconds: 900.0,
            stop_c: Some(30.1),
        }
    }
    fn exact(a: PoolTransition, b: PoolTransition) {
        for (a, b) in [
            (a.electric_w, b.electric_w),
            (a.compressor_w, b.compressor_w),
            (a.auxiliary_w, b.auxiliary_w),
            (a.heat_w, b.heat_w),
            (a.water_c, b.water_c),
            (a.pending_heat_kwh, b.pending_heat_kwh),
        ] {
            assert_eq!(a.to_bits(), b.to_bits());
        }
        assert_eq!(
            serde_json::to_value(a.next).unwrap(),
            serde_json::to_value(b.next).unwrap()
        );
        assert_eq!(
            serde_json::to_value(a.start).unwrap(),
            serde_json::to_value(b.start).unwrap()
        );
    }
    #[test]
    fn exact_keys_distinguish_every_physical_condition_and_signed_zero() {
        let c = conditions();
        let base = Key::new(HeaterState::Steady, true, c);
        for changed in [
            PoolConditions {
                water_c: f64::from_bits(c.water_c.to_bits() + 1),
                ..c
            },
            PoolConditions {
                pending_heat_kwh: -0.0,
                ..c
            },
            PoolConditions {
                outdoor_c: f64::from_bits(c.outdoor_c.to_bits() + 1),
                ..c
            },
            PoolConditions {
                seconds: 600.0,
                ..c
            },
            PoolConditions { stop_c: None, ..c },
            PoolConditions {
                stop_c: Some(f64::from_bits(c.stop_c.unwrap().to_bits() + 1)),
                ..c
            },
        ] {
            assert_ne!(base, Key::new(HeaterState::Steady, true, changed));
        }
        assert_ne!(base, Key::new(HeaterState::Steady, false, c));
        assert_ne!(
            Key::new(HeaterState::Off { seconds: 0.0 }, true, c),
            Key::new(HeaterState::Off { seconds: -0.0 }, true, c)
        );
        assert_ne!(
            Key::new(HeaterState::Off { seconds: 1.0 }, true, c),
            Key::new(HeaterState::Running { seconds: 1.0 }, true, c)
        );
        assert_ne!(
            Key::new(HeaterState::OffUnobserved, true, c),
            Key::new(HeaterState::Off { seconds: 0.0 }, true, c)
        );
        assert_ne!(
            Key::new(
                HeaterState::Steady,
                true,
                PoolConditions { water_c: 0.0, ..c }
            ),
            Key::new(
                HeaterState::Steady,
                true,
                PoolConditions { water_c: -0.0, ..c }
            )
        );
    }
    #[test]
    fn delayed_on_and_off_states_match_direct_and_models_are_isolated() {
        for tau in [0.0, 0.675, 2.0] {
            let (heater, store) = models(tau);
            let mut memo = PoolMemo::new(&heater, &store);
            for _ in 0..2 {
                for pending in [0.0, 5.0] {
                    for on in [false, true] {
                        let c = PoolConditions {
                            pending_heat_kwh: pending,
                            ..conditions()
                        };
                        exact(
                            memo.transition(HeaterState::Steady, on, c),
                            heater.pool_transition(&store, HeaterState::Steady, on, c),
                        );
                    }
                }
            }
            assert!(memo.hits() > 0);
        }
        let (heater, store) = models(2.0);
        let other = ThermalStore {
            capacity_kwh_per_c: 10.0,
            ..store.clone()
        };
        let mut a = PoolMemo::new(&heater, &store);
        let mut b = PoolMemo::new(&heater, &other);
        let first = a.transition(HeaterState::Steady, true, conditions());
        let changed = b.transition(HeaterState::Steady, true, conditions());
        assert_ne!(first.water_c, changed.water_c);
        exact(first, a.transition(HeaterState::Steady, true, conditions()));
    }
    #[test]
    fn collisions_eviction_and_exact_hits_keep_the_two_mib_bound() {
        let (heater, store) = models(2.0);
        let mut memo = PoolMemo::new(&heater, &store);
        let state = HeaterState::Off { seconds: -0.0 };
        let c = conditions();
        let bucket = Key::new(state, true, c).set();
        let colliding: Vec<_> = (0..100_000)
            .map(|n| f64::from_bits(c.water_c.to_bits() + n))
            .filter(|water| {
                Key::new(
                    state,
                    true,
                    PoolConditions {
                        water_c: *water,
                        ..c
                    },
                )
                .set()
                    == bucket
            })
            .take(WAYS + 1)
            .collect();
        assert_eq!(colliding.len(), WAYS + 1);
        for water in colliding
            .iter()
            .copied()
            .chain([colliding[4], colliding[0]])
        {
            let c = PoolConditions {
                water_c: water,
                ..c
            };
            exact(
                memo.transition(state, true, c),
                heater.pool_transition(&store, state, true, c),
            );
        }
        assert_eq!(memo.hits, 1);
        let bytes = memo.sets.as_ref().unwrap().len() * std::mem::size_of::<Set>();
        assert!(bytes <= 2 * 1024 * 1024, "thermal memo bytes: {bytes}");
    }
    #[test]
    fn disabled_direct_response_allocates_no_table() {
        let (heater, store) = models(0.0);
        let mut memo = PoolMemo::new(&heater, &store);
        for on in [false, true] {
            memo.transition(
                HeaterState::OffUnobserved,
                on,
                PoolConditions {
                    water_c: 31.0,
                    ..conditions()
                },
            );
            assert!(memo.sets.is_none());
        }
    }
}
