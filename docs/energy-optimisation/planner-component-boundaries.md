# Planner component boundaries and regression contracts

The normative exclusions and priorities are in
[constraint-requirements.md](constraint-requirements.md). Read that document
before changing learning, planning, transport, execution or their tests.

EV charging continuously serves the configured range target, with shortfall
counted from the first interval and `charge_limit_soc` as the charging cap.
There is **no EV departure concept**. Cable state is truthful telemetry; it
cannot remove future charging from planning. Observed inability to execute a
scheduled action uses the existing owner-scoped failure/replan mechanism.
Rooms retain their existing ordering and comfort-first objective. This
refactor does not create a new priority or spending policy.

## Implemented ownership

| Owner | Knowledge and inputs | Must not own |
| --- | --- | --- |
| `device-learning/room` | Room observation fitting, existing model-family comparison, fit evidence | Prices, commands, device permissions, other devices' fits |
| `device-learning/pool` | Water/electricity observations, pool loss and response fitting, prospective model-family selection | Room coefficients, commitments, electrical permission |
| `device-learning/linear-algebra.ts` | Numerical equation solving | Room or pool policy |
| `planner/models/room/thermal.ts` | Room thermal response and delayed heat | Regression, prices, scheduling |
| `planner/models/pool/state.ts` | Reconstruction of thermal memory from actual compressor energy | Parameter fitting or releasing commitments |
| `planner/models/pool/electrical.ts` | Compressor and auxiliary ON electricity from equipment evidence | Thermal gain, comfort targets or statistical fit quality |
| Rust `models/{battery,ev,pool,room}` | Pure device transitions and actuator simulation | Tariffs, policy, database or search |
| Rust `solver/{policy,room_policy}` | Existing economic/comfort preferences | Learning or physical response coefficients |
| Rust `solver/room_heating` | Bellman search, action enumeration and memoization | Its own copy of thermostat physics |
| `rules-planner.ts` | Existing ordered orchestration and publication | Fitting or mutating a caller's captured basis |
| `rules-planning-capture.ts` | Detached unsolved observations, intent, accepted commands and policy | Search or fitting on admission |
| `device-model-store.ts` | One atomic calibration bundle with per-model revisions | Weather caching or model selection |
| `device-model-learning/{room,pool}.ts` | Per-owner database observations and fitting adapters | Planning, commitments or other owners' models |
| `energy-device-learning` | One leased, fenced owner attempt | Whole-house learning or electrical capability writes |
| `prepared-energy-forecasts.ts` | Prices, outdoor weather, irradiance and house temperature forecasts | Device inventory, calibration or comfort preferences |

A room is a shared thermal plant. Each of its actuators has its own electrical
capabilities and commands. This does not claim separate causal heater gains
can be identified when the observations only identify the room's combined
response. Thermal parameters, actual state, equipment capabilities and user
intent remain different concepts.

The TypeScript thermal and electrical models retained for calibration,
reference projections and the benchmark are not a second executable planner.
Rust remains the sole search engine. The independently pinned benchmark is
not changed by this extraction.

### Capture and publication

```ts
const capture = captureRulesPlanningInput(input, acceptedReference, policy);
// Admission persists capture without running room or household search.
const result = await generateRemoteRulesPlan(capture, connection);
// The authenticated worker prepares, then solves in a separate invocation.
// Both operations use this one captured model, policy and commitment basis.
```

Model learning is separated from admission and the solve's dependency graph.
Each room and the pool owns a durable coalesced job, attempt clock, generation
and lease fence. A changed learning context supersedes an older in-flight job;
identical telemetry cannot continually restart it. Database cron recovers missed
wakes and expired leases. Read failures remain retriable job failures, rather
than fabricated statistical rejections. Failed statistical attempts retain the
previous usable parameters. Publication validates the owner's fence and model
revision in one transaction and cannot write pool hardware or electrical fields.

Model capture reads all room and pool records in one PostgreSQL statement. Job
provenance records the exact local revisions. Current equipment and preferences
are joined at admission; forecast schema 2 contains no model records, inventory,
or old room schedules. A new calibration therefore becomes available without
waiting for weather-cache expiry. Existing missing-evidence warning behavior is
retained; this refactor does not invent a new statistical admission gate.

Electrical reservation and expected consumption are different quantities.
The native pool boundary names `average_w` and `reservation_w` separately.
Reservation uses supported compressor ON draw, even when thermal evidence is
unavailable. The electrical boundary does not accept startup thermal-response
evidence: a fitted steady-phase wattage cannot override the producer's supported
ON capability. The integration captures that capability from the same retained,
setting-specific electrical evidence used by its executor; instantaneous sensor
watts and quarter-average consumption remain observations, not capability. State reconstruction and a thermal refit cannot lower that draw.
The existing empirical pool estimate still uses full draw conservatively; this
change does not invent a future thermostat duty fraction.

Room projection metadata is derived from the actual member controls and load
types. Mixed rooms are explicitly mixed. Graph power and temperature continue
to come from the selected room projection, not a newly simulated schedule.

## Behavioral contracts

`tests/planner-contracts` contains independently specified synthetic equipment
and observations. It contains no recorded household data. Its expected
properties are handwritten and are not generated by the planner:

- **EV-1/EV-3:** unplugging cannot erase/postpone future charging, each opening
  interval counts shortfall, and departure concepts remain excluded.
- **EV-4:** charging commands respect the charge cap even at negative prices;
  a higher measured SOC remains valid and requests no further charging.
- **EV-2:** select 12 A and 15 A in cases where they fit alongside the full pool
  load; min/max-only substitutes fail.
- **POOL-1:** equal electricity in a constant-COP, lossless pool cannot gain heat
  from brief pauses. Its selected flat-price schedule stays continuous.
- **POOL-2:** losing thermal evidence cannot substitute historical average
  electrical draw for full ON permission.
- **POOL-3:** independent differential-equation integration checks retained
  source depletion and delayed heat across a pause; resetting memory fails.
- **ROOM-1:** learn an independently simulated plant, plan its relay, recover
  comfort, stop heating after recovery and publish temperatures consistent
  with command energy. Flat temperatures, incorrect watts and thermostat
  metadata fail independent assertions.
- **BASIS-1/BASIS-2:** generation succeeds on recursively frozen EV, room, pool
  and hot-water inputs, is repeatable and leaves the basis unchanged. Mutating
  the caller's model, policy or accepted commands cannot alter a captured basis.

The physical tests deliberately use known, excited synthetic plants. They
cannot prove that an arbitrary household's fitted response is causal. A rule
that turns off a heater solely because its predicted benefit is small would be
a policy change; no such rule or statistical admission threshold is added.

`tests/planner-component-boundaries.test.ts` checks transitive dependencies,
including a seeded forbidden import. The tests cover actual orchestration and
state reconstruction, not just a directory containing some model files.

### Preventing rewritten expectations from blessing regressions

Run `deno task test:planner-contracts --base <accepted-revision>`. The runner
executes both the current contracts and the accepted revision's contracts and
helpers against the candidate production modules. Editing today's expected
values cannot change the historical assertions. A synthetic temporary Git
repository test demonstrates this: the current implementation and edited
oracle agree, but the accepted oracle still fails.

CI uses the pull-request base or the branch's last successful workflow commit.
Manual deployments retain that accepted baseline even though they deploy all
files. A missing baseline blocks the check. The required CI gate includes this job. The first introduction is explicitly
reported as a bootstrap because older revisions do not contain this suite.
No automatic expected-output update is available. Generated HA fixtures remain
transport/artifact checks and are not behavioral oracles.

If a protected contract fails, fix the implementation or identify the explicit
user-authorized requirement change. Do not delete assertions, widen tolerances,
replace the accepted revision or regenerate expected behavior merely to match
the new code. Changes to this runner, its CI gate or a contractual oracle need
explicit review of the requirement they change. Repository tests cannot make
their own CI configuration tamper-proof; branch protection/reviewer controls
remain a repository administration concern.

## Completed lifecycle separation

The existing execution order remains: room scheduling → native household
search → hot-water refinement → projection/publication. Internal protocol 10
runs preparation and solve in two authenticated worker invocations under one
orchestrator and deadline. This separates hosted CPU budgets without changing
search priorities, room ordering, holds, physical equations or price scoring.
The durable job persists unsolved input and can rerun both deterministic stages.
There is no compatibility path that treats protocol 9 prepared input as a new
capture. Rust remains the sole search engine; a wholesale translation of the
TypeScript orchestration would add unnecessary behavioral risk.

The architecture was compared independently using Claude and Codex. The chosen
design combines immutable unsolved captures and per-owner durable learning with
two separately budgeted worker operations. Whole-home learning jobs were rejected
because unrelated rooms would share failure and CPU limits. Fitted timestamps
were rejected as model identities; explicit locally generated revisions identify
exactly which coefficients were captured. The existing numerical model ownership
is retained rather than replacing it with a generic device framework.

## Observation semantics and integration qualification

Home Assistant reports quarter-average room temperatures, not interval-start
samples. The room learner uses an integrated mean observation operator, including
both adjacent quarters' heater energy, and compares candidate families/delays on
chronologically held-out measured transitions. Twelve-hour prediction error
remains a reported diagnostic. It cannot alone select a model that fits passive
background drift while explaining measured heater response poorly. Missing meter
coverage remains unknown; only complete measured zero energy is an OFF sample.
A changed learner method causes one new attempt, then the existing per-room
cadence resumes. There is no weak-gain floor or new heater shutoff policy.

The pool learner likewise distinguishes quarter means from interval starts. Its
delayed/source response fit integrates the existing physical transition over the
measurement interval; static COP/loss and empirical response fits align adjacent
quarters' measured input with the change between their means. Thermal learning
cannot write electrical capability. These observation corrections preserve the
planner's physical transitions and continuity policy.

Known-plant contracts cover quarter means, delayed heat, missing readings and
sparse heater pulses against slow background drift. Existing interval-start
physical contracts remain unchanged. Private captured replay validation stays
outside the public repository and is not substituted for synthetic oracles.

Qualification additionally runs the actual Python producer, current TypeScript /
Rust planner and actual Python consumer, intent encoding, gateway and durable
executor against inert I/O. It records both repository identities. It checks
intermediate EV currents, cable-independent future schedules, full pool ON
reservation and room relay energy/temperature consistency. A copied JSON fixture
alone is not integration qualification. Hosted TEST runs and a real replan are
still needed to verify the deployed functions, model revisions and producer;
local CPU checks cannot prove every workload avoids a hosted resource limit.

Room electrical learning belongs to the HA producer, where actual actuator
activity is available. Its operating mean uses configured fixed watts or power
observations wholly covered by explicit thermostat heating / direct relay ON
states. Capture-time standby watts, unconditional quarter averages and retained
reservation peaks cannot substitute for this evidence. The existing
`active_power_w` room input carries this operating mean; empirical forecasts and
the gateway's conservative reservation remain separate. Missing operating
evidence retains existing comfort intent and empirical estimates, with no
invented thermal trajectory. This correction does not introduce a new native
reservation policy or establish that a weakly excited thermal fit is accurate.

Exact execution optimizations reuse a request's projection allocation, identical
pool transition endpoints and room trajectories whose thermostat branch decisions
are unchanged. They preserve action enumeration, scoring and tie order. Full
preparation and plan comparisons, native threshold tests and hosted checks cover
these optimizations; no search-budget reduction is used to meet CPU limits.
Pool calibration prepares each candidate's fixed observation coefficients once
and shares the identical constant-family search prefix when comparing families.
The candidate grid, chronological validation, selection and diagnostics remain
unchanged; complete-fit parity and the existing CPU budget guard this reuse.
