# Producer, planner and executor qualification

These are independently authored synthetic equipment, history and external I/O
ports. No recorded household input, anonymised replay or generated expected plan
is included.

Run from the planner repository after checking out the exact HA revision in
`ha-revision.json`:

```sh
python3.13 -m venv /tmp/shs-qualification
/tmp/shs-qualification/bin/pip install -r /path/to/pinned-ha/app/requirements.txt
deno run --no-check --sloppy-imports --allow-read --allow-run scripts/qualify-planner-integration.ts \
  --ha-repo /path/to/pinned-ha --python /tmp/shs-qualification/bin/python
```

The command refuses a different revision or changed tracked HA production files.
Dependencies come from that pinned HA repository's exact requirements, not a
second copy of its dependency lock. Updating the pin is an intentional producer
rollout and must be reviewed with the producer changes.

The Python bridge runs the real `Household._build_optimisation_snapshot`, including
empirical device/base-load modeling, service construction, schema 10 scope and
JSON serialization. Synthetic ports supply retained electrical capability,
recorded demand, sensor state and supplier tariffs. The candidate TypeScript
planner then prepares and solves that captured input; server-owned comfort
preferences and accepted thermal calibration are supplied at their normal
boundary. No producer field is repaired by the test.

The returned JSON is admitted by the actual HA `validate_plan_contract` and
`scoped_plan`, encoded by `device_intent`, executed by `DeviceGateway` and
`NativeExecutor`, and sent through the durable sqlite `CommandTransport`. Only
external sensor/service and host persistence ports are synthetic. The source
adapter's RPC and canonical configuration checks have separate HA unit tests.

The handwritten assertions establish:

- Missing electrical evidence stays unknown; an explicit numeric configuration
  supplies the bound even with no peak evidence.
- 12 A and 15 A charging alongside the full 3,600 W pool ON bound, despite
  1,200 W current and quarter-average pool observations.
- Identical complete future charging schedules with either cable state;
  disconnected physical execution reports temporary absence.
- All 288 room relay quarters execute, and the published temperature graph
  agrees with an independently specified physical plant driven by those actual
  commands. The effective synthetic room recovers comfort and stops heating.

Negative controls reject minimum/maximum-only EV choices, an averaged pool
rating, excess household import, and flat or inconsistent room projections.
These tests complement protected planner contracts, schema fixtures and hosted
CPU measurements. They do not establish arbitrary household calibration quality
or prove the versions installed on a live deployment; those need fresh deployed
capture and execution evidence.
