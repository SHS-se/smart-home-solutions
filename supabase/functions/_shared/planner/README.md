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
- **Device models:** `device-models.ts` says what a device can be told to do and
  what it then does. It is a leaf (it imports nothing) and states no number:
  the numbers come with the household or the snapshot. The bench referee and
  its audit import it, so a plan is judged by the models it was made with
  (`docs/planner-bench/device-models-design.md`).

Tests (`*.test.ts`) and fixtures (`*.fixture.ts`) that exercise only the
planner live here too. Tests that also need other shared modules stay in
`_shared/`.
