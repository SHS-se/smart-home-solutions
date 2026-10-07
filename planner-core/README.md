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

`models` owns pure device transitions; `solver` owns projection, additive
measurements and bounded search. The TypeScript wrapper passes one prepared
problem through one Wasm call. Each invocation has private mutable memory.
Neither crate has database, history, forecast-fetching or training dependencies.

The build produces the tracked `solver.wasm`, `artifact.json`, generated
`solver-bytes.ts` and the probe's recipe copy. Never edit those generated files.
The base64 module packages the identical binary through this project's
Supabase `--use-api` deployment path, which cannot package static Wasm files.
Source, compiler/toolchain configuration, prepared-input dependencies, policy,
recipe and binary digests identify the candidate. Path remapping removes local
Cargo/repository paths from the binary. CI rebuilds and checks the artifacts,
Rust lint/tests and exact native/Wasm output parity.

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

Sixteen direct rules are implemented. The three feasibility-witness rules,
useful terminal inventory, episode repair and the complete coupled neighborhood
search remain to be implemented. The independent benchmark still applies all
rules and opportunity audits. Current search quality does not meet the 769-point
gate. The policy and recipe are explicitly marked `prototype_only`.

Production capture, background publishers, the model registry, supported device
and authority migration, fixed bookings, durable delivery, pool hardware settings
and the approved editor/curve removal remain behind the qualification gate in
[the design](../docs/energy-optimisation/planner-scorecard-redesign-2026-10.md).
Hosted CPU, whole-isolate memory, fleet tails and click-to-HA-to-browser completion
require separate measurements before rollout.
