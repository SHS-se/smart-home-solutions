# Battery curve editing and prompt replanning

A saved `battery` row in `energy_optimisation_value_curves` is the exact customer
curve. Its horizontal coordinate is usable stored kWh above minimum SOC; its
vertical coordinate is SEK per stored kWh. It replaces the automatically derived
valuation, including its terminal replacement-price cap. Equipment limits still
apply. This is a value preference, not an SOC-at-time target or a power setting.

No row selects automatic valuation. The diagnostic publishes `source`, the active
`curve`, and `automatic_curve` for an explicit return to automatic mode. A malformed
custom curve fails validation; it never silently selects automatic valuation.
The portal offers an explicit removal action for an invalid stored curve.

Dragging and arrow keys move individual points. Numeric controls allow exact
coordinates. Applying a point count resamples between the current endpoints;
replanning never resamples a saved custom curve. Points follow the solver's existing
ordered-energy, nonnegative, nonincreasing-value requirements. Value becomes zero
beyond the final point. Blue always comes from the published plan; orange is the
draft or saved preference awaiting a new plan. A background refresh preserves
unsaved edits.

Manual replans remain durable requests answered with fresh HA measurements through
ordinary ingest. A private database broadcast wakes a device-authenticated bounded
wait on `integration-status?wait_for_replan=true`. The service role subscribes on
behalf of the authenticated home; no realtime credential or plan payload reaches
the device through that channel. HA serializes duplicate request IDs and waits
through active pushes. The fifteen-minute exchange still uploads completed history;
a manual replan skips that history upload and captures fresh planner inputs.
The portal polls deltas every second only while a request is pending. The worker
assembles its final result in the last compute request instead of making an
assembly-only round trip.

## Rollout and measurement

Apply `20260919121000` and `20260919121100`, deploy the changed ingest, fixed-plan,
plan-step and integration-status functions, then deploy the portal and install HA
`0.9.0-beta.24`. The new planner model is v38. Request a new plan to populate the
version-2 curve diagnostic before using its editor.

Measure click-to-visible completion on the deployed installation before claiming
the five-second goal. Local solver timing is not end-to-end evidence. The mocked
browser regression requires publication to become visible within 4.5 seconds;
it does not simulate real capture or server latency.

HA logs capture, cloud-ingest and total request durations under the portal request
ID. Ingest logs input preparation and publication elapsed times with both portal
and HTTP request IDs. The worker client logs stage count and total planning time;
each worker logs its own stage time. These are local durations, not differences
between unrelated device/server clocks. Network loss, an existing slow push,
model refitting and edge execution remain conditions to measure during rollout.
