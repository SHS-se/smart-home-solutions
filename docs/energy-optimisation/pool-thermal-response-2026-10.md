# Learned pool water response — 17 October 2026

Pool heat no longer has to appear immediately in the measured water reading.
The empirical model learns a continuous response from chronological compressor
energy and water history. It has no minimum runtime and no zero-heat startup
period added to discourage short runs.

## Model and ownership

The store carries the measured water temperature and one additional quantity:
the pending heat contribution in kWh. For a response time `tau`, heat enters
that contribution and reaches the water continuously at `pending / tau`.
The transition conserves input heat across the water and pending contribution.
When the heater stops, pending heat continues to affect the reading. A direct
response is the same model with `tau = 0`.

This is an effective model of the observed response. The filtered thermometer
cannot identify water mixing, sensor filtering and intermediate thermal storage
separately. A flat reading does not prove the supplied heat disappeared.

`device-learning/pool/response.ts` fits the time constant, steady temperature gain per compressor
kWh and standing cooling jointly. Each contiguous history segment has a fitted
nonnegative starting contribution, so an already-running first observation is
not treated as a cold start. Both quarter and hourly temperature changes enter
the fit; no fixed post-run settling exclusion is used in this dynamic fit.
`planner/models/pool/state.ts` reconstructs captured state without fitting.
The older bin fit remains separate evidence for homes without an identified
dynamic model. Fit diagnostics do not gate household planning.

`planner/pool-physics.ts` publishes the same model for production and browser
simulations. The dynamic fit uses actual compressor electricity. Its forecast
therefore uses the electrical startup curve exactly once; the older unmeasured
supply/return heat proxy is not applied again. Circulation electricity is billed
but is excluded from heat calibration.

The TS and Rust kernels integrate the piecewise-linear startup and exponential
response continuously. Hardware stopping finds the first threshold crossing,
including a rise followed by a fall inside a quarter. Off intervals still advance
the pending contribution. Shared arithmetic and transition vectors preserve
native/Wasm determinism.

## Captures, continuations and valuation

Daily refits persist parameters and fitted beginning/end response checkpoints.
Each capture replays actual compressor energy from a checkpoint at or before
that capture. A later fitted checkpoint is never used as an earlier physical
state. If the required earlier state is unavailable, existing empirical pool
service preserves known comfort intent and permissions; the household still
plans.

The HA snapshot now includes observed actuator intervals in the unfinished
quarter, including runs that already stopped. These supplement completed meter
quarters with explicitly estimated electrical startup energy. Multiple cycles
and companion actuator switching are represented. Unknown history is marked
incomplete while retaining usable on intervals; it is not fabricated as off.
Coverage stays in diagnostics.

All solver branches, memo keys, independent referee simulations, baseline
controllers, replans and monthly ROI checkpoints carry pending heat. Comfort
rules judge the water reading. Terminal inventory counts water plus pending
heat divided by water heat capacity, at both the beginning and the end. This
prevents a horizon boundary from discarding a run's later contribution.

The native ABI is 10 and the planner model is v13. ROI checkpoints use v6.
These are roll-forward changes, with no decoder for older native problems.

## Recorded-history validation

`pool-response-history.fixture.json` preserves the 12–17 October HA export as
quarter-hour observations, with source SHA-256 and preparation notes. Temperature
is carried between change events, preserving plateaus; compressor W is
integrated into quarter kWh. The 13 October afternoon run and following idle
period are excluded from the primary regression fit.

The held-out run consumed about 1.85 compressor kWh. Its reading rose from
29.64°C to 29.65°C. The previous captured model predicted about +0.09°C. The
learned response predicts about +0.01°C while preserving the measured electrical
startup and the contribution that remains after shutdown. Leave-one-day-out
tests also compare hourly changes against direct response on every recorded day.

The model still smooths the thermometer's plateaus: agreement at shutdown does
not mean every subsequent reading is exact. Better physical prediction lets
short and sustained runs compete on their estimated benefit; it does not ban
short runs or guarantee that every economical schedule omits them.

## Rollout

Apply the two new SQL migrations and deploy the server/planner artifact. The
model migration makes the next normal background refresh refit each pool; no
home-specific coefficients are seeded. HA beta `0.9.0-beta.121` supplies the new
current-quarter interval evidence. Its change is telemetry only and does not
alter controller writes or handover behaviour.
