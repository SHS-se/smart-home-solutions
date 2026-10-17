use shs_planner_models::{HeaterState, PoolConditions, PoolTransition};

const SETS: usize = 4096;
const WAYS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Key {
    slot: usize,
    water: u64,
    pending: u64,
    age: u64,
    kind: u8,
}
impl Key {
    fn new(slot: usize, water: f64, pending: f64, state: HeaterState) -> Self {
        let (kind, age) = match state {
            HeaterState::OffUnobserved => (0, 0),
            HeaterState::Off { seconds } => (1, seconds.to_bits()),
            HeaterState::Running { seconds } => (2, seconds.to_bits()),
            HeaterState::Steady => (3, 0),
        };
        Self {
            slot,
            water: water.to_bits(),
            pending: pending.to_bits(),
            age,
            kind,
        }
    }
    fn set(self) -> usize {
        let mut hash = self.water
            ^ self.pending.rotate_left(31)
            ^ self.age.rotate_left(17)
            ^ (self.slot as u64).wrapping_mul(0x9e3779b97f4a7c15)
            ^ u64::from(self.kind);
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

/// Private to the projector bound to one immutable problem. Slot identity binds
/// duration/outdoor temperature; that problem binds the heater/store/stop models.
/// Capacity bounds memory, never candidate search or declared work.
#[derive(Default)]
pub(super) struct PoolMemo {
    sets: Option<Box<[Set]>>,
    #[cfg(test)]
    hits: usize,
}
impl PoolMemo {
    #[cfg(test)]
    pub(super) fn hits(&self) -> usize {
        self.hits
    }
    pub(super) fn transition(
        &mut self,
        slot: usize,
        state: HeaterState,
        on: bool,
        conditions: PoolConditions,
        calculate: impl FnOnce(PoolConditions) -> PoolTransition,
    ) -> PoolTransition {
        // Off/thermostat-disabled transitions are cheap and need no allocation.
        if !on
            || conditions
                .stop_c
                .is_some_and(|stop| conditions.water_c >= stop)
        {
            return calculate(conditions);
        }
        let key = Key::new(slot, conditions.water_c, conditions.pending_heat_kwh, state);
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
        let value = calculate(conditions);
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
    use shs_planner_models::{Heater, Response, StandingLoss, ThermalStore};

    #[test]
    fn exact_keys_distinguish_signed_zero_heater_phase_and_slot() {
        assert_ne!(
            Key::new(0, 0.0, 0.0, HeaterState::Steady),
            Key::new(0, -0.0, 0.0, HeaterState::Steady)
        );
        assert_ne!(
            Key::new(0, 30.0, 0.0, HeaterState::Off { seconds: 0.0 }),
            Key::new(0, 30.0, 0.0, HeaterState::Off { seconds: -0.0 })
        );
        assert_ne!(
            Key::new(0, 30.0, 0.0, HeaterState::OffUnobserved),
            Key::new(0, 30.0, 0.0, HeaterState::Off { seconds: 0.0 })
        );
        assert_ne!(
            Key::new(0, 30.0, 0.0, HeaterState::Off { seconds: 1.0 }),
            Key::new(0, 30.0, 0.0, HeaterState::Running { seconds: 1.0 })
        );
        assert_ne!(
            Key::new(0, 30.0, 0.0, HeaterState::Steady),
            Key::new(1, 30.0, 0.0, HeaterState::Steady)
        );
    }

    #[test]
    fn identical_water_with_different_pending_energy_cannot_share_a_cache_entry() {
        let mut memo = PoolMemo::default();
        let heater = Heater {
            compressor_w: 3000.0,
            auxiliary_w: 0.0,
            heat_w: 12000.0,
            response: Response::Steady,
        };
        let store = ThermalStore {
            capacity_kwh_per_c: 5.0,
            response_time_constant_h: 2.0,
            loss: StandingLoss::Linear {
                kw_per_c: 0.0,
                surroundings_c: None,
            },
        };
        let mut results = Vec::new();
        for pending in [0.0, 5.0, 0.0, 5.0] {
            let conditions = PoolConditions {
                water_c: 29.0,
                pending_heat_kwh: pending,
                outdoor_c: 20.0,
                seconds: 900.0,
                stop_c: None,
            };
            results.push(
                memo.transition(0, HeaterState::Steady, true, conditions, |c| {
                    heater.pool_transition(&store, HeaterState::Steady, true, c)
                }),
            );
        }
        assert!(results[1].water_c > results[0].water_c);
        assert!(results[1].pending_heat_kwh > results[0].pending_heat_kwh);
        assert_eq!(results[0].water_c, results[2].water_c);
        assert_eq!(results[1].water_c, results[3].water_c);
        assert_eq!(memo.hits(), 2);
    }

    #[test]
    fn collisions_replacement_and_exact_hits_preserve_the_pure_transition() {
        let heater = Heater {
            compressor_w: 3000.0,
            auxiliary_w: 764.0,
            heat_w: 12000.0,
            response: Response::Steady,
        };
        let store = ThermalStore {
            response_time_constant_h: 0.0,
            capacity_kwh_per_c: 5.0,
            loss: StandingLoss::Linear {
                kw_per_c: 0.13,
                surroundings_c: Some(20.0),
            },
        };
        let state = HeaterState::Off { seconds: -0.0 };
        let bucket = Key::new(0, 30.0, 0.0, state).set();
        let colliding: Vec<_> = (0..100_000)
            .map(|n| f64::from_bits(30.0_f64.to_bits() + n))
            .filter(|water| Key::new(0, *water, 0.0, state).set() == bucket)
            .take(WAYS + 1)
            .collect();
        assert_eq!(colliding.len(), WAYS + 1);
        let mut memo = PoolMemo::default();
        let mut computations = 0;
        for water in colliding
            .iter()
            .copied()
            .chain([colliding[4], colliding[0]])
        {
            let conditions = PoolConditions {
                water_c: water,
                pending_heat_kwh: 0.0,
                outdoor_c: 20.0,
                seconds: 900.0,
                stop_c: Some(30.1),
            };
            let direct = heater.pool_transition(
                &store,
                state,
                true,
                PoolConditions {
                    water_c: water,
                    pending_heat_kwh: 0.0,
                    outdoor_c: 20.0,
                    seconds: 900.0,
                    stop_c: Some(30.1),
                },
            );
            let cached = memo.transition(0, state, true, conditions, |conditions| {
                computations += 1;
                heater.pool_transition(&store, state, true, conditions)
            });
            for (a, b) in [
                (cached.electric_w, direct.electric_w),
                (cached.compressor_w, direct.compressor_w),
                (cached.auxiliary_w, direct.auxiliary_w),
                (cached.heat_w, direct.heat_w),
                (cached.water_c, direct.water_c),
                (cached.pending_heat_kwh, direct.pending_heat_kwh),
            ] {
                assert_eq!(a.to_bits(), b.to_bits());
            }
            assert_eq!(
                cached.start.unwrap().off_seconds.unwrap().to_bits(),
                (-0.0_f64).to_bits()
            );
        }
        assert_eq!(computations, WAYS + 2);
        assert_eq!(memo.hits, 1);
        let bytes = memo.sets.as_ref().unwrap().len() * std::mem::size_of::<Set>();
        println!("thermal memo bytes: {bytes}");
        assert!(bytes <= 2 * 1024 * 1024);
    }

    #[test]
    fn inactive_heating_allocates_no_table() {
        let mut memo = PoolMemo::default();
        for on in [false, true] {
            memo.transition(
                0,
                HeaterState::OffUnobserved,
                on,
                PoolConditions {
                    water_c: 31.0,
                    pending_heat_kwh: 0.0,
                    outdoor_c: 20.0,
                    seconds: 900.0,
                    stop_c: Some(30.1),
                },
                |_| PoolTransition {
                    electric_w: 0.0,
                    compressor_w: 0.0,
                    auxiliary_w: 0.0,
                    heat_w: 0.0,
                    water_c: 30.9,
                    pending_heat_kwh: 0.0,
                    next: HeaterState::Off { seconds: 900.0 },
                    start: None,
                },
            );
            assert!(memo.sets.is_none());
        }
    }
}
