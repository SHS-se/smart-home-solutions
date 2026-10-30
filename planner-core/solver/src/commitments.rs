//! Owner-level commitments shared by construction, search and certification.
use crate::{Command, Operation, OwnerMask, Problem};

#[derive(Clone, Copy, Debug)]
pub(crate) enum Owner {
    Pool,
    Ev,
    Battery,
}

impl OwnerMask {
    pub(crate) fn contains(self, owner: Owner) -> bool {
        match owner {
            Owner::Pool => self.pool,
            Owner::Ev => self.ev,
            Owner::Battery => self.battery,
        }
    }
}
pub(crate) struct Hold<'a> {
    command: Option<&'a Command>,
    mask: OwnerMask,
}
pub(crate) fn hold(p: &Problem, i: usize) -> Hold<'_> {
    if let Some(command) = p
        .fixed_commands
        .as_ref()
        .and_then(|cs| cs.get(i))
        .and_then(Option::as_ref)
    {
        return Hold {
            command: Some(command),
            mask: OwnerMask {
                pool: true,
                ev: true,
                battery: true,
            },
        };
    }
    let command = (p.slots[i].start_seconds < p.locked_through_seconds)
        .then(|| p.accepted.as_ref().and_then(|cs| cs.get(i)))
        .flatten();
    let released = p
        .released
        .as_ref()
        .and_then(|masks| masks.get(i))
        .copied()
        .unwrap_or_default();
    Hold {
        command,
        mask: OwnerMask {
            pool: command.is_some() && !released.pool,
            ev: command.is_some() && !released.ev,
            battery: command.is_some() && !released.battery,
        },
    }
}
impl Hold<'_> {
    pub(crate) fn has(&self, owner: Owner) -> bool {
        self.mask.contains(owner)
    }
    pub(crate) fn any(&self) -> bool {
        self.mask.pool || self.mask.ev || self.mask.battery
    }
    pub(crate) fn full(&self) -> Option<&Command> {
        (self.mask.pool && self.mask.ev && self.mask.battery)
            .then_some(self.command)
            .flatten()
    }
    pub(crate) fn impose(&self, mut proposed: Command) -> Command {
        if let Some(c) = self.command {
            if self.mask.pool {
                proposed.pool_on = c.pool_on;
            }
            if self.mask.ev {
                proposed.ev_amps = c.ev_amps;
            }
            if self.mask.battery {
                proposed.battery = c.battery;
                proposed.charge_limit_w = c.charge_limit_w;
                proposed.discharge_limit_w = c.discharge_limit_w;
            }
        }
        proposed
    }
    pub(crate) fn admits(&self, proposed: &Command) -> bool {
        self.impose(proposed.clone()) == *proposed
    }
}
pub(crate) fn unavailable(p: &Problem, i: usize, owner: Owner) -> bool {
    p.unavailable
        .as_ref()
        .is_some_and(|masks| masks[i].contains(owner))
}
pub(crate) fn available_command(p: &Problem, i: usize, c: &Command) -> bool {
    !(unavailable(p, i, Owner::Pool) && c.pool_on
        || unavailable(p, i, Owner::Ev) && c.ev_amps != 0
        || unavailable(p, i, Owner::Battery)
            && (c.battery != Operation::Idle
                || c.charge_limit_w != 0.0
                || c.discharge_limit_w != 0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CarTerm, CarTier, EndCreditTerms, Outcome, ProjectionOutcome, StoreTerm};

    fn idle() -> Command {
        Command {
            pool_on: false,
            ev_amps: 0,
            battery: Operation::Idle,
            charge_limit_w: 0.0,
            discharge_limit_w: 0.0,
        }
    }
    fn mask(owner: Owner) -> OwnerMask {
        OwnerMask {
            pool: matches!(owner, Owner::Pool),
            ev: matches!(owner, Owner::Ev),
            battery: matches!(owner, Owner::Battery),
        }
    }
    fn requested(c: &Command, owner: Owner) -> bool {
        match owner {
            Owner::Pool => c.pool_on,
            Owner::Ev => c.ev_amps > 0,
            Owner::Battery => c.battery == Operation::GridCharge,
        }
    }
    fn selected(p: &Problem) -> Box<crate::Selection> {
        match crate::solve(p) {
            Outcome::Selected { selection } => selection,
            Outcome::Failed { issue } => panic!("{issue}"),
        }
    }

    #[test]
    fn each_owner_moves_from_blocked_source_into_held_off_destinations() {
        for owner in [Owner::Pool, Owner::Ev, Owner::Battery] {
            let mut p = crate::witnesses::tests::problem(4);
            p.slots[0].start_seconds = -300.0;
            for (i, s) in p.slots.iter_mut().enumerate() {
                s.start_seconds = i as f64 * 900.0 - 300.0;
            }
            p.locked_through_seconds = 3300.0;
            let mut accepted = vec![idle(); 4];
            // Keep exact nonzero battery permission ceilings while moving appliances.
            if !matches!(owner, Owner::Battery) {
                for c in &mut accepted {
                    c.battery = Operation::Hold;
                    c.charge_limit_w = 1234.0;
                }
            }
            match owner {
                Owner::Pool => {
                    accepted[0].pool_on = true;
                    p.targets.pool_c = Some(32.0);
                }
                Owner::Ev => {
                    accepted[0].ev_amps = 16;
                    p.car_policy.as_mut().unwrap().floor_kwh = 60.0;
                }
                Owner::Battery => {
                    accepted[0].battery = Operation::GridCharge;
                    accepted[0].charge_limit_w = 1000.0;
                }
            }
            p.end_credit = EndCreditTerms {
                reference_sek_per_kwh: 1000.0,
                pool: matches!(owner, Owner::Pool).then_some(StoreTerm {
                    cap: 32.0,
                    grid_kwh_per_unit: 1.0,
                }),
                ev: matches!(owner, Owner::Ev).then_some(CarTerm {
                    grid_kwh_per_unit: 1.0,
                    tiers: vec![CarTier {
                        up_to: 60.0,
                        sek_per_kwh: 1000.0,
                    }],
                }),
                battery: matches!(owner, Owner::Battery).then_some(StoreTerm {
                    cap: 10.0,
                    grid_kwh_per_unit: 1.0,
                }),
            };
            p.accepted = Some(accepted.clone());
            p.released = Some(vec![mask(owner); 4]);
            let mut unavailable = vec![OwnerMask::default(); 4];
            unavailable[0] = mask(owner);
            p.unavailable = Some(unavailable);
            let result = selected(&p);
            assert!(!requested(&result.commands[0], owner));
            assert!(
                result.commands[1..].iter().any(|c| requested(c, owner)),
                "released OFF destinations must be usable: {owner:?} {:?}",
                result.commands
            );
            for (i, c) in result.commands.iter().enumerate() {
                if !matches!(owner, Owner::Pool) {
                    assert_eq!(c.pool_on, accepted[i].pool_on);
                }
                if !matches!(owner, Owner::Ev) {
                    assert_eq!(c.ev_amps, accepted[i].ev_amps);
                }
                if !matches!(owner, Owner::Battery) {
                    assert_eq!(c.battery, accepted[i].battery);
                    assert_eq!(c.charge_limit_w, accepted[i].charge_limit_w);
                    assert_eq!(c.discharge_limit_w, accepted[i].discharge_limit_w);
                }
            }
            match crate::project(&p, &result.commands) {
                ProjectionOutcome::Projected { quarters } => assert_eq!(quarters, result.quarters),
                ProjectionOutcome::Failed { issue } => panic!("{issue}"),
            }
        }
    }

    #[test]
    fn partial_owner_hold_rejects_unrelated_edits_and_fixed_booking_wins() {
        let mut p = crate::witnesses::tests::problem(4);
        p.accepted = Some(vec![idle(); 4]);
        p.locked_through_seconds = 3600.0;
        p.released = Some(vec![mask(Owner::Ev); 4]);
        let mut ev = idle();
        ev.ev_amps = 6;
        assert!(hold(&p, 0).admits(&ev));
        let mut pool = ev.clone();
        pool.pool_on = true;
        assert!(!hold(&p, 0).admits(&pool));
        let mut battery = ev.clone();
        battery.charge_limit_w = 1000.0;
        assert!(!hold(&p, 0).admits(&battery));
        p.fixed_commands = Some(vec![Some(idle()), None, None, None]);
        assert!(!hold(&p, 0).admits(&ev));
        assert!(crate::physics::projection(&p, &vec![ev; 4]).is_err());
    }

    #[test]
    fn faults_keep_models_and_targets_but_project_no_unavailable_draw() {
        for owner in [Owner::Pool, Owner::Ev, Owner::Battery] {
            let mut p = crate::witnesses::tests::problem(4);
            p.unavailable = Some(vec![mask(owner); 4]);
            let result = selected(&p);
            assert!(result.commands.iter().all(|c| !requested(c, owner)));
            for q in &result.quarters {
                assert_eq!(q.pool_c.is_some(), p.pool_store.is_some());
                assert_eq!(q.ev_kwh.is_some(), p.car.is_some());
                assert_eq!(q.battery_kwh.is_some(), p.battery.is_some());
                match owner {
                    Owner::Pool => assert_eq!(q.pool_w, 0.0),
                    Owner::Ev => assert_eq!(q.ev_w, 0.0),
                    Owner::Battery => {
                        assert_eq!(q.charge_w, 0.0);
                        assert_eq!(q.discharge_w, 0.0);
                    }
                }
            }
        }
    }

    #[test]
    fn incompatible_fixed_unavailable_booking_is_not_released() {
        let mut p = crate::witnesses::tests::problem(4);
        let mut c = idle();
        c.pool_on = true;
        p.accepted = Some(vec![c.clone(); 4]);
        p.locked_through_seconds = 3600.0;
        p.released = Some(vec![mask(Owner::Pool); 4]);
        p.fixed_commands = Some(vec![Some(c), None, None, None]);
        p.unavailable = Some(vec![mask(Owner::Pool); 4]);
        assert!(matches!(crate::solve(&p), Outcome::Failed { issue }
            if issue == "committed_command_infeasible:0:owner_unavailable"));
    }

    #[test]
    fn malformed_masks_are_refused_before_search() {
        let mut p = crate::witnesses::tests::problem(4);
        p.released = Some(vec![]);
        assert_eq!(crate::validate(&p), Err("invalid_released_owners".into()));
        p.accepted = Some(vec![idle(); 4]);
        p.locked_through_seconds = 3600.0;
        p.released = Some(vec![mask(Owner::Ev); 3]);
        assert_eq!(crate::validate(&p), Err("invalid_released_owners".into()));
        p.released = None;
        p.unavailable = Some(vec![mask(Owner::Ev); 3]);
        assert_eq!(
            crate::validate(&p),
            Err("invalid_unavailable_owners".into())
        );
        assert!(serde_json::from_value::<OwnerMask>(
            serde_json::json!({"pool":false,"ev":true,"battery":false,"other":true})
        )
        .is_err());
    }
}

#[cfg(test)]
mod auxiliary_tests {
    use crate::*;

    fn command(on: bool) -> Command {
        Command {
            pool_on: on,
            ev_amps: 0,
            battery: Operation::Idle,
            charge_limit_w: 0.0,
            discharge_limit_w: 0.0,
        }
    }

    #[test]
    fn fixed_auxiliary_draw_survives_pool_failure_without_claiming_heat() {
        let mut p = crate::witnesses::tests::problem(4);
        for s in &mut p.slots {
            s.pool_auxiliary_dispatch = Some(PoolAuxiliaryDispatch {
                fixed_w: 700.0,
                on_w: 300.0,
            });
        }
        p.unavailable = Some(vec![
            OwnerMask {
                pool: true,
                ev: false,
                battery: false
            };
            4
        ]);
        let Outcome::Selected { selection } = crate::solve(&p) else {
            panic!("failed pool must not erase independent pump")
        };
        for (c, q) in selection.commands.iter().zip(selection.quarters.iter()) {
            assert!(!c.pool_on);
            assert_eq!(q.pool_auxiliary_w, 700.0);
            assert_eq!(q.pool_w, 700.0);
            assert_eq!(q.pool_compressor_w, 0.0);
            assert_eq!(q.pool_heat_w, 0.0);
            assert_eq!(q.net_w, 700.0 + q.charge_w - q.discharge_w);
        }
    }

    #[test]
    fn independent_auxiliary_dispatch_changes_electricity_without_changing_thermal_physics() {
        let mut p = crate::witnesses::tests::problem(4);
        p.heater.as_mut().unwrap().auxiliary_w = 900.0;
        let commands = vec![command(false), command(true), command(false), command(true)];
        let original = physics::projection(&p, &commands).unwrap();
        for (i, s) in p.slots.iter_mut().enumerate() {
            s.pool_auxiliary_dispatch = Some(PoolAuxiliaryDispatch {
                fixed_w: 700.0 + i as f64 * 10.0,
                on_w: 300.0,
            });
        }
        let memoized = physics::projection(&p, &commands).unwrap();
        assert_eq!(memoized, physics::project_external(&p, &commands).unwrap());
        for (i, (old, q)) in original.iter().zip(memoized.iter()).enumerate() {
            assert_eq!(q.pool_c, old.pool_c);
            assert_eq!(q.pool_pending_heat_kwh, old.pool_pending_heat_kwh);
            assert_eq!(q.pool_compressor_w, old.pool_compressor_w);
            assert_eq!(q.pool_heat_w, old.pool_heat_w);
            let expected = 700.0 + i as f64 * 10.0 + if commands[i].pool_on { 300.0 } else { 0.0 };
            assert_eq!(q.pool_auxiliary_w, expected);
            assert_eq!(q.pool_w, q.pool_compressor_w + expected);
            assert_eq!(q.net_w, old.net_w - old.pool_auxiliary_w + expected);
        }
    }

    #[test]
    fn auxiliary_dispatch_is_required_nullable_and_validated() {
        let mut p = crate::witnesses::tests::problem(1);
        let mut value = serde_json::to_value(&p).unwrap();
        value["slots"][0]
            .as_object_mut()
            .unwrap()
            .remove("pool_auxiliary_dispatch");
        assert!(serde_json::from_value::<Problem>(value).is_err());
        for watts in [-1.0, f64::NAN, f64::INFINITY] {
            p.slots[0].pool_auxiliary_dispatch = Some(PoolAuxiliaryDispatch {
                fixed_w: watts,
                on_w: 0.0,
            });
            assert_eq!(validate(&p), Err("invalid_pool_auxiliary_dispatch".into()));
            p.slots[0].pool_auxiliary_dispatch = Some(PoolAuxiliaryDispatch {
                fixed_w: 0.0,
                on_w: watts,
            });
            assert_eq!(validate(&p), Err("invalid_pool_auxiliary_dispatch".into()));
        }
    }
}
