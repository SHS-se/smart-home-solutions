# Control authority, command outcomes and reconciliation

## Participation and scope authority — 15 September 2026

Resolve HA inclusion, website planning and HA Verification/Controlling request into one revision-bound contract with effective authority and physical-owner groups. Exclusion/demotion fences new optimization effects locally when known; pending native writes and approved release survive relabelling. Newly Planned/re-admitted equipment defaults to Verification; stale grants never revive. Reject shared-owner conflicts explicitly. Battery supply scope and solar attribution participate in desired-operation identity even when nominal watts are unchanged.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

Implementation update, 14 September: the pure reducer/checkpoint prototype now
exists. The [14 September architecture review and battery release gates](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/controller-architecture-review.md) proposes the
battery-first mixed-mode and release lifecycle, and records transition-job retry,
accounting settlement and overload-relief gaps. Live effect ports and native
commissioning are still open; the historical concurrency rationale below remains
applicable, while its earlier "first build" instruction is superseded.

[Architecture](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Economic policy](controller-policy.md) · [Household runtime](reactive-controls.md)

Target authority corrected 13 September 2026 by Phil. Not implemented. A device in SHS **Controlling** mode grants SHS complete operational authority over its supported, configured control surface. Unexpected values and external writes are overwritable drift, not withdrawal of authority. This supersedes the earlier external-hold/explicit-resume design. Users control the device through SHS intent controls, or leave Controlling mode before controlling it elsewhere. Native equipment protections and physical limits remain authoritative.

## Problem and caller usage

SHS must converge equipment toward its current authorised request despite external changes and uncertain command delivery. It also must avoid awarding the same headroom twice or issuing incompatible SHS sequences. One short synchronous event-loop reducer owns those internal invariants, with asynchronous effects for device I/O and persistence. Full operational authority is a product rule; it is not a distributed lock that prevents other HA writers from acting. No global action mutex is needed. Notification design remains out of scope.

```python
# Proposed call sites, not implemented. Framework callbacks enqueue on the HA loop.
home.post(Observed.parse(ha_event))
home.post(TransportResult(operation_id, outcome))
home.post(OperatingModeChanged(device_id, mode, mode_revision))

# One queued event is processed without awaiting anything.
next_state, effects = reduce_home(state, event, now)
state = next_state
ports.schedule(effects)  # queues work, does not wait for devices or disk

# Required journal durability is acknowledged before issuing a command.
home.post(JournalDurable(operation_id, journal_revision))
# The reducer revalidates current mode, request and physical feasibility.
```

The queue serialises SHS bookkeeping and joint decision commits, not whole controller actions. It does not wait for an entity to reach a desired value. One slow actuator therefore does not hold up unrelated decisions. A single event loop needs no mutex around its synchronous reducer; callbacks from other threads must marshal onto that loop. If decision computation exceeds the measured loop budget, calculate over an immutable versioned frame and reject stale results at the same short commit boundary. Shared-state mutations remain with the reducer.

## Ownership and data shape

```text
HomeState = policy + intent_revision + operating_modes + observations + ledger
          + reservations + group_states + pending_operations
GroupState = Inactive | Automatic | Executing(operation)
           | Reconciling(operation) | Releasing(operation) | Faulted(reason)
SendOutcome = NotSent(proof) | Accepted(evidence) | Ambiguous(evidence)
EffectOutcome = Confirmed(evidence) | Unresolved(evidence) | Deviated(evidence)
Operation = (id, group, generation, mode_revision, intent_revision,
             observed_control_revision, prepared_steps, issued_steps,
             possible_effects, absolute_deadlines, retry_state)
Effect = Persist(record) | SendStep(operation, step) | Observe(group)
       | ScheduleDeadline(at) | Replan(reason) | ReportStatus(details)
reduce_home(state, event, now) -> (state, effects)  # pure, no awaits
```

The home reducer is the sole writer of shared accounting, reservations, eligibility, accepted intent/policy, operation records and control status. Actuator-group tasks own private transport progress and return immutable results. The battery mode and both ceilings form one group; shared heat-pump levers need coordinated group execution. At most one SHS sequence is active per group, while different groups can progress concurrently. The operating-mode model must resolve authority over shared levers; merely mapping a device grants no writes outside Controlling.

Persistence stores ordered records asynchronously. Reserve possible effects before preparing a command; issue it only after the required record is durable and the reducer rechecks generation, current operating mode, authority, latest observations and physical feasibility. An old persistence acknowledgement cannot revive a superseded operation. Failure to journal prevents the new send and raises a fault without stopping observation processing. A crash after `Prepared` but without a durable outcome means **Ambiguous**, because the command might have been sent.

## External changes and native regulation

While Controlling, an external setpoint, mode or permission change does not create a hold, grant manual precedence, or require explicit user recovery. Observe actual state, update possible effects and shared accounting, then automatically re-establish the current SHS request through a valid whole-group transition. Do not infer new household intent from the external value. A device returning with default-looking settings is handled in the same way.

Compare commanded controls with the adapter's expected surface, not every changing sensor. Battery power reversals, thermostat heat calls and native interlocks may be correct equipment regulation. Native protection/refusal remains evidence about what can physically execute; authority does not make an impossible command feasible. Existing mapped external manual-override gates are current implementation facts, not an additional target authority owner; review them when implementing this correction, retaining real equipment protections.

Revalidate before every step. If an external battery mode change invalidates the prepared sequence, recompute the supported transition toward the current SHS mode and ceilings. SHS may overwrite that mode; it must still account for the physical consequences of changing it. Reopening ceilings under an unexpected mode without whole-group validation is not equivalent to reasserting the intended operation. No external-change hold is created while this reconciliation happens.

HA context may aid diagnostics but need not establish who changed a setting before SHS corrects it. A generation fence rejects obsolete software work, but cannot retract a command already sent. Repeated interference is visible as drift/retry activity and an inability to achieve the request if applicable; it does not transfer control or silently change operating mode.

## Ambiguous commands and retries

**Automatically reconcile and retry the current desired state when the adapter can do so within physical bounds.** Ambiguity does not itself require manual intervention or withdrawal from Controlling. Readback may resolve an operation without another write. Re-evaluate current intent, mode, request and observations before retrying; never blindly replay an obsolete multi-step sequence.

| Outcome/evidence | Required behaviour |
|---|---|
| Validation fails or permanent rejection | Report the actual defect; do not repeatedly send an invalid command. Continue other supported work. |
| Transport proves nothing was sent | Release only that unsent step's possible effect; retry transient failure under current authority with bounded pacing. |
| Accepted and physically confirmed | Complete/adopt the outcome without a duplicate command; validate the next step. |
| Timeout, cancellation, connection loss or crash leaves delivery ambiguous | Retain possible effects; inspect current state and automatically retry/reassert where the adapter's repeat/ordering contract supports it. |
| Desired state appears after timeout | Adopt it without a needless repeat; reconcile any older queued effects separately. |
| External control value changes while Controlling | Reconcile actual state and automatically restore the current SHS desired operation; no external hold or explicit resume. |
| Old command arrives while Controlling | Account for its effect and converge to the current request, rather than accepting an obsolete target as intent. |
| Mode leaves Controlling or authority expires | Stop optimisation retries; resolve issued effects through the release/handover lifecycle. No stale request may renew authority. |
| Possible effects cannot support a physically valid next action | Report and restrict only the unsupported physical scope while seeking evidence; the cause is physical uncertainty, not an external writer's claimed ownership. |

Prefer repeatable absolute assignments for automatic retries. Ambiguous delivery need not be fully resolved before repeating the same desired assignment if the adapter establishes that all possible repeated/late effects remain compatible with the current request and physical envelope. Absolute writes alone do not establish ordering for an incompatible newer request; multi-register transitions, delayed starts and toggles need their own repeat/ordering evidence. Do not infer zero consumption or released headroom from a timeout or requested stop.

Retries must be rate-bounded, observable and durable across restart, with no fresh immediate burst on every plan or quarter. The detailed retry/backoff, retry-exhaustion recovery and adapter-specific repeatability rules remain engineering specification work. They must support automatic recovery from transient failures and must not recreate a permanent external-change hold under another name. A genuine unsupported command or equipment fault remains distinguishable from normal overwritable drift.

## Operating modes, handover and restart

The four existing modes distinguish observation, hypothetical participation and actuation:

| Mode | Planning and execution meaning |
|---|---|
| Monitoring | Observe the device and account for its actual load/state; SHS does not optimise its operation or write controls. |
| Planning | Include its hypothetical optimised operation in the plan; SHS does not generate execution attempts or write controls. |
| Control verification | Plan and validate/log proposed commands without physical writes or fabricated delivery. |
| Controlling (Control) | Operate the device under accepted policy and physical guards; automatically overwrite external deviations toward current SHS intent. |

Non-controlled consumption remains in actual household accounting. A hypothetical stop, discharge or heat request from Planning/Verification cannot release physical headroom or count as delivered service for live controlled devices. The existing implemented modes and verification behaviour are documented in the [integration mode record](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/device-operating-modes.md).

Leaving Controlling withdraws authority for further optimisation commands immediately. Already-issued commands still require reconciliation; existing approved device handover can make real writes and remain pending. Once released, SHS must not reassert the optimisation target in Monitoring, Planning or Verification. A displayed non-control selection must distinguish any release still in progress from completed handover. Re-entering Controlling requires current supported policy, observations and reconciled state, not replay of a saved step counter. Routine restart preserves the chosen mode and lease; it neither withdraws nor renews them.

Retain current battery handover semantics: Maximum Self Consumption with fresh configured rated charge/discharge limits. EV/pool use their captured legitimate baseline settings. External drift while Controlling does not silently replace captured baselines or veto handover. Handover is release of SHS control, not a promise that the physical device stops consuming power.

Persist operating-mode identity, issued/ambiguous operations, retry state and absolute deadlines with continuation state. Restart does not erase accounting, reset leases or initialise devices to defaults. Late effects must remain accounted for after a mode transition even though further optimisation retries are no longer permitted.

### Mode behaviour still to specify

The table preserves the existing four-mode distinction and applies Phil's authority correction. It does not settle the full replacement mode design. Specify before implementing:

- Settled 23 September 2026: one schedule serves every mode. Verification logs the requests Controlling would send; hypothetical relief never funds real actions in execution accounting.
- Mode scope for shared equipment: which independently controlled services have independent levers, and which group-wide commands require a common mode/authority boundary.
- The mode-transition contract: requested versus effective/releasing state, rapid mode changes during handover, release failure and delayed-command handling after exit. Entering Controlling executes the retained plan; it requires no fresh plan.
- Verification fidelity: current command-generation dry runs versus a stateful simulated controller, including which retry/recovery scenarios can be verified without physical evidence.

## Design provenance and implementation evidence

Earlier independent Claude/Codex reviews supported the synchronous reducer and asynchronous group effects. Those concurrency findings remain useful. Their previous external-hold, preservation-of-external-choice and explicit-resume policy is superseded by Phil's later full-control instruction; it is not an accepted alternative for this target. The detailed replacement operating-mode design remains open as listed above.

Optimistic per-group transactions were considered in the earlier concurrency review: each actor would version and commit shared resource reservations. That adds conflict retries and multi-group coordination to a home that already selects joint economic alternatives. Retain one atomic commit authority; revisit parallel calculation only if measured workload requires it. A global lock across device waits remains rejected. These concurrency decisions do not limit SHS authority to correct external drift.

Current implementation differs: `controller.py` holds `_async_tick`'s lock through device execution; service and confirmation stages each use 15-second deadlines. A non-observation error latches a key containing options, plan and slot, then attempts restoration. A new plan/slot can clear that failure key. Generic devices have external-change detection and current manual-override behaviour; these must be reconciled with mode-owned authority when implementing the replacement.

The pure reducer/journal trace prototype now tests: external edits between steps, ambiguous sends with safe repeat, late obsolete commands, bounded retry/recovery, mode exit during a pending operation, routine restart and independent-group progress. Next close the review's recovery gaps and implement the proposed mode/host contracts. Validate repeat/ordering assumptions per adapter. This documentation changes no runtime, schema, configuration, notification or hardware setting.
