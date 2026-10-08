# TEST live rules planner — 8 October 2026

## Outcome and scope

The dev/TEST replanning path uses the same Rust/Wasm rules kernel as planner-bench. It no longer invokes the marginal-value auction, resumes auction batches, or reconstructs cost-value curves. Production main is unchanged. The removed cost-curve panels and Build a plan editor have no active endpoint.

Benchmark retention begins at production baseline `4cc6718cecdcc6b06fbc48216c504e6022fd659d`, committed `2026-10-07T16:37:53Z`. The runner rejects earlier commits before loading a solver; schema application deletes their runs and cascading results/verdicts and installs a database constraint against reinsertion. Saved runs at or after that baseline remain available.

## Architecture decision

Independent GPT-6 Astra high-effort and Claude Opus high-effort reviews preceded implementation. Astra proposed a complete solve inside the existing durable, fenced job lifecycle; Opus proposed an explicit native projector and copying committed commands independently of forecast simulation. The synthesis combines these: one prepared input, one complete private worker call, one atomic publication. A result ledger, additional assembly phases, accepted-history subsystem and old-engine fallback were rejected because they add writes or separate physics without helping this measured workload.

```ts
const prepared = prepareRulesPlanningInput(
  { snapshot, now, resolved_price_outlook },
  publishedCommands,
  resolveRulePolicy(savedCriteria),
);
await jobs.accept({ homeId, customerId, snapshotId, sourceHash,
  input: prepared, context });
await jobs.advanceForHome(homeId, { jobId }, connection);
// Worker: generateRulesPlan(prepared), using native solve + native projection.
```

`rules-planner.ts` owns admission mapping and plan materialization. `planner-core/models` owns physical response; `planner-core/solver` selects commands and projects native model transitions. The scheduler receives model facts rather than fitting them. `rules-planning-client.ts` owns the protected one-shot transport; `energy-planning-jobs.ts` and SQL own home identity, reference/config/request fences and publication. Internal worker protocol 9 is separate from the unchanged HA exchange protocol 2.

Wasm ABI 4 represents missing equipment explicitly, battery solar/house-supply permissions, EV availability, exact locked commands, physical thermostat limits and model-owned heater startup. Native and Wasm builds share source and pass exact parity. The generated bundle includes the recipe/policy manifest; source identity includes the live adapter. No auction continuation is stored.

## Forecast and model ownership

Admission reads one prepared server forecast publication, the current measured HA snapshot, stored fitted device response and the approved rule policy. It does not query historical weather, demand, prices or device measurements, fit a model, or contact a forecast provider. Ordinary telemetry refreshes the forecast/model publication separately in background; planning submissions do not start that work alongside the solve. Missing forecast coverage fails explicitly.

HA's supplied solar, baseload and device forecasts remain authoritative. Published prices override cached estimates. The server product supplies aligned price estimates, outdoor temperature, irradiance and thermal-zone forecast series. External forecast integration and model refresh can be refined independently of solve execution.

Pool physical settings are distinct from comfort preference. This TEST home's confirmed heater registers are 28°C start and 34°C stop; other homes need their own declared hardware settings. Model response owns compressor startup, auxiliary electricity and delivered heat. Startup age that cannot be observed is explicitly a lower bound, not a claim that the heater starts at full output. Forecast energy is projected from the device response rather than assigning full heat to every commanded quarter.

Every device is counted once. Controlling devices follow selected commands; verification/observed devices retain their native independent demand forecast in the execution projection. Unsupported actively controlled room models, a finite pool outdoor cut-out, and a hard battery terminal target currently fail by name; they must be implemented before those configurations are activated. Current TEST qualification has none of these configurations. This is not qualification of all future 20–30 device types.

## Commitments and consumer contracts

The current published ready plan supplies exact commands through capture time plus one hour, including a partial first quarter. A replan keeps those commands while simulating fresh measured states; EV disconnection can therefore change actual electrical demand without rewriting its fixed command. A plan-ID fence prevents publishing against a replaced reference. Automatic and manual submissions follow the same preparation/solve/publication path.

Schema 9 native battery commands remain usable when optional battery execution feedback is absent, as with the current TEST integration. A modern delegated execution contract is generated only from supplied valid feedback. Missing feedback is never fabricated. The optional monetary battery projection truthfully reports that the rules objective has no conditional money projection; cost curves are not recreated. Reusing a selected schedule for a cost comparison is explicitly labelled rather than represented as another optimization.

## TEST completion and production acknowledgement

The TEST HA mirror has no control authority and does not acknowledge returned TEST plans. TEST manual requests therefore complete on atomic publication of their matching ready plan. The server chooses this basis only for the exact TEST Supabase origin; payloads cannot choose it. Request, home, snapshot and plan identities must match. All HA acknowledgement fields remain pending, so cloud completion does not claim device acceptance or execution.

Other environments retain exact Home Assistant acknowledgement as the completion milestone. Already outstanding legacy manual requests are released as failed after the planner upgrade, preserving their displayed plan and acknowledgement identity. The first rules publication made before the TEST completion change was released explicitly using its matching published-job evidence, without altering HA acknowledgement.

## Measured qualification

The first real manual TEST request at `2026-10-08T09:35:13.610188Z` published rules plan `f35d8bc9-d715-4997-a9ad-4cb646cce540` at `09:35:21.549Z`: **7.94 seconds from portal request to current-plan publication**. Its claimed job took 3.76 seconds. A complete solve/materialization using the captured 72-hour TEST input took approximately 109 ms locally. Solver timing alone is not an end-to-end website guarantee; cold starts, HA capture/delivery, publication and refresh are also part of the ten-second target. This first run exposed the TEST acknowledgement completion issue above.

After the completion fix, the second real manual request at `09:46:59.027926Z` published and completed request `83999f55-fd57-4315-ac32-ed8161477a9d` at `09:47:07.294Z`: **8.27 seconds**. Its claimed job took 2.70 seconds. The website was verified showing new plan `82c5e8f5` and the enabled replan button. Browser observations did not establish the precise instant the completion message appeared, so these measurements establish server publication/completion below ten seconds, not a universal click-to-message guarantee. HA continued reporting its production plan; TEST acknowledgement stayed pending.

The new ABI 4 needs its own fresh CI bench results; earlier ABI 3 scores are not evidence of this output. The benchmark referee remains independent from planner selection, including stacked quarter verdicts.

Validation before commit includes full Deno tests and generated HA fixtures, Rust unit tests and strict Clippy, exact native/Wasm parity and reproducible artifact build, isolated Edge bundling, full repository lint, TEST frontend build, and all retained mocked-backend Playwright suites. Deployment and live qualification are TEST only.

Final local validation: 1,659 Deno tests passed; 60 Playwright tests passed; lint reported zero errors and 27 existing warnings. The TEST build succeeded with its existing chunk-size warning.
