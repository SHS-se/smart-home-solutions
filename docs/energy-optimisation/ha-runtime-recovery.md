# Current Home Assistant readiness and recovery

## Scope-preserving recovery — 15 September 2026

Persist and validate participation and battery supply/solar-attribution identities alongside existing policy, ownership and pending effects. Restart cannot revive excluded or demoted control, invent subgroup observations, reset accounting or broaden supply to the whole house/rating. Existing explicit release and durable-effect rules remain; this decision introduces no recovery fallback.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

Plan acceptance is a historical event. The portal treats a plan as available only
when Home Assistant has reported `ready` for that exact plan ID within the last
150 seconds and both the binding and validity boundaries remain in the future.
The report includes the local reason, recovery progress, retry time, and last
planning error. Portal refresh time and historical acceptance are labelled
separately from the time the HA report was received.

The integration restores its saved plan before starting controllers. The same
contract/expiry validator used for normal execution checks the restored plan;
invalid and expired plans can be inspected but cannot issue commands. Every minute
the integration reports local readiness and checks for an unusable plan or a user
replan request. Recovery requests fresh measurements and a new plan automatically.
Failures retry after 1, 2, 4, then 5 minutes, with at most one recovery in flight.
The regular quarter-hour exchange remains in place. Recovery continues even when
status delivery fails, and disabled planning never causes automatic replanning.

Reports use the authenticated `integration-status` POST endpoint and a separate
runtime field on the current-plan row. They never rewrite historical acceptance.
Server receipt time and the client observation time both expire. The server rejects
observations more than 150 seconds old or 30 seconds in the future. The database
ignores out-of-order reports. A report for a different plan cannot confirm the
currently displayed plan. A disconnected integration is shown as unconfirmed,
not assumed to be executing or stopped.

## Rollout

Deploy the database migration and `integration-status` endpoint, then the website,
then integration 0.8.0-beta.32. Existing installations without runtime reporting
show unconfirmed status until upgraded; old acknowledgements are not treated as
current readiness. The changes do not enable device-control permissions.

## Verification

Integration lifecycle tests cover restart, invalid/expired plans, absent plans,
network failures, bounded retry, concurrent exchanges, disabled planning, and
explicit replan requests. Runtime tests cover report validation, identity mismatch,
lease expiry, delayed reports, clock skew, and loss of local availability.
