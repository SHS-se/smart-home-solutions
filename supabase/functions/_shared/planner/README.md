# Planner domain contracts

This folder holds the shared planning contracts, device models, household scoring,
and physical domain functions. `tests/planner-boundary.test.ts` keeps their runtime
dependencies inside this folder; callers import these types and functions directly.

The production planning entry point is `../run-rules-planner.ts`. It prepares the
input for `../rules-planner.ts`, whose native WebAssembly kernel lives in
`../planner-wasm/` and is built from `planner-core/solver`. The portal demos, replay
scripts and benchmark use that same engine. The superseded TypeScript auction
planner and its continuation protocol have been removed.

`planning-contracts.ts` owns snapshot and plan transport types.
`planning-warnings.ts` carries evidence quality and estimation consequences without
turning them into planning admission gates. `device-models.ts` defines physical
models shared by the planner and benchmark referee; parameters arrive in
`snapshot.device_physics`.

The benchmark identifies native builds through the verified artifact manifest and
its source digest (`bench/planner-version.ts`). Generated HA consumer fixtures must
come from the real planner, never manual edits.
