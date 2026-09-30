# Planner

Everything the energy planner runs, and nothing else. Edge functions, the
portal and the bench all import it from here.

- **Closed:** nothing in this folder imports from outside it, types included;
  `zod` is the only package. `tests/planner-boundary.test.ts` enforces it.
  A type the planner reads belongs here, and callers import it from here.
- **Entry points:** `energy-optimisation.ts` (`generateOptimisationPlan`,
  `dispatchWorkbench`) and `dispatch-plan.ts` (`dispatchAuctionSteps`,
  `scoreDispatch`). The planner bench calls only these
  (`bench/planner-adapter.ts`).
- **Versions:** the planner bench identifies a planner by the code these entry
  points reach, not by commit (`bench/planner-version.ts`). Changing a comment
  or a type here is not a new version; changing code is.

Tests (`*.test.ts`) and fixtures (`*.fixture.ts`) that exercise only the
planner live here too. Tests that also need other shared modules stay in
`_shared/`.
