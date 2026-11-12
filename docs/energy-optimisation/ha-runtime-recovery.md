# Home Assistant readiness and recovery — September 2026 record

For current behavior, see the [authoritative plan contract](authoritative-plan-contract.md),
the [automatic replan policy](replan-error-policy.md), and the
[app control-continuity contract](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/control-continuity.md).
The current app keeps its last settings through restart and transient source
loss. The dated implementation notes below describe the September runtime.

## Scope-preserving recovery — 15 September 2026

Persist and validate participation and battery supply/solar-attribution identities alongside existing policy, ownership and pending effects. Restart cannot revive excluded or demoted control, invent subgroup observations, reset accounting or broaden supply to the whole house/rating. Existing explicit release and durable-effect rules remain; this decision introduces no recovery fallback.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

[Architecture](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Contracts](contracts-and-data.md#plan-lifecycle-and-time) · [Target restart continuity](reactive-controls.md#expiry-and-baseline-handover)

Status checked against backend and HA source on 13 September 2026. This replaces the beta.32-era minute polling, short readiness lease and 1/2/4/5-minute retry description. Plan recovery is implemented; the target actuator-continuation journal is not.

## Accepted plan and local execution

HA restores its persisted accepted plan and validates it using the normal contract/expiry checks. Only accepted and currently valid supported requests can execute, subject to live equipment/source guards. The backend currently sets `valid_until` to the last returned slot end, normally up to the 72-hour horizon. `binding_until` marks published-price coverage, not the right to execute later slots. Local quarter transitions do not require a backend call.

In September, the coordinator exchanged measurements, a fresh snapshot and
runtime status every 15 minutes. Price releases and manual requests started
solves. Other triggers became recommendations. Failed attempts retried on later
exchanges. Startup restored configuration and the accepted plan before the
initial exchange.

## Portal evidence and timestamps

Historical acceptance and the latest reported local runtime state remain separate. Authenticated `integration-status` reports identify the home, plan, local readiness/reason, recovery and planning error. The portal compares the reported identity with the displayed plan and uses explicit plan validity; it does not implement the former rule that a 150-second-old report or elapsed binding boundary automatically expires the plan. A last report is not continuous physical execution evidence and must be shown with its timestamp.

The **inbound observation validation** still rejects reports more than 150 seconds old or 30 seconds in the future. This transport admissibility check is different from an execution lease or a portal TTL for previously accepted reports. Out-of-order reports are ignored. A report for another plan cannot establish readiness for the currently displayed plan, and missing reports do not prove devices have stopped.

## Restart status and target

The September controller restored journalled device settings on startup before
resuming requests. Orderly unload also handed control back. Restoring a cached
plan in that version could cycle devices.

The settled target is durable suspension and adoption across frequent routine restarts/reloads: retain the accepted plan, intent and mappings, measured-use ledger, reservations, physical requests, issued operations and absolute deadlines; reconcile live state and downtime uncertainty before continuing. No default initialisation or gratuitous baseline handover just because HA restarted. Persist operating modes, pending release and bounded retry state too; new slots, plans and restart neither renew authority nor reset retry pacing. External drift while Controlling is automatically reconciled/reasserted and does not create a hold. Follow [shared-entity reconciliation](control-reconciliation.md) before issuing or repeating a command. Expiry and genuinely unsupported physical state still restrict authority, and a restart cannot extend a lease. The full lifecycle and remote-command completion contract lives in [reactive controls](reactive-controls.md#expiry-and-baseline-handover), with [acceptance cases](verification-and-delivery.md#intent-and-reactive-execution-acceptance).

These corrections change documentation only. They do not deploy the original beta.32 rollout or implement the replacement runtime.
