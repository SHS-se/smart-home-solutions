# Planner redesign, September 2026: pool, EV and battery around cheap published prices

Status: agreed design, 2026-09-28. Implementation spec.

This design came out of two independent architecture rounds (Claude Opus and Codex gpt-6-astra) and replay experiments on production captures. Phil settled the open questions. The spec is binding where it states a decision.

Related documents:
- [Decision register](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md)
- [Constraint requirements](constraint-requirements.md): no invented validity constraints
- [Authoritative plan contract](authoritative-plan-contract.md)
- [Controller policy: EV desired schedule](controller-policy.md#ev-desired-schedule-execution-and-future-notifications)

## 1. Goals

1. **Fill the big loads in cheap published stretches.** The big loads are pool heating, EV charging and the home battery. All-in import has a floor of about 0.80 SEK/kWh, and runs of 1.0–1.2 are common. Outside summer these may be the best hours for days. Cheap and dear regimes last for days; for example, 6–10 Aug averaged 0.87–0.94 while 23–26 Sep averaged 2.5–3.2.
2. **Hold the comfort points.** Keep the pool around **30 °C** and the car at **≥ 300 km** at normal prices. Fill above them when prices are cheap. Let them dip only when prices stay unusually dear.
3. **One long pool run instead of fragments.** A replan must never cut a running pool without a real saving.
4. **Keep the EV planned when unplugged.** An unplugged car must never take executable energy from loads that can run now.
5. **Stop battery under-charging in autumn.** Make base load weather-aware, and feed monitored devices to the planner.
6. **Spread loads where it is cheap to do so, and be ready for a power tariff (effektavgift).** None applies now; one returns next year.
7. **Keep long-term 15-minute energy, temperature and price history.** Store nothing finer.

## 2. Settled decisions (Phil, 2026-09-28)

| # | Decision |
|---|---|
| S1 | The EV is planned whether plugged in or not. The plan keeps a *desired, conditional* schedule; its first desired start is the hook for a future "plug the car in" notification. Notifications are out of scope. |
| S2 | When the car is plugged in, HA **executes the already-planned desired charging**. There is no automatic re-auction on cable change (plan contract: automatic bidding happens only on a price release). |
| S3 | "Comfortable" is the curve's comfortable point: **pool 30 °C, car 300 km.** The planner prices it automatically (§5.3). Automation changes the monetary scale, never the comfort points, the curve shape, the pool's Stop-at or the car's charge limit. |
| S4 | The car is a **continuous comfort store**, like the pool. There are no readiness events and no default departure time. This supersedes D2's anchored-event wording for everyday use. Dated trips can later add events on top. |
| S5 | The planner's peak-shaping term is internal, not a tariff. **Scale it down** to a spreading preference (§5.6), and build the effektavgift structure now with rate 0 so it can be switched on when the tariff returns. |
| S6 | The pool minimum run existed to stop fragmented runs and mid-run cut-offs. It may be **retired only after** its replacement (whole-run candidates, a realistic start cost, economic continuity) passes the acceptance gates. |
| S7 | Replan continuity keeps a running pool's remaining run unless stopping saves **≥ 5 SEK over the horizon**. This was shipped in d737694 and is kept, re-expressed without `minimum_run`. |

## 3. Evidence

Captures are in `~/Downloads/plan-replay-*.json`: 87 files, format `shs-energy-optimisation-quarter-replay` v2. Replays run through `generateOptimisationPlan(arguments.snapshot, new Date(arguments.now), arguments.price_archive, arguments.resolved_price_outlook)` under `deno run --config deno.json`.

Acceptance captures:

| Id | File (prefix) | What it shows |
|---|---|---|
| C-0905 | `…-2026-09-05T14-30-00…` (and siblings) | Tail below the published floor |
| C-0919 | `1d3d1b72-…-2026-09-19T13-00-00…` | Published min 0.801, **tail min 0.703**; pool 16 kWh published vs **72 kWh tail** |
| C-0920 | `efa60a79-…-2026-09-20T06-45-00…` | Published min 0.836, tail min 0.769; pool 6 kWh published vs 62 kWh tail |
| C-0924 | `991eb936-…-2026-09-24T07-45-00…` | Pool Controlling, 29.6 °C: **split runs** 11:00–12:30 and 16:15–17:15 local, battery takes the sun in between |
| C-0927 | `e828b81b-…-2026-09-27T11-00-00…` | Running pool cut at 14:15 local; **unplugged, verification-mode car given 3.45 kW of solar**; 86 kWh of pool pushed into the 29–30 Sep tail |
| C-0928a | `8ace10c1-…-2026-09-28T07-00-00…` | Pool 30.17 °C with 4 h `minimum_run` not running; nothing published; battery charges only to 39 % overnight |
| C-0928b | `2e406a5d-…-2026-09-28T22-00-00…` | After the release: no pool tonight; heating deferred into the tail |

Scratch experiments on the pre-change planner:
- **Stationary timing**, meaning pool `usage_weight = 1 − d`, `terminal = 1`:
  - C-0924: one continuous run 10:30–17:00 plus a night run, no split.
  - C-0927: 40 kWh published instead of 4.6.
  - C-0928b: tonight 22:15–03:15 plus tomorrow night.
- **Pool start cost 3 SEK** (C-0924): the auction plans **no heating at all**, and the pool drifts to 24.9 °C.
- **4 h minimum run** (C-0928a with stationary timing): same failure, drift to 25.2 °C. The auction charges a run commitment to its first quarter and never starts a clearly profitable run.
- **Held run** (C-0927): scored 2.2 SEK *better* than the auction's own proposal.

Measured facts:

| Quantity | Value | Source |
|---|---|---|
| Pool heat loss | 0.07–0.16 kW/K; seeded model is 0.35 | Unheated stretches, HA stats 20–26 Sep |
| Pool heating | ~0.16 °C/h at 12 kW thermal (~3.7 kW electric) | |
| Base load (house − hot water − pool − car) | 23–26 kWh/day on 9–25 Sep (outdoor 13–16 °C), then 32.8 (26 Sep), 38.0 (27 Sep, 11.7 °C); forecast was 24–26 | |
| Metered room heaters | Explain only about half of the step | |

Price floor, from HA `sensor.smart_home_solutions_total_import_price` daily minima since 3 Aug: 0.80–0.85.

## 4. Architecture

```
HA snapshot ──► ingest ──► freezePlanningBasis ──► snapshot.planning_basis (validated once)
                  │                ▲
                  │                └── energy_optimisation_planning_evidence (1 row/home, refreshed ≤ 1×/local day
                  │                    after delivery: regime model, water-value tables, weather-demand model,
                  │                    forecast trust, monitored-load forecasts)
                  ▼
      generateOptimisationPlan (staged, unchanged signature)
         buildDispatchStores ── valueStores(): pool/EV service + terminal curves, weights, EV branch
         planDispatch/auction ── terminal_curve, whole-run candidates, spread term, monthly-peak term
         evProjections() ──── executable / desired / achieved EV
```

- **Frozen inputs.** Everything that is not in the HA snapshot enters through `snapshot.planning_basis`, so replays stay reproducible.
- **Legacy path.** If `planning_basis` is absent, planning follows the legacy path. The floor-affine tail and the spreading-term scaling are unconditional fixes. Replay A/B: `withoutPlanningBasis(snapshot)`.

New modules, all under `supabase/functions/_shared/`, pure unless noted:

| Module | Owns |
|---|---|
| `price-regimes.ts` | Price floor per hour-of-day class, 3 daily regimes, transition matrix, floor-affine tail |
| `water-value.ts` | Single-store regime-Markov dynamic program: stationary tables, partial-day and backward passes, marginal curve extraction, policy simulation. No snapshot types. |
| `store-valuation.ts` | Pool and EV valuation: comfort-point calibration, service/terminal curves, weights, EV branch |
| `ev-projections.ts` | Executable, desired and achieved EV projections |
| `monitored-loads.ts` | Forecasts of Monitoring-role devices; heating-degree-day fits |
| `weather-demand.ts` | Weather departure added to HA base load |
| `forecast-trust.ts` | Measured tail-price premium and PV skew factor |
| `peak-policy.ts` | Spreading term plus effektavgift-ready monthly-peak cost |
| `planning-basis.ts` | Freezing, validation and fingerprints of the basis block |

Modified modules:
- `dispatch-plan.ts`: optional `terminal_curve`, split bid helpers, whole-run candidates, peak policy.
- `energy-optimisation.ts`: store construction, EV projections, plan fields.
- `energy-price-shape.ts`: excess-over-floor normalisation.
- `replan-continuity.ts`: held run without `minimum_run`.
- `energy-optimisation-ingest/index.ts`: freezing, maintenance refresh.
- Migrations.
- The HA integration, for S2 and minimum-run retirement.

## 5. Specifications

### 5.1 Pool heat loss in production (prerequisite)

The idle-stretch loss fit (`fitPoolLoss`, dev d737694) must be deployed and producing `pool_model.loss_kw_per_k` before any valuation work is judged. The valuation differs about twofold between 0.35 and 0.1 kW/K. Verify on the test deployment that `energy_optimisation_pool_model.idle_loss_kw_per_k` is populated.

*Amendment 2026-09-28.* A null `idle_loss_kw_per_k` blocks **rollout**, not implementation. Replays keep the 0.1 kW/K substitution (§7).

In step 1, read `idle_loss_rejection`, `idle_loss_hours`, `idle_loss_run_count` and `fitted_at` for the row, then act on the cause:

| Cause | Action |
|---|---|
| `insufficient_idle` with ~0 hours because the home has no `energy_optimisation_outdoor_slots` rows | Move §5.8's outdoor-observation recording and provider backfill into step 1. The fit joins water temperature against outdoor temperature and cannot run without it. |
| `fitted_at` predates the d737694 deployment | The refit interval (24 h) has not elapsed yet. Record it and re-check. |
| The test home has no pool quarters | List production verification after push as live verification. |
| `unphysical` (fitted loss ≤ 0 or ≥ 20, or non-positive exposure) | Diagnose from the rows the fit read before changing anything (below). |

Report which cause applied.

**Diagnosing `unphysical`.** For each idle run, print:
- start and end, and quarters;
- start and end water temperature, and the fall;
- Σ(water − air)·h exposure;
- mean water and mean air temperature;
- the pool devices' summed `energy_kwh` inside the run and in the 2 h before it;
- the device ids the fit resolved from the pool's `device_key`s.

Cross-check a run against HA history (`sensor.filtered_pool_water_temperature`, `sensor.pool_heater_energy`, `sensor.outdoor_temperature`).

Likely causes, each to be proven with data:
1. The pool heater's quarters are missing from `energy_optimisation_device_slots` for the resolved device ids, so heating is classified as idle and the pool appears to warm.
2. The outdoor series is not outdoor air (units or source), which makes exposure wrong.
3. Solar gain dominates daytime idle stretches.

Fix a data or mapping defect at its source. Do **not** loosen the physical checks. If cause 3 is proven, restrict the fit to night-time idle stretches (sun below the horizon), because the planner's model has no solar term. Record that as a spec deviation.

### 5.2 Floor-affine forecast tail (unconditional fix)

- **Floor.** Computed from published all-in import prices over the last 60 days. The plan's own published window is always included, with the same recency and season kernel weights as the price shape. *(Amended 2026-09-28: pooled estimator for unobserved hours.)*
  - `F_all` is the weighted 2nd percentile over all observed quarters, pooled.
  - `F_hour(h)` is the weighted 2nd percentile of local hour-of-day `h`.
  - `n_h` is the effective number of observed days for hour `h` (sum of kernel weights).
  - `F(h) = (n_h·F_hour(h) + k·F_all) / (n_h + k)`, with `k = 5` days. An hour with no observations gets `F_all`.
  - With no published observations at all, there is no floor and the tail uses the pre-change estimator unchanged.
- **Tail.** `F(h) + max(0, L − F̄)·s(h)`, where `s` is the existing weighted intraday shape, re-normalised on *excess over floor* (mean 1).
- **Invariant:** no non-binding slot is priced below `min(F)`. This is a test, not a clamp applied after the fact.
- Keep the existing recency (21 d), season (σ 45 d) and day-type weighting.

### 5.3 Pool valuation: service/terminal split with automatic comfort pricing

**Service/terminal split.**
- Physical retention per slot: `d_i = exp(−UA·h_i/C)`, with `C = volume·1.163 kWh/K` and the fitted UA.
- **Service part.** The user curve W, reshaped as described under automatic comfort pricing below, carries `usage_weight_i = 1 − d_i`.
- **Terminal part.** `terminal_curve = V_H`, the automatic water value at the horizon end (§5.4). `terminal_weight = 1`.
- **Bid for x → y at slot i:** `Rˢ_i·(U_W(y) − U_W(x)) + Rᵗ_i·(U_V(y) − U_V(x))`, where `Rᵗ_i = Π_{k≥i} d_k` and `Rˢ_i = 1 − Rᵗ_i`. The weights always sum to 1, so waiting is never taxed and late heat is never preferred beyond physical loss.
- **Score.** `scoreDispatch` reports `service_value_sek` and `terminal_value_sek` separately, so warmth and future avoided cost are each counted once. With `terminal_curve` absent, results are bit-identical to today.
- **Stop-at stays.** `max_state` remains `poolStopTemperature(user curve)`. Above it the curve is worth 0, and physical overshoot is allowed as measured state.

**Automatic comfort pricing (S3).** The monetary scale `s` of W's shape is calibrated so that the stationary dynamic-program policy (§5.4), under the regime chain's stationary distribution, **holds the pool on average at the comfort point** (30 °C).
- Bisect on `s`, at most 12 iterations.
- Initial guess: `W'(comfort)·s/units_per_kwh = expected upkeep price`, where the expected upkeep price is the regime-weighted mean of the cheapest `k` hours per day and `k = UA·(T_c − T̄_air)·24/(COP·P)`.
- Below comfort, W's shape gives priced shortfall (no floor). Above comfort, storage value comes from V_H.
- The calibrated `s` and the resulting held level are frozen in the basis and shown in the portal's effective-curve view.

This replaces `anchorPreferenceCurve` against the horizon's cheapest decile for pool and EV. The legacy path keeps the old behaviour.

### 5.4 Regime prices and water value (`price-regimes.ts`, `water-value.ts`)

**Regime model** (published prices only, 60 days):
- the floor `F(h)`;
- daily excess `x_d = mean_h(p − F)`;
- three regimes by weighted terciles of `x_d`, each with an excess-over-floor day shape;
- a 3×3 transition matrix from consecutive published days with a Dirichlet prior (diagonal 0.6, pseudo-count 3);
- the same recency and season kernels as the price shape.

**Dynamic program** (per store, hourly steps, grid state):
- **Pool:**
  - Grid: 0.1 °C steps over `[min(T0, comfort) − 4, stop]`.
  - Actions: `{0, P}` per hour, plus a quarter-resolution fraction when needed.
  - Step: `T' = T_air + (T − T_air)·δ + a·COP(T, T_air)/C`, with `δ = e^{−UA/C}`.
  - Reward: `(1 − δ)·U_W(T)`.
  - Air: the typical-day air profile from the outdoor forecast/history (§5.8), replacing the constant 15 °C.
- **EV:**
  - Grid: 5 km steps over `[0, reach at charge limit]`.
  - Actions: charger levels.
  - Step: `s' = s + a·η/k − drain(h)`, where `drain(h)` is the learned drive profile (§5.5).
  - Reward: continuous service `(1 − e^{−1h/24h})·U_W(s)`, relevance time constant τ = 24 h, because the store is lossless.
- **Stationary tables:** relative value iteration per regime day until the marginal change is below 0.001 SEK/kWh, capped at 90 days. Warm-started from the previous table.
- **At planning time:**
  - Regime weights at the horizon end: `π_H = e_edge·P^{k_H}`.
  - One partial-day pass per regime gives `J_H`.
  - `V_H` is the marginal of `J_H`, made non-increasing with PAVA, with at most 16 breakpoints.
  - Planning-time cost must stay under 2 ms.
- **Fingerprint.** Each table carries a fingerprint: hash(store model, curve, `s`, air profile, regime model). The planner recomputes it. On a mismatch the store falls back to legacy valuation and emits a diagnostic; it must never use a mismatched table.
- **Mandatory properties (tests):**
  - concavity/monotonicity of the marginal curves;
  - bounds: `V' ≤ max(W' on reachable states, max path price)`;
  - lossless, drain, no reward reproduces `batteryValueCurve` within its band tolerance;
  - Bellman consistency: auction value over `[0, H]` plus `V_H` equals the explicit dynamic program over `[0, H + 7 d]` within 1 % for slot-0 decisions, single store, periodic prices;
  - time invariance of `V_H` under periodic prices.

### 5.5 EV: continuous comfort store, executable and desired projections

**Valuation.** Same construction as the pool: service W with τ = 24 h relevance weights, terminal `V_H` from the EV table, comfort point 300 km calibrated as in §5.3.
- Drive drain: learned from the last 28 days of `ev_charging_kwh` and `ev_soc` (energy delivered ≈ energy driven), as a weekday/weekend hourly profile. Default 8 kWh/day if fewer than 7 days of data.
- The charge limit (`departure_target_soc`, the vehicle cap) is never changed.

**Branch** (`EvBranch`):
- `connected === true`: `{kind: "executable"}`. The EV is in the joint auction.
- Otherwise: `{kind: "conditional", reason: "cable_disconnected" | "cable_unknown"}`. The EV is **not** in the joint auction.

**Desired schedule.** A single-store EV auction against the executable household's residual (fixed load plus solved stores and battery flows). It is allowed from slot 0 and routed through `solveAuction`, so staged steps reuse it.

**Plan fields:**
- `slot.ev_w`: executable. It is 0 while unplugged; no command and no fictitious energy.
- `slot.ev_desired_w` and `slot.ev_desired_target_current_a`.
- `slot.ev_soc_conditional`.
- `plan.ev_projection`: `{branch, desired_kwh_48h, first_desired_start}`.
- Deviation checks (`replan-policy.ts`) compare against the executable projection only.

**HA (S2).** When the cable becomes connected, HA executes `ev_desired_target_current_a` for the remaining quarters of the accepted plan. That is contract work in the integration: execution adapter, contract fixture, pure-tier tests, manifest bump. Cable changes do not trigger an auction.

**D5.** Operating mode is not an input to any of this.

### 5.6 Peak policy (`peak-policy.ts`)

**Spreading term** (replaces `PEAK_SHAPING_SEK_PER_KWH_PER_KW = 0.1`).
- Convex from 0 W, with rate `PEAK_SPREAD_AT_LIMIT_SEK_PER_KWH / import_limit_kW`.
- `PEAK_SPREAD_AT_LIMIT_SEK_PER_KWH = 0.25` (engineering constant): the last kW at the grid limit costs +0.25 SEK/kWh, not +1.3. Loads spread whenever that costs less than ~0.25 SEK/kWh of price difference. It never blocks filling a cheap stretch that beats the alternative by more than that.
- Keep the existing reporting as a soft cost separate from tariff charges (D4).

**Effektavgift structure** (ready, rate 0):
- `{sek_per_kw_month: 0, top_n_hours: 3, night_window: "22:00-06:00", night_weight: 0.5}`, stored per home. It is a snapshot policy field, defaulted when absent.
- The month's current top-N hourly average import comes from `energy_optimisation_actual_slots` and is frozen into the basis.
- **Cost:** `rate × Δ(mean of the month's top-N weighted hourly averages)` caused by the plan's hourly imports.
- Unit tests use a non-zero rate: stacking three big loads into one hour must cost more than spreading them over the stretch.
- No UI is required now.

### 5.7 Whole runs, start cost and retiring the minimum run (S6, S7)

**Whole-run candidates.** After the priority auction, generate pool run candidates. A run is a start quarter plus a length; lengths go in 1 h steps up to reaching Stop-at or 12 h. Candidates come from:
1. the water-value policy simulated over the published window, using the frozen tables and published prices;
2. the cheapest contiguous published windows of each length;
3. the previous plan's run (continuity).

- Each candidate fixes the pool's power profile and re-solves the other stores through `solveAuction`, so staged execution reuses it. `scoreDispatch` arbitrates.
- **Trigger:** only when the auction's published pool schedule is split (two runs less than 4 h apart), or differs from the policy's published pool energy by more than 3 kWh. At most 3 candidates per plan.
- Extend `fixed-energy-plan.ts` with a single-store fixed profile, so that fixing the pool does not freeze the battery.

**Start cost.**
- The pool's `start_cost_sek` represents a heat-pump start: compressor start wear, exchanger/pipe warm-up loss and the pump sequence.
- Default **3 SEK**, as a named constant. Calibrating it from pool telemetry is a follow-up task, recorded as an open item.
- Charge it once per run in candidates and the score.

**Continuity.**
- Re-express `heldRunCandidate` as the "previous run" candidate. A running pool continues unless the best alternative saves ≥ `HELD_RUN_RELEASE_SEK = 5` over the horizon.
- Remove its use of `minimum_run`.
- Keep the `pool_run_quarters` reference field.

**Retirement.** Once the gates in §7 pass with the above in place:
- stop reading `minimum_run` for the pool in the website planner;
- in the HA integration, stop enforcing pool minimum-run deadlines and remove the pool minimum-run setting, with a checkpoint migration for any persisted fields and a manifest bump;
- hot-water minimum runs are out of scope and unchanged.

### 5.8 Weather, monitored loads and base-load demand

**Outdoor forecast always.**
- Resolve `outdoor_temperature_c` for every plan when the home has a location: the HA series if complete, otherwise the met.no fallback that already exists.
- Remove the constant-15 °C assumption from pool physics wherever a series exists.
- Record observed outdoor temperature from HA; backfill from the provider's past data when HA sends none.

**Monitored loads** (D9 Monitoring role).
- Read the last 28 days of `energy_optimisation_device_slots` for Monitoring devices at refresh time. Freeze `monitored_loads[]` = `{device, room, forecast_w[288], hdd_kwh_per_degree_day, regularity, provenance}`.
- They are **components of base** (base = gross − Planned) and are never added on top. Where Σ monitored exceeds HA's base in a slot, record a diagnostic; do not correct.
- The plan shows expected draw per monitored device as information only. Only Planned devices are schedulable in the UI.
- Preserve role history, so switching Monitoring ↔ Planned never rewrites past accounting.

**Weather departure** (`weather-demand.ts`).
- Fit daily uncontrolled demand `U` (gross − Planned) against heating degree-days: base temperature chosen over 10–18 °C, slope ≥ 0 and shrunk. Include irradiance where available, weekday effects, and the monitored heater components.
- The departure relative to the weather in HA's base-load window (default 10 days with a 14-day half-life, or `sources.base_load.window` once HA sends it) is added **once** to fixed load. It is shaped by the heater intraday shape, plus a bounded reactive residual (±30 % of base, shrunk).
- This gives autumn pessimism and spring optimism without a season switch. Validity: this is a forecast of energy demand, not a bound (constraint-requirements).

### 5.9 Forecast trust (`forecast-trust.ts`)

- Archive `shadow_import_sek_per_kwh`, `pv_calibration_factor` and `demand_departure_w` in `forecast_runs.series`.
- Score matured issues:
  - **Tail-price premium:** error of shadow vs published prices in the slots a sink would pick (the cheapest quartile of the tail), bucketed by hours past the published edge.
  - **PV skew factor:** lead ≥ 1 day, weighted median ÷ weighted mean of actual over calibrated. HA stays the owner of the mean bias.
- Weight everything with the price-shape kernels; there is no season switch.
- Apply the premium to non-binding slot prices seen by the scorer, and the factor to lead ≥ 1 PV.
- Corrections may go in either direction when evidence supports it. Bootstrap the premium immediately by re-running `buildPriceOutlook` over `price_slots` at synthetic past issue times.

### 5.10 Retention

- Keep long term (1095 days, as for `actual_slots`): `actual_slots`, `device_slots` (raised from 400 d), `pool_slots`, `outdoor_slots`, `price_slots`.
- Bound auxiliaries: `thermal_slots` 400 d (new pruning); `forecast_runs`, `plan_runs` and `forecast_residuals` 400 d.
- Add a size report (`pg_total_relation_size` per energy table) to the maintenance diagnostics.
- Nothing below 15 minutes is stored.
- HA recorder settings are the household's own configuration and out of scope.

## 6. Parameters (named constants, not household settings unless stated)

| Name | Value |
|---|---|
| Comfort points | From the user curve (Phil: pool 30 °C, EV 300 km). Phil sets the EV comfortable point to 300 in the portal. |
| EV service relevance τ | 24 h |
| Regime window / transition prior | 60 days; Dirichlet diagonal 0.6, pseudo-count 3 |
| Floor | 2nd percentile per hour-of-day, 60 days |
| `PEAK_SPREAD_AT_LIMIT_SEK_PER_KWH` | 0.25 |
| Effektavgift | `sek_per_kw_month` 0 (off), top-3 hours, night 22–06 at weight 0.5 |
| Pool start cost | 3 SEK (calibration follow-up) |
| `HELD_RUN_RELEASE_SEK` | 5 |
| Run candidates | ≤ 3; triggered by split (< 4 h gap) or > 3 kWh disagreement |
| Evidence refresh | ≤ 1× per local day, compare-and-set on `fitted_for` |

## 7. Acceptance gates

Replay gates run through a local script (`scripts/replay-acceptance.ts`) over the captures in `~/Downloads`. The captures contain household data and must **not** be committed; CI tests use synthetic or trimmed, anonymised fixtures. Use a fitted pool loss of 0.1 kW/K where the capture has none (§5.1).

*Amendment 2026-09-28: two labelled replay lanes.* Every number states its lane, and lanes are never mixed in one number.

- **`exact`.** Replays the capture as frozen, including its `resolved_price_outlook`. It tests valuation, search and continuity, so G3–G7, G10 and G11 use it. G1 does not apply here, because the frozen outlook bypasses the estimator.
- **`rebuilt-outlook`.** For each capture, reconstruct a price archive from the published slots of **all** captures (plus HA price history if available locally), taking only rows with `start` earlier than that capture's `captured_at`. Where a slot appears in several captures, keep the latest published value known before `captured_at`. That archive must not include future rows.
  - Rebuild the outlook from that same archive twice: once with the pre-change estimator and once with the new one. Run the planner on each.
  - G1 and G2 are judged on this lane: old estimator vs new estimator, same archive, same loss substitution.
  - Also report G2 on the `exact` lane, for reference.

*Amendment 2026-09-28 (b): redesign lanes carry a frozen basis.*

**Why.** Captures predate `planning_basis`, so they take the legacy path (§4). Redesign behaviour is therefore evaluated on lanes where the harness **attaches a reproducibly built `planning_basis`** to each capture. The basis is built only from the leakage-free reconstructed archive (§7 lane `rebuilt-outlook`) and the capture's own snapshot data. Fields whose evidence the capture cannot supply stay absent; for example, monitored-device history is missing, and those parts use their documented legacy fallback.

**The lanes:**

| Lane | Outlook | Basis | Used for |
|---|---|---|---|
| `exact` | Captured | None | G10 (legacy equivalence), plus the CPU baseline |
| `exact+basis` | Captured `resolved_price_outlook` | Attached | G3–G7, G9 and G11 |
| `rebuilt-outlook+basis` | Rebuilt with the new estimator | Attached | G1 and G2 |

`rebuilt-outlook` without a basis stays available for estimator-only comparisons.

**Final gates are not step blockers.** G2–G9 are acceptance gates for the finished redesign. Each step reports them with its lane, but a gate that later steps are meant to satisfy does not block the current step. A step stops only on a spec contradiction, a settled-decision conflict, or a regression in an already-passing gate.

| Gate | Criterion |
|---|---|
| G1 Floor | `rebuilt-outlook` lane: no non-binding slot below `min_h F(h)` on every capture that has published observations |
| G2 Tail deferral | On C-0919, C-0920, C-0927, C-0928a and C-0928b, the pool's tail share of planned pool kWh falls by ≥ 50 % against baseline. The pool uses published hours priced ≤ the published 25th percentile whenever it is below Stop-at and such hours have spare capacity. |
| G3 One run | C-0924: the published pool schedule is one contiguous run (no two runs < 4 h apart) |
| G4 No non-start | On all acceptance captures, the pool trajectory stays ≥ 28.0 °C and ends ≥ 29.0 °C |
| G5 Continuity | C-0927 with `pool_run_quarters = 17` and heating running: the pool runs to 17:15 local. The mid-run 13:30 release no longer cuts a 09:00–17:00 run. |
| G6 EV | C-0927: `ev_w = 0` in every slot (unplugged); `ev_desired_w > 0` somewhere; the pool or battery takes the solar the baseline gave the car; the score is not worse |
| G7 Horizon roll | Appending 96 flat tail quarters moves the published pool schedule by ≤ 1 quarter |
| G8 Battery demand | Backtest over 26–28 Sep: daily base-load error ≤ ½ of HA-empirical (27 Sep: 38 actual vs ~24) |
| G9 Spreading | Synthetic cheap stretch with pool + EV + battery: peak import is lower than stacked, and no cheap-stretch energy is left unused when it beats the alternative by > 0.25 SEK/kWh. Effektavgift unit tests pass with rate > 0. |
| G10 Legacy | `withoutPlanningBasis` reproduces the pre-change planner on all 87 captures, except for the unconditional G1 tail fix and the §5.6 spreading-term scaling |
| G11 CPU | Local per-stage time within the existing stage budgets. Total local planning CPU ≤ 1.5× baseline when no run candidate fires, ≤ 3× when one does. Planning-time valuation < 2 ms. Evidence refresh < 400 ms local. |
| G12 Repository | `npm run lint`, `npm run build:test`, `npm run test:e2e:local` and `deno task test` all pass. HA contract fixture regenerated (`deno task generate:ha-contract-fixture`). Migration version test passes. HA integration tests pass (pure-tier, checkpoint, contract). |

## 8. Order of work

1. §5.1 verify loss fit · §5.2 floor tail · replay-acceptance script (baseline numbers recorded)
2. §5.6 peak policy
3. §5.4 regimes and water value (pure, with property tests)
4. §5.3 pool valuation + `planning_basis` + evidence refresh + portal effective curves
5. §5.7 whole-run candidates, start cost, continuity without `minimum_run`
6. §5.5 EV projections (website), then HA execution of desired charging
7. §5.8 weather, monitored loads and demand departure
8. §5.9 forecast trust
9. §5.10 retention
10. §5.7 retirement of `minimum_run` (website + HA), once G2–G7 pass

Each step lands on `dev` as its own commit, with tests and the replay-acceptance numbers in the commit message body.

## 9. Out of scope

- Notifications.
- Effektavgift UI and tariff data entry.
- HA recorder configuration.
- Hot-water minimum runs.
- Room-heater control (monitored heaters stay unscheduled).
- Stochastic or scenario joint dispatch.
- A 14-day joint horizon.
