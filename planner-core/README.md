# Rust planner prototype

Rust is installed with the official `rustup` installer. The repository's
`rust-toolchain.toml` selects Rust 1.99.0, the minimal installation, rustfmt,
Clippy and `wasm32-unknown-unknown`. Cargo downloads the exact version on another
machine when it first builds this project. Dependencies are pinned in
`Cargo.lock`; builds use `--locked`.

Run commands from the repository root. A newly opened terminal picks up Cargo
automatically; an already open terminal can run `source "$HOME/.cargo/env"`.

```sh
deno task build:planner-wasm
cargo fmt --all --manifest-path planner-core/Cargo.toml --check
cargo clippy --manifest-path planner-core/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path planner-core/Cargo.toml --locked
cargo build --manifest-path planner-core/Cargo.toml --locked --release --bin shs-planner-core
deno task test:planner-native-parity
deno task test
```

`models` owns pure device transitions. `solver/physics.rs` owns coupled
projection, `policy.rs` owns additive measurements, `opportunity.rs` owns
forecast continuation values used only for construction guidance,
`witnesses.rs` owns feasible alternatives, `battery_schedule.rs` owns conditional whole-horizon battery allocation, and `builder.rs` owns bounded joint
construction and repairs. The TypeScript wrapper passes one prepared
problem through one Wasm call. Each invocation has private mutable memory.
Neither crate has database, history, forecast-fetching or training dependencies.
ABI 3 requires the device-owned initial heater state (`off_unobserved`, known
`off` seconds, known `running` seconds, or confirmed `steady`). Native quarters
report command start events independently of electrical/thermal startup. The
`pool_restart` direct rule scores −2 only on starts less than 12 hours after the
last stop. The TEST bench now publishes the home's existing configured startup
curve instead of steady draw. See the pool-restart design for calibration evidence
and the one-time case-version migration.

The build produces the tracked `solver.wasm`, `artifact.json`, generated
`solver-bytes.ts` and the probe's recipe copy. Never edit those generated files.
The base64 module packages the identical binary through this project's
Supabase `--use-api` deployment path, which cannot package static Wasm files.
Source, compiler/toolchain configuration, prepared-input dependencies, policy,
recipe and binary digests identify the candidate. Path remapping removes local
Cargo/repository paths from the binary. CI rebuilds and checks the artifacts,
Rust lint/tests and exact native/Wasm output parity. The frozen ABI uses an
explicit compiler metadata salt and strips release symbols so Cargo cannot
change internal names and function order with its build host or checkout path.
`deno task test:planner-build-reproducibility` rebuilds in another directory and
compares the complete binary and source manifest without normalization.

## Measurement

Export benchmark data as `{ "cases": [{ "name", "dataset", "recorded" }],
"rules": { ... } }`. The independent existing referee scores every quarter,
including cancelling rule contributions. Results retain the full quarter cards:

```sh
deno task bench:planner-wasm path/to/export.json reports/planner-wasm/local.json
```

`recipe.json` freezes the work grant and proposal settings. Change it and rebuild
to create a distinct candidate; the adapter rejects an alternate recipe under
the same identity. Elapsed milliseconds and Wasm instance memory are diagnostics,
not whole-handler CPU or total peak memory measurements.

The private `energy-planner-probe` endpoint is deployed only to TEST
`vxqpgbzseckgceopitpm`. It requires service authentication and rejects production.
It has no plan-publication, database or device-command API. The hosted runner
uses the authenticated Supabase CLI to hold the TEST service key only in memory;
it never writes the key to its report or prints it. Deployment configures the
explicit `PLANNER_PROBE_SECRET` from the TEST service key so the caller and
endpoint share the same credential.

```sh
deno task deploy:planner-probe
deno task probe:planner-hosted --synthetic reports/planner-wasm/hosted-synthetic.json
deno task probe:planner-hosted path/to/approved-export.json reports/planner-wasm/hosted.json
```

The synthetic mode invents every forecast, equipment parameter and initial
reading. Real test cases must be approved for upload. Hosted results verify
exact local/remote commands, trajectories, rule accounts and work usage, and
record cold/warm initialization and client request timing.

## Qualification status

This is a diagnostic prototype, not the replacement production engine. It covers
pool, EV and battery, native heater startup, integer charger commands, shared
grid limits and an exact first-hour accepted-command prefix. An unavailable
prefix fails explicitly. States are reprojected from the supplied initial
readings; realistic above-target readings remain usable.

The rule-driven builder maps all 19 quarter rules and 11 economic families.
Rules carry their configured thresholds, signs, required flags and exclusions.
Construction uses backward forecast continuation tables and a forward beam of
coupled native commands. A climb follows in which every proposal, a span edit
or a certificate's repair, is scored exactly from one projection; the audit of
every family proposes, and reports on the selected plan.
The [forecast search comparison](../docs/energy-optimisation/forecast-opportunity-search.md)
records the first-quarter regression, fresh same-input scores and runtime tradeoffs.
Two sweeps does not mean two total simulations. Exact projection decides physical
feasibility; separate known-price and forecast certificates keep forecast-only
savings from earning published-price penalties. Reports include every signed
quarter contribution, witness coverage, run purposes and deterministic work.

The 7 October frozen comparison scores **1,110 versus 569 (+541)**, with no physical
violations or required-rule failures. All 22 cold hosted solves match local/native
output exactly and finish in 93–292 ms; client requests take 282–1,575 ms. This proves
the diagnostic subset's score/runtime improvement, not full production readiness.
Electricity cost rises 20.4%, and some cars finish within the card's 50 km tolerance
rather than at the target. See the detailed qualification and limitations in
[the checkpoint](../docs/energy-optimisation/rule-builder-checkpoint-2026-10.md).
The policy and recipe remain explicitly marked `prototype_only`.

Production capture, background publishers, the model registry, supported device
and authority migration, fixed bookings, durable delivery, pool hardware settings
and the approved editor/curve removal remain behind the qualification gate in
[the design](../docs/energy-optimisation/planner-scorecard-redesign-2026-10.md).
Hosted CPU, whole-isolate memory, fleet tails and click-to-HA-to-browser completion
require separate measurements before rollout.
