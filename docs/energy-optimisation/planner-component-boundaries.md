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
| `device-learning/room` | Joint internal/external room exchange, solar and delayed-heater fitting, fit evidence | Prices, commands, device permissions, other devices' fits |
| `device-learning/pool` | Water/electricity observations, pool loss and response fitting, prospective model-family selection | Room coefficients, commitments, electrical permission |
| `device-learning/operating-points.ts` | Measured draw and heat per kWh of variable-power equipment, per combination of its power settings | Planning, prices, commands or electrical permission |
| `device-learning/heat-pump-startup.ts` | A heat pump's start-up peak, recovery draw and running draw and peak per outdoor band, with an out-of-sample check | Planning, commands or electrical permission |
| `device-learning/linear-algebra.ts` | Numerical equation solving | Room or pool policy |
| `planner/models/room/thermal.ts` | Room thermal response and delayed heat | Regression, prices, scheduling |
| `planner/models/room/connected-exchange.ts` | Native-mean observation/state contract, positive stochastic exchange, causal posterior and coefficient prediction | Database, tariffs, actuator permissions |
| `device-learning/room/connected-response.ts` | Joint stable receiving-response identification and bounded exchange-process identification | Commands, prices, changing accepted body parameters during planning capture |
| `connected-room-planning-capture.ts` | Fenced, immutable source acquisition, qualification and resumable derived state in the authenticated planning worker | Learning a replacement heater/body response or changing intent |
| `owned-planning-worker.ts` | One authenticated, fenced capture/preparation/catalog/replica/barrier/solve action and direct checkpoint | Publishing plans, changing physical or preference policy |
| `room-forecast-catalog.ts` | Exact JSON record encoding, UTF-8 byte offsets and compressed artifact transport | Probability normalization, hypothesis selection or covariance semantics |
| `rules-planning-client.ts`, `energy-planning-jobs.ts` | Compact bounded worker waves, durable household ownership and atomic publication | Inference kernels or repeated posterior transport through ingestion |
| `planner/models/pool/state.ts` | Reconstruction of thermal memory from actual compressor energy | Parameter fitting or releasing commitments |
| `planner/models/pool/electrical.ts` | Expected compressor and auxiliary draw from the learned operating point, and the separate ON reservation, from equipment evidence | Thermal gain, comfort targets or statistical fit quality |
| Rust `models/{battery,ev,pool,room}` | Pure device transitions and actuator simulation | Tariffs, policy, database or search |
| Rust `solver/{policy,room_policy}` | Existing economic/comfort preferences | Learning or physical response coefficients |
| Rust `solver/room_heating` | Bellman search, action enumeration and memoization | Its own copy of thermostat physics |
| Rust `models/room_network`, `solver/room_network` | Simultaneous room evolution, ordered proposals and authoritative whole-network command replay | Fitting, source selection or a separate thermostat implementation |
| `rules-planner.ts` | Existing ordered orchestration and publication | Fitting or mutating a caller's captured basis |
| `rules-planning-capture.ts` | Detached unsolved observations, intent, accepted commands and policy | Search or fitting on admission |
| `device-model-store.ts` | One atomic calibration bundle with per-model revisions | Weather caching or model selection |
| `device-model-learning/{room,pool,device}.ts` | Per-owner database observations and fitting adapters | Planning, commitments or other owners' models |
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

### Adaptive connected-room response

The app owns the canonical room connection map. Each receiving-room learner
owns its effective nonnegative incoming rates; opposite directions need not
identify reciprocal physical W/K. Electrical heater response alone does not
identify delivered heat, COP or thermal capacity, so the new response leaves
those physical diagnostics null. Named exchange replaces aggregate-house
coupling in this model family.

Each native interval mean is scored once against a latent boundary temperature,
known stored heater heat and continuous log-rate state. Positive cubature weights
carry the joint covariance of the interval mean and its endpoint. Observation
noise, unexplained thermal disturbances and exchange-process variation are
separate terms. Proper scaled inverse-chi-squared variance priors have one degree
of freedom and a data-derived, partition-fixed scale. Missing electricity stays
unknown; a warm residual cannot manufacture stored heater heat.

Stable response fitting and current exchange inference have different owners.
A captured plan keeps the accepted heater/body/noise parameters exactly. Its
bounded preparation updates the retained incoming-process posterior against
immutable qualified evidence, without refitting the body. Each incoming edge
has its own regime-reset intensity and within-regime persistence. A regime has
an unknown static log-rate centre and either a constant coefficient or an
Ornstein–Uhlenbeck variation around that centre. Reset priors are frozen with the
accepted evidence basis; inferred resets are statistical changes, not door
observations. Four independently seeded particle replicas retain parameter and
state uncertainty, with their evidence normalizers contributing to the combined
posterior. Known stored heat remains a deterministic measured contribution.
This can respond to a first new exchange regime even when the accepted process
previously estimated no variation. There is no process-noise floor, arbitrary
recency window, inferred contact state or confidence-based service gate.
Likelihood is conditional on measured native neighbour means; it is not evidence
of genuine future network forecast accuracy. The latter requires independent
coupled-plant and chronological closed-loop validation. Predictive mean rates
are used only by the conditional proposal engine. Final command qualification
uses joint stochastic rate paths and signed thermal disturbances, retaining
initial state/rate covariance and per-edge reset uncertainty. Common paths are
shared by proposed, literal and feasible-seed vectors; uncertainty is integrated
after positive-part comfort shortfall and closed-loop thermostat decisions.
Finite-path feasibility is a numerical replay statistic, not a universal
physical guarantee. Existing execution safety remains authoritative.

When capture-time neighbour readings are late, starting-state reconstruction
uses the frozen indoor observations and keyed receiving models. A matching
native interval supplies its measured mean directly. Otherwise native means
condition indoor endpoint estimates, with no unknown heater, stored-heat, solar
or positive-background credit. A cooling envelope over the transitive incoming
component advances those conditional anchors across the actual missing span.
Internal exchange redistributes indoor warmth; it is not an additional outdoor
loss. Only observed historical weather and the current nowcast enter that
reconstruction, never colder future forecast slots or disconnected rooms.
Asynchronous anchors remain conditional effective-model estimates, not absolute
confidence bounds over stochastic disturbances. The same frozen boundary basis
is used in staged and full capture. Estimates retain their late/missing-data
diagnostics and are recomputed when observations arrive, without a refit or
persisting inferred temperatures as measurements.

Observed passive rooms, and controlled rooms with no identified heater response,
can supply a passive receiving equation. An unidentifiable gain is represented
by `heater: null`, without inventing a gain. Only measured heater support permits
modeled preheating. When that support exists but actuator facts are incomplete,
the room keeps literal comfort commands. Its available heaters' empirical watts
drive the same weather-dependent gain and delayed heat store in each proposal and
joint forecast. Retained switch commands fix relay draw. Unavailable actuators
retain their empirical electrical demand and receive no additional heat credit.
An observed thermostat in Off mode retains its sensor, target and hardware limits.
Its latch starts idle. A reviewed heating setpoint with a Controlling or
Control Verification owner can schedule future heat when the thermostat
advertises Heat and Off. Verification forecasts the physical Controlling path
without sending commands. Other Off thermostats keep hardware-rounded literal
targets and empirical electrical demand. Their forecasts omit new powered heat.
The electrical service counts each empirical watt once. When heater support is
insufficient, peers use a conditional passive projection with a diagnostic, and
the empirical room publishes no temperature forecast. Unobserved candidate sources
are reported as unresolved evidence rather than fitted zero coefficients.
Physical observation-only configuration is separate from a fitted passive shape.
If the independently qualified training prefix predates identifiable heater
operation, peer contrasts or variation in observed solar forcing, the learner
reconsiders those terms using the full
qualified causal basis. A newly identifiable shape is fitted on that full basis
and explicitly reports unavailable holdout validation; its already-used tail is
never presented as independent validation. The existing measured heating support
requirements still apply even when a positive response can be fitted. Only
intervals accepted by the final observation filter count toward support. The
heater needs at least 24 such hours with known heating direction and measured
power above 50 W.

The native room search remains an ordered conditional proposal engine. After
each proposal the full affected network is replayed from the same captured
origin, including retained commands, actuator latches and delayed heat. The
accepted result replaces all affected thermostat powers and temperatures, not
just the currently proposed room. Capacity, prior-room comfort and the existing
literal deadline/cost comparator are checked on those coupled consequences.
An affected component that cannot be modeled retains empirical comfort/demand
with a visible diagnostic; unrelated household services keep planning.

Source correction and source-freshness qualification can alter an old numerical
prefix. Derived state therefore uses the complete qualified capture, with
bounded source, qualification and numerical stages in the existing planning
job. It does not certify a posterior from raw timestamps alone. Completed
execution arguments contain the derived network and posterior so replay does
not require live observations. When the admission already contains the completed
network and has no source-capture descriptor, the fenced worker requests that SQL
freeze the stored admission directly. SQL keeps its exact JSON text and verifies
the capture phase and fences before advancing the execution cursor. The worker
checkpoints only the resolved trajectory counts at solve. After assembly, a
separate owned worker hashes the frozen snapshot with the replay serializer
and seals its SHA-256 under the live job fence and execution cursor. Ingestion
loads the assembled result, sealed hash and operational snapshot. Publication
checks the current and run hashes against that seal and selects the frozen
execution by the ready job and fence. The public current snapshot carries
all operational fields. The private current-input archive additionally owns
`room_network` and its numerical evidence. The public input hash identifies the
full archived snapshot and both download paths use that archive.

Heating-band learning jointly represents positive, persistent unexplained heat
in each response family's interval-mean coordinates. This is statistical
attribution, not a measured fireplace input or an inferred observed HVAC mode.
A source-qualified, dated operating fact can identify heating/off/fan history
without changing its raw mode flag. Missing electrical observations stay missing.
Clock-time persistence, kernel-scaled forcing and interval-specific noise preserve
native hourly and quarter-hour observations. Penalized observed marginal
likelihood selects the response; chronological prediction remains a diagnostic.
A proper scaled inverse-chi-squared variance prior with one degree of freedom
prevents the mixture's unbounded zero-noise likelihood. Its empirical reference
is the pooled mean-square observed temperature change, fixed per band and
training/full partition across every response family and lag. This reference
measures total observed variation, not sensor precision. The same regularization
and noise classes apply to the Gaussian baseline and additional-heat model.
The planner receives the fitted heater response and never assumes future
unmetered heat. Published evidence contains aggregates; interval attribution
traces are ephemeral diagnostic output. Bounded numerical iterations share the
room's existing immutable capture, lease fence and atomic publication.

Chronological likelihood uses the learned episode-entry distribution, advanced
over the unscored prefix and scoring-mask gaps in native clock time. A scoring
mask is not a new physical episode, and a residual used to infer heater storage
cannot also condition the hidden-heat score. Evidence names this diagnostic
policy as `validation_initial: learned_episode_elapsed_v1`; older unversioned
likelihoods used a stationary prior and are not the same validation experiment.
This diagnostic correction does not change physical fitting or marginal-BIC
selection and does not invalidate completed numerical fits.

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
Each fixed 5°C heating band has one active revision per room or device. A
quarter's forecast selects that revision throughout its nominal interval;
observed temperature bounds describe evidence and extrapolation diagnostics,
not additional model-selection boundaries. Superseded accepted revisions stay
in the independent calibration archive. Database constraints reject duplicate
active bands rather than rewriting a publication after its fence and evidence
were checked. General responses and qualified cold extrapolation remain
separate from nominal band selection.
Room learning admits one worker invocation per home, with a fair turn between
ready rooms. A successful band publication continues the same fenced job when
ready seasonal windows remain; a new planning request is not required. The
database fixes `room_history_to` once per room generation. Both its history
ceiling and 30-day floor remain fixed across claims, retries and continuations;
newer measurements stay stored for the next ordinary refit. Whole native
intervals must end within that scope. Corrections and late arrivals inside the
scope still qualify normally. Audit timestamps, solar retry readiness and
leases use the current wall clock. Migration preserves in-flight captures and
their numerical prefixes; this scope never restricts uploads or live planning.
The 30-day fitting window applies to every room, including observed neighbours;
older source archives remain stored but do not enter a new room fit.
The
worker releases its home reservation before the next window can be claimed,
and lease expiry recovers a terminated continuation. Its separate reservation survives source changes that invalidate
the ordinary job lease while an older history query is still running. The worker
releases that reservation on exit; lease expiry recovers a terminated worker.
Native history chunks are read sequentially within the admitted invocation.
This bounds a household's learning fan-out without changing observation
qualification, publication, planning or execution. Pool and device owners keep
their independent admission behavior.
The private room job also records visited seasonal windows for the current
source binding and learning implementation. Capturing a window records a visit;
discarding superseded numerical scratch does not erase it. Scheduling combines
these visits with published attempt times so changing recent history cannot
continually preempt other seasons. Visits never count as completed fits or
advance accepted-model evidence. Band-only publication preserves the separate
general model's parameters, rejection reason and sample count.
An absent pool hardware epoch does not make a fresh fit due. Database contracts
exercise SQL NULL semantics alongside daily, method-change and hardware-change
triggers so repeated telemetry cannot silently bypass the calibration cadence.

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

That capability is each pool device's `active_power_w`: the greatest draw the
home has recorded, a safety bound. It is not what the equipment draws while it
runs. The expected draw (user requirement, 15 November 2026) is the pool
learner's operating point for the power settings the home reports at capture,
joined at admission as `pool_model.operating_draw`. It sets the forecast
electricity and, through the fitted heat per kWh, the temperature projection.
The published heater then carries the bound as a separate `reservation`, which
native admission fits under the import limit; energy, cost and heat never read
it, and a measured draw can raise it but never lower it. With no point for the
present settings (never observed running, or a home that does not report its
settings) the bound stands in for the expected draw as before, which can only
overstate it, and a home that reports settings gets the routine
`pool_draw_estimated` note. A setting that cannot be read at capture takes the
point most recently observed and says so the same way.
When pool rescheduling is unavailable, accepted ON intervals retain full draw
and accepted OFF intervals remain OFF. The retained schedule covers its actual
UTC intervals only and retains its accepted thermostat target. Uncovered
intervals carry explicit null permission, no commanded watts and measured
passive demand; the consumer holds existing settings before intent encoding or
verification. Forecast watts cannot grant permission or trigger a failed-command
replan. No future thermostat duty fraction or thermal trajectory is invented.
Missing observations affect reconstructed response memory, not the retained
calibration parameters or measured water temperature. Compressor energy that is
late or missing is bounded, never assumed idle and never a reason to retain
instead of reschedule: unmetered time adds no in-flight heat (a lower bound) and
advances source depletion at the supported ON draw (an upper bound), and both
bounds hold through the observed intervals that follow. The newest quarters still
arriving are a routine note; a quarter the uploader has passed is a warning. Only
a state that cannot be bounded (a malformed model, or a source heater with no
known ON draw) retains accepted instructions. The ON draw bound is the highest
measured operating point, not the selected setting. A capture older than both
fitted checkpoints starts a day earlier from the bounded state (no in-flight
heat, the most depletion that draw can sustain) and replays observed energy
from there. A later complete capture replays the
observed energy exactly and resumes thermal scheduling without relearning. Rooms
with delayed heat treat unreported heat as none and report it the same way. One pool-owned operational
note explains an unsuccessful reschedule; member devices do not duplicate it.

Operating points are learned for every variable-power device and planned on
for the pool (above). Every variable-power device
(a heat pump's output, a pump's capacity, a charger's current) sends with each
quarter the setting that held throughout it: a pool device the Power setting it
names, any other its own power or current control. A device that names a heat
meter sends its metered heat. Both are read in Home Assistant and never written.
The pool's members are one learning owner, keyed by every member's setting,
because they change one another's efficiency. Every other variable-power device
is a `device` owner of its own, with the same daily cadence, lease, fence and
revision as a room or the pool. Draw is learned from quarters inside a run in
which every setting held; heat per kWh from whole sessions at one combination,
with the heat that arrives after them. Each refit recomputes the points from
the stored quarters over 90 days (the pool's clamped to its heat-pump epoch). A
quarter next to a missing one is not steady, and a session next to one, with
heat still arriving, or with a setting that changed or was unknown is left out
of the COP and counted, never read as idle; a later refit includes it once its
quarters arrive. A quarter says only what was read: a setting or heating
activity that was read and absent is stored as none, and one that could not be
read leaves the stored quarter untouched, so the routine re-sweep of recent
quarters cannot erase an earlier observation. Points for devices outside the
pool are not read by the planner yet.

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
- **POOL-2:** losing thermal evidence retains accepted ON/OFF instructions
  without extending them into uncovered intervals. Retained ON permission still
  reserves full equipment draw; a measured average never grants permission.
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

On 25 October 2026 the user explicitly approved the two-contract transition
from missing-model all-ON permissions to accepted-schedule retention.
`scripts/planner-contract-transitions.json` names the exact before/after commits
and the two reviewed tests (POOL-2 and POOL-4's missing-model setup). The runner
replaces only the matching historical test body with that immutable approved
body. It rejects approval pairs that also change other assertions or helpers.
Every other historical assertion still runs, and later edits to today's tests
cannot change the approved bodies. No baseline, CI job or test is skipped.

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

## Durable planning recovery

Planning exchange 3 retains the captured input through recoverable worker,
transport and storage failures. Each attempt keeps its home/head revision and
lease fence. Storage records the last failure, releases that attempt's lease and
sets the next due time with 5–60 second backoff; a repeated failure does not impose
a lifetime attempt limit. Claims enforce the due time. Expired leases can be
reclaimed, and a stale fence cannot publish, fail or reschedule its successor.
Input, identity, authentication and configuration errors remain distinct terminal
outcomes. Unexpected internal failures are reported as internal failures, never
as malformed user snapshots.

An incompatible planner capture fails with `planner_upgraded`; a capture whose
actual final slot has ended fails with `capture_horizon_ended`. Horizon checks
run before solving and before publication, and introduce no source-age or capture-age
cutoff. Only while that
job remains the current home/head/reference does its receipt carry
`recapture.replaces_job_id`. A fresh snapshot presents that value as
`replaces_job_id`. The backend checks its original planning purpose before
preparation and again under the admission lock. Manual request identity and the
accepted reference remain exact; execution changes are validated against that
reference using current owner evidence. A newer head, manual request or fixed
revision revokes the authority. This is a fresh capture, never execution of an
old protocol or a household-wide hold release. Receipt identity deduplication
precedes the spent-ticket check, so a lost replacement response remains recoverable.

The HA producer persists the exact credential-free outgoing envelope before
sending it. A lost pre-admission response is resolved by receipt lookup and,
when absent, retransmission of that same envelope. Plan acknowledgements are
independent durable delivery work. Neither a successful telemetry upload nor
cloud publication proves that HA accepted the plan. All exchanges use version 3;
server and producer roll forward together without an alternate execution path.

## Observation semantics and integration qualification

Home Assistant reports quarter-average room temperatures, not interval-start
samples. The room learner uses an integrated mean observation operator, including
both adjacent quarters' heater energy, and compares candidate heating delays on
chronologically held-out measured transitions. Twelve-hour prediction error
remains a reported diagnostic. It cannot alone select a model that fits passive
background drift while explaining measured heater response poorly. Missing meter
coverage remains unknown; only complete measured zero energy is an OFF sample.
A changed learner method causes one new attempt, then the existing per-room
cadence resumes. There is no weak-gain floor or new heater shutoff policy.

Recorder-mean room learning fits internal house exchange and outdoor exchange
together, with a nonnegative solar term when irradiance is observed. It searches
total exchange and solves the internal/external split as a bounded linear
coefficient; zero is an empirical physical limit, not a forced positive floor.
Both boundary temperatures are required to identify the joint model. Missing
evidence or an unidentifiable split records a failed attempt while the existing
model and planning continuity remain available. The observation/selection method
identity is separate from the exchange-family identity, which requests one new
fit on rollout and then resumes the existing per-room cadence.

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
Construction proposals and their candidate transitions use the same
construction-owned physical projector and identical pool conditions. This avoids
recomputing source recovery while proposing intermediate EV currents. Exact
action-boundary tests and complete native-output comparisons preserve candidate
order, work counters and scores; final certification still uses the direct model.
Pool calibration prepares each candidate's fixed observation coefficients once
and shares the identical constant-family search prefix when comparing families.
The candidate grid, chronological validation, selection and diagnostics remain
unchanged; complete-fit parity and the existing CPU budget guard this reuse.

Pool source projections also prepare the fixed-duration observation weights once
per candidate and evaluate them in the original arithmetic order. Qualification
exercises the entire cold learning handler, including paginated history decoding,
candidate selection and model publication into an inert database adapter. Its
independently generated 21-day history uses an RK4 plant, not the production
kernel, so generating the fixture cannot warm the code being measured.
Before TEST runtime deployment, an authenticated TEST-only diagnostic runs that
same handler with inert captured responses and compares the complete publication
against local execution. Selected parameters, state and selection scores must
match exactly. Only the documented profile diagnostics allow two floating-point
ULPs across runtimes; rejection tests enforce that narrow exception. Repeated
execution on one runtime must retain the exact publication hash. The diagnostic
cannot publish models or operate devices. The
first request follows diagnostic deployment; repeated requests additionally check
determinism. A successful retry does not excuse a failed hosted qualification.

### Accepted command ownership

Publication and local acceptance have separate owners. The private command
publication store projects exact commands from server-generated plans, retaining
publication identity and accepted/rejected acknowledgement facts. The current
home row keeps durable copies of independently accepted household and battery
references. A household ACK never asserts battery handover; the battery's exact
runtime contract identity advances only its own reference. Delayed known ACKs
are idempotent, acceptance remains sticky, and older publications cannot regress
accepted ownership. Diagnostic source timestamps do not order ownership.

Live admission captures both references and their monotonic ownership revision.
The existing current-publication, fixed-plan and request fences remain in force.
Ownership changes invalidate immutable work with `accepted_reference_changed`
and a same-purpose recapture directive. A definite pre-admission race instead
returns HTTP 409 with that code and `details.recapture: true`; the producer first
looks up the exact old snapshot, then captures anew only after absence is proven.
An ownership-change ticket permits current accepted identity/evidence while
retaining the original manual and execution purpose.

Commitments select source by owner and absolute UTC interval: household Q for
EV, pool and devices, independent B for battery. Neither is truncated to a newer
unaccepted publication P. Missing owner coverage is an absent hold, never an OFF
command inherited from another owner. Pure callers supplying one explicitly
accepted reference still mean all its owners share that reference; live captures
always supply the independent battery reference explicitly. Old durable jobs
without the ownership fence recapture rather than inheriting that convention.

Inactive candidate slot arrays may be cleared only after their actual final
interval ends; identity/ACK facts and durable accepted copies survive. Migration
uses exact current or provable historical server references. Missing accepted
provenance remains explicit and never becomes an implicit release of holds.

## One shared room response (23 November 2026)

A room has one published response, fitted across every outdoor temperature:
a constant heater gain (°C per kWh delivered) and one loss model whose cooling
falls as it gets warmer outside. The planner uses that response at every
quarter; the quarter's forecast outdoor temperature is an input to it, never a
model selector. Rooms no longer select a response per 5 °C band, and there is
no response switching or memory conversion between quarters.

Room learning now captures chronological source evidence instead of outdoor-band
windows or a 24-run working set. The fenced learning owner refreshes at most ten
days of source-qualified native rows per request. Private compressed blocks keep
probe/source facts and explicit missing measurements; an empty block records an
empty range. Uploads journal material changes, including shared household probe
inputs, rather than running regression before the evidence is qualified. Each archive
checkpoint resumes the private job without revising the accepted model or
invalidating planning captures. Ordinary
retention is marked separately from a retraction and preserves the source side of
an active archive seam.

The complete pinned horizon supplies every eligible interval transition, including
idle stretches and unfinished heating events. Freshness is evaluated over that
horizon, and independently over the chronological training prefix. Training and
full fits also choose their own solar coverage. The immutable numerical capture
retains full-view observations and sparse training-only qualification differences;
neither source estimates nor inferred nuisance heat become measured history.

The existing interval-mean equations, continuous exchange profile, lag grid and
ordered unexplained-heat HMM remain the statistical model. Their Gaussian physical
regression already compresses a fixed feature basis before exchange is applied;
a decay grid is unnecessary. Equal additive regression statistics can have
different ordered HMM likelihoods, so sums alone cannot replace the source rows.
A corrected heater reading also changes subsequent carried heat within its real
contiguous segment. The new path makes acquisition incremental while preserving
exact ordered replay; it does not claim a constant-time fit.

One staged fit advances eighteen training/full cells under the existing numerical
budget. Publication certifies identified transition support and positive residual
degrees of freedom under `shared_interval_transitions_v1`. Complete runs are
assessed against the final response for charts; their count, individual noise or
agreement with peers cannot reject a valid aggregate response. Assessments are
stored and paged by published revision, separately from the compact planning
model. A shared response with no complete heating event can still be identified.

Completion fences owner, binding, model revision and authoritative source policy.
The final evidence manifest supplies the observation revision and a deterministic
policy fingerprint from the same database snapshot. Initial checkpoint and final
publication compare policy after acquiring the job, model and evidence-clock
locks. Reviewed source assignments, relevant meter exclusions and dated customer
assertions remain authoritative. Automatic source-capability facts, weather and
meter or sensor backfill are observations: they cannot cancel an immutable fit.
Its coefficients describe the dataset actually captured, with that evidence basis
retained on the accepted reference as well as the latest attempt. A subsequent
unidentified attempt retains the prior reference's original provenance.

Observation corrections stay in the durable journal and refresh their affected
blocks on the next ordinary learning admission (24 hours for a trained room,
one hour otherwise, when planning next requests learning). Publication does not
immediately enqueue another whole-history replay. This coalesces continuously late
quarters and historical backfill without an endless series of fits. Explicit
customer/source reviews still wake learning; ordinary source-capability telemetry
does not bypass its cadence. Successful publication replaces
`heating_bands.reference` with scope `shared` and empties the old bands. Old
accepted model records remain readable during rollout, but the retired band/run
sampler does not run.

A numerical callback uses the claim's SQL-validated binding and base revision,
then repeats the publication CAS. It does not download the household calibration
bundle or rediscover room context. HMM posterior reuse is local to one request;
fixed two-state loops preserve arithmetic order and public numerical results.
Cold initial and resumed full-history requests share the unchanged CPU gate.

Existing version-four capsules acquire their policy certificate inside the
Supabase worker during rollout. The worker checks surviving source-policy
history, immutable customer assertions, whole-interval operation-fact identities
and current exclusions against the decoded capsule. An uncertain capsule resets
once. A valid certificate is written under the same ownership and policy CAS,
without changing captured measurements or earned cells. No household capture
needs to be exported and no manual completion step remains.

During rollout a room without a shared response keeps its previously accepted
response for the whole forecast (the recent general response, else the band
covering the median forecast temperature) with a routine learning note. A
failed shared attempt keeps the accepted response. Device electrical draw keeps
its own weather bands.

## Independently fitted room response families

The 19 November 2026 requirement publishes the response selected by the learner:
finite exchange, exact zero-exchange integrator, or algebraic equilibrium. Each
band keeps its own family coefficients, lag, revision and selected-family evidence.
An integrator has no finite time constant. Equilibrium identifies °C/W heater
response and boundary shares, not a dynamic °C/Wh gain or heat capacity. The
existing untagged finite record remains the finite storage shape; new fits name
their family explicitly. Zero fitted limiting response is retained as evidence,
not changed to a positive gain or rejected by an invented floor.

The thermal owner compiles all families to affine transitions. Dynamic-to-dynamic
bands retain the existing conserved temperature-equivalent stored heat. Entering
or leaving equilibrium converts through delivered heater watts: dynamic state
scale is gain × lag; equilibrium scale is steady heater response. The conversion
occurs once per positive-duration interval, never per thermostat minute. An
immediate response has no delayed state. Rust receives the conversion and compiled
transitions, not fitting policy. Missing history still supplies bounded stored
warmth, and family changes do not drop the room service.

Solar repair seeks missing, source-qualified observation ranges using an index.
Thermal evidence corrections do not invalidate completed solar coverage. A bounded
pass advances through later gaps; unavailable provider hours remain missing and
retry at the existing daily learning cadence. They do not keep completed numeric
refits immediately runnable, and new thermal evidence cannot slide the retry date.

## Counter-processing authority at ingestion

Heating observation captures name their counter-processing revision independently
of the app release and the physical source identity. The SQL ingestion owner
keeps a monotonic watermark per home, device and physical statistic. Source-qualified
uploads lock those meter rows in deterministic order before merging any energy,
withdrawals or attribution. A lower-revision upload acknowledges its intervals and
may update independent temperatures/solar, but cannot change protected meter facts.
The guard runs before both thermal and electrical withdrawals. Same-revision and
newer corrected measurements can recover unknown intervals. An unavailable reading
remains unknown; no energy is inferred by this authority rule.

The watermark covers the counter's whole retained history, including other native
resolutions and intervals without stored rows. It survives observation pruning;
there is one small record per physical meter, rather than per historical interval.
Omitted revision denotes the pre-revision producer contract. Malformed explicit
claims fail validation. A collector algorithm change increments the processing
revision and changes its replay signature; replay, rather than model editing,
repairs the measured inputs and ordinary learning updates the affected bands.

A reviewed faulty physical meter is a separate input-quality fact: a newer
producer cannot make that meter reliable merely by reporting a higher processing
revision. Dated meter exclusions are enforced at canonical thermal and electrical
learning reads, preserving raw audit values and temperature observations while
making the heater energy unknown. Dated source lineage resolves legacy electrical
samples; today's meter must not be projected backwards across a replacement.

Changing a reviewed exclusion withdraws active calibrations whose training spans
intersect that source period, and queues ordinary refitting for the affected
owners. General responses with clean training spans remain available, and archived
revision records are preserved. This is a source reliability decision supported by
the customer's evidence, not a fitted-error threshold or numerical energy cap.

## Shared-room proposal qualification

The native room scheduler generates one proposal and replays literal scheduled
targets with the existing minute actuator kernel. Fixed room targets, native
targets and switch commands constrain both schedules identically. Both start
with the measured room temperature, HVAC latches and stored heat. Weather-band
transitions and supported running draw remain the captured physical basis.

The solver compares total priced electricity, including solar opportunity cost,
and degree-hours below literal scheduled targets as separate quantities.
A proposal with more shortfall yields to the literal schedule. A proposal that
costs more is kept only when it is short in no quarter the literal schedule
meets and meets at least one quarter the literal schedule misses, such as
preheating for a comfort deadline.
The selected schedule supplies commands, member power and room temperature
together. This requires one forward projection in addition to the existing
search. Model fitting and statistical qualification stay in the room learner.

This comparison currently uses the published response. It does not establish
that its temperature or consumption forecasts are accurate. Sparse fitted
responses continue through the existing measured-demand path. Chronological
heater-off and pulse validation, uncertainty publication and commissioning
demand evidence remain separate work in the model owner.

## Measured room runs

`device-learning/room/run-measurements.ts` owns run identity and the native-mean
measurements: onset to peak rise per delivered kWh, matching outdoor exposure,
and the signed fall rate in a post-peak off window. Unknown meter coverage is
never an off observation. `measured-lines.ts` owns the robust lines and residual
assessments. Heating and cooling are separate measures with separate
populations: heating points are weighted by their delivered energy, cooling
points by their own heater-off window, and neither measure's weight, residual or
flag depends on the other. Heating lines rise or stay flat with outdoor
temperature; positive fall-rate lines fall or stay flat. Each point is flagged
against the published line of its own measure, the line its chart draws, when
it lies more than three robust scales from it. A flag reports which side of
that line the point occupies, not its unobserved cause. Flags do not remove
points from learning. Room/house reference corrections use identified
exchange coefficients and are separate from the raw points.

User requirement, 25 November 2026: stop calibrating heater gain against a
hindsight peak, and use the whole measured cooling trajectory. This supersedes
the 24 November summary-point calibration. `measured-calibration.ts` fits one
immediate physical response from adjacent native interval means and their actual
metered input. Its nonnegative outdoor and house exchange coefficients produce
slower cooling as temperature differences shrink. Signed background and a
nonnegative, nondecreasing weather-dependent heater gain are fitted jointly;
even an OFF-class interval retains its measured standby watts. The exact
interval-mean kernels handle hourly and quarter-hour observations without
inventing boundary temperatures. No peak or settling window determines heater
attribution. The plotted onset-to-peak points and short cooling summaries remain
descriptive measurements with their existing independent lines and flags.

Input-defined operation spans include an observed ON fragment and its entire
known-input coast. Each span's powered and coast phases is weighted by the
span's measured ON energy, with native duration weights within each phase, so a
long passive season cannot drown the powered observations. Phase denominators
are computed before thermometer eligibility; missing readings remove weight
without concentrating it into the remaining equations. Passive history without
an observed ON anchor remains in the archive and chronological diagnostic.

The fit uses scaled QR and robust reweighting with positive weight for every
usable operation pair. Missing input, direction, temperature or adjacency
removes only the affected equation; an unfinished run and a partial coast remain
usable. Rank and residual degrees of freedom establish identification without
forecast-error or missing-data thresholds. Separate evidence records fit status,
calibration support and conditional residuals, including warming just after
switch-off and the reference watts of excluded positive background.
There is no solar term or delay, and a positive constant receives no future
planning credit. Hold-out validation uses a separately fitted training prefix.
Where the interval calibration cannot form a response, the existing chronological
fit below keeps the room planned. Its model and validation remain in evidence.
Scheduled electricity and metered electricity are comparable only alongside
achieved comfort: no heating while a room misses its requested target is not a
measurement of the electricity required to meet that target. An unheated holdout
tests passive temperature prediction, not heater gain. A zero-lag response also
cannot identify every delayed heater's intrinsic gain from these measurements.

User requirement, 24 November 2026: a changed room learner refits every room
before it plans. The learner's version follows its compiled pure mathematics,
transitive runtime dependencies and source qualification policy
(`scripts/room-learner-version.ts`, checked by `tests/room-learner-version.test.ts`;
run `deno task generate:room-learner-version` after a learner change). HTTP,
database scheduling and logging edits preserve compatible numerical progress.
The semantic manifest's initial identity retains the deployed learner ID; later
semantic changes generate a new ID automatically. Each fit
records the version that made it. An upload requests a refit for any room fitted
by another version, and so does the replan button, which then holds the request
back from Home Assistant while room learning is pending, for at most 20 minutes.
Home Assistant answers each request once, so it must not see the request before
the refits finish. The portal's replan button reads `get_energy_replan_progress`
and names the stage in one word: refitting, measuring or planning.

The database owns the active learner release. Deployment prepares an ordered
release, deploys the worker, verifies its authenticated capabilities and activates
that exact release with a predecessor comparison. A stale deployment or snapshot
cannot downgrade the target. An incompatible release advances pending owner
generations once; compatible releases retain capture bytes and numerical cursors.
Already accepted models and instructions remain available throughout refitting.

Room fitting uses two project-wide tickets, including queued and running work.
Distinct owners with immutable captures can fit concurrently; an individual
owner's arithmetic, random stream and reduction order stay sequential. Source
history reads and finalization share one heavy-work admission per home. Invalid
numerical scratch yields before source reacquisition. Duplicate wakes coalesce,
releases match the original generation/fence, and expired tickets recover through
the durable sweeper. Non-room device and pool learning retain their own paths.
Every handled fitting slice logs its work class, outcome and stage timings;
transport metrics include the worker's actual database requests.

The descriptive lines do not identify the floor's entry storage or intrinsic
heater gain. `measured-response.ts` therefore also fits the supporting chronological
native interval means with the exact mean-pair equations, profiled nonnegative
entry storage and robust run-energy weights. It compares constant and outdoor-
dependent heater gain in the finite, integrator and equilibrium response
families. The chronological training prefix selects the response against later
open-loop observations; full evidence supplies the published parameters. Rank
and residual degrees of freedom establish support, without a three-agreeing-run
rule. Completed events supply chart measurements; unfinished known-input
trajectories remain physical fitting evidence.

The planner reads the accepted `measured_room_runs_v1` response through
`planner/room-response.ts`. A relative outdoor gain slope applies to electricity
when it enters the delayed state. Changes in weather never rescale already
stored heat. Unknown outdoor history for a varying gain contributes the useful-
heat lower bound; a missing room thermometer never erases independently measured
electricity. Positive uncontrolled fitted heat receives no future planning
credit. The exact affine transition remains the TypeScript/Rust boundary.

The durable worker retains the chronological source archive and its correction
policy. Numerical envelope 5 replaces only fitting scratch state. Checkpointed
lag/family/weather/partition cells replace the latent episode search. Publication
retains binding, source-policy, owner-generation, fence and model-revision checks.
A failed attempt retains the accepted model and its ledger, with attempted
measurements stored under a separate page identity. Existing accepted policies
remain readable only for continuity until a replacement publishes.

The interval calibration runs during finalization and does not change the 108
diagnostic cells. The CPU gate measures the complete cold finalization request
over the 30-day fitting window, including decoding, full and training fits,
holdout comparisons, ledger construction and publication serialization, under
the existing budget. Source decoding retains its larger 400-day stress fixture;
only its last 30 days may enter the numerical checkpoint.

The Model tab reads canonical points, curves, room-reference corrections and
revision-scoped paginated assessments. It does no browser fitting. Actual cooling
rates are labelled in °C/h; temperature prediction error is labelled as mean
absolute prediction error in °C. Private measured validation stays outside the
public repository; regression fixtures are independently generated synthetic
plants.

## Heat-pump start-up model (24 November 2026)

User requirement, 24 November 2026: a room heater set up as an inverter load is
a modulating heat pump, and its start-up peak must be learned so starts can be
planned within the house limit. On a cold day an air-to-air heat pump can draw
several times its running power while it recovers from standing idle, and the
weather draw model above shows only the median running draw.

Home Assistant sends each heat pump's highest power reading beside the energy
of every native heating interval: the highest of three five-minute maxima for a
quarter, the hourly maximum for an old hour, and nothing when the maxima do not
cover the interval. Peaks are stored in `private.energy_heating_power_peaks`,
apart from room evidence, so they never advance a room's learning clock. Ingest
answers `heating_power_peaks_supported`; only after that does the app send peaks,
and a home with a heat pump then re-sends its retained history once to fill them
in, so the re-send is never spent on a server that would drop them.

`device-learning/heat-pump-startup.ts` assembles hours from four complete
quarters or one native hour. Quarters stored before peaks were sent take the
peak of the same hour when it arrives again as a native hour from older Recorder
statistics; complete quarter peaks are finer and win. An hour averaging under 100 W is standby; a running
hour after a standby hour is a start, and the two hours after it are its
recovery. A missing or cooling hour is unknown, never standby, and the hours
after it count as running only once a start inside it could no longer be
recovering. Per 5 °C outdoor band it publishes the median and highest start
peak, the start hour's draw, the recovery hours' draw and peaks, and the steady
running draw and highest running peak, defrosts included. The model check fits
the same method on everything before the last 14 days and predicts those days'
running hours from when the unit actually started and the outdoor temperature.
It reports the mean hourly error and bias and how many measured peaks stayed
within the predicted highest.

The model is recomputed by the device's daily weather-draw refit and stored as
`operating_points.heat_pump`. It does not enter the planning snapshot, and the
planner does not read it yet. A failed read keeps the previous model and never
holds back the draw refit. Device-key indexing keeps its history read out of
unrelated rooms' observations. Publication of a draw with
`heat_pump_startup_unavailable` leaves the same fenced learning job pending; the
existing durable sweep retries it after five minutes, and only a complete fit
finishes the job. Deployment also requeues completed partial fits for active
heat pumps. Heat or cool mode is unknown for most old hourly
history, so summer cooling still appears in the warm bands.

