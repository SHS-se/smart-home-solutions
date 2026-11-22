-- Room run ledgers now record each run's outdoor temperature and cool-down.
-- The learner's window implementation changed with them, so every band is
-- revisited once. Requeue idle room jobs instead of waiting for each room's
-- daily cadence. The delay lets CI deploy the edge function that follows this
-- migration; a job that still runs the previous learner only defers the
-- refresh to the room's next ordinary attempt, which then revisits every band.
UPDATE private.energy_learning_jobs SET pending=true,generation=generation+1,fence=fence+1,
  lease_until=NULL,wake_after=now()+interval '15 minutes',attempts=0,last_error=NULL,finished_at=NULL
WHERE owner_kind='room' AND NOT pending;
