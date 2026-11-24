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
| `device-learning/linear-algebra.ts` | Numerical equation solving | Room or pool policy |
| `planner/models/room/thermal.ts` | Room thermal response and delayed heat | Regression, prices, scheduling |
| `planner/models/pool/state.ts` | Reconstruction of thermal memory from actual compressor energy | Parameter fitting or releasing commitments |
| `planner/models/pool/electrical.ts` | Expected compressor and auxiliary draw from the learned operating point, and the separate ON reservation, from equipment evidence | Thermal gain, comfort targets or statistical fit quality |
| Rust `models/{battery,ev,pool,room}` | Pure device transitions and actuator simulation | Tariffs, policy, database or search |
| Rust `solver/{policy,room_policy}` | Existing economic/comfort preferences | Learning or physical response coefficients |
| Rust `solver/room_heating` | Bellman search, action enumeration and memoization | Its own copy of thermostat physics |
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
ceiling and 400-day floor remain fixed across claims, retries and continuations;
newer measurements stay stored for the next ordinary refit. Whole native
intervals must end within that scope. Corrections and late arrivals inside the
scope still qualify normally. Audit timestamps, solar retry readiness and
leases use the current wall clock. Migration preserves in-flight captures and
their numerical prefixes; this scope never restricts uploads or live planning.
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

User requirement, 24 November 2026: the planner plans each room from its
measured runs, because they stay sane on sparse data. Heater-off loss is fitted
to the cooling points as outdoor loss times (room − outdoor), plus rest-of-home
exchange times (room − home), minus a constant term, weighted by measured hours
with nonnegative couplings. Each heating point's net rise per kWh gets the loss
during its own run added back once, and the heater gain line (with its outdoor
slope) is fitted to those values, weighted by energy. There is no solar term or
delay, and a positive constant receives no future credit. On 30 days of metered
room energy this matched the meter far better than the net rise line alone,
which counted losses twice, or the chronological fit. Hold-out validation
describes this response, fitted on the training prefix. Where the cooling or
heating points cannot form it, the chronological fit below keeps the room
planned. The chronological fit and its validation stay in the learning evidence
either way.

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

The Model tab reads canonical points, curves, room-reference corrections and
revision-scoped paginated assessments. It does no browser fitting. Actual cooling
rates are labelled in °C/h; temperature prediction error is labelled as mean
absolute prediction error in °C. Private measured validation stays outside the
public repository; regression fixtures are independently generated synthetic
plants.
