# Current-quarter replan continuity

## Later design decision — 15 September 2026

Preserve the historical behaviour and evidence below. The agreed participation ownership, metadata exclusion, chart partition and explicit battery supply scope supersede conflicting target requirements; this record is not current replacement rollout guidance.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

Planner v30 adds an economic reference to the priority scenario. Ingest derives `snapshot.replan_reference` from the server's previous ready plan, never from a client claim. The bounded reference describes the current absolute quarter's battery powers and pool heat/defer action. It is frozen in the enriched snapshot, so saved replays and distributed planning see the same input. It is not evidence that a device applied or delivered the old request.

The ordinary solution is scored against two alternatives: replace its first-quarter battery/pool allocations while retaining its future trajectory, and reoptimize the suffix after those allocations. Both use fresh measured state, current limits and the existing complete dispatch objective. Pool heat uses the current learned power. Battery powers are rejected if infeasible; they are not clipped or promoted to fixed-plan authority.

A fully validated alternative can win when it costs at most 0.05 SEK more than the proposed solution. The direct trajectory prevents suffix-search noise alone from forcing a switch. Fixed plans take precedence. Candidates with different unscored room/boiler trajectories are excluded from the comparison. All emitted commands and forecasts are materialized normally; alternative trajectories clear auction evidence that no longer describes them. `plans.priority.continuity` records the source, choice, objective values, threshold and reason.

The preference applies to the current quarter, with no minimum run lock. It does not guarantee that every reversal disappears: material economic improvements or new constraints can change the request immediately. The model still approximates a partial current quarter as a complete quarter. The workbench and staged generator use the same selection path; baseline/cost comparison scenarios retain their ordinary solutions.

Deploy ingest and the planning worker together: the worker protocol is now 2 to reject mismatched deployments. No Home Assistant contract expansion is needed. Hardware commissioning remains a separate step.
