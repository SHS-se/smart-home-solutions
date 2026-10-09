> Superseded on 9 October for battery scheduling and selection: see [whole-horizon battery allocation](battery-schedule-search.md). The guessed stress objective below has been removed at the user’s request; selection uses the supplied forecast score. Pool/EV span edits remain.

# Points-first move-and-resize trials

> **Changed 9 October 2026 (recipe `rule-forecast-opportunity-v4`).** The sections below record the original design, in which a trial was previewed against a bound and a shortlist was then given the full witness audit. That is no longer how a trial is judged:
>
> - **One projection scores a trial.** The score is the kronor score ([scoring](../planner-bench/scoring.md)), and nothing in it needs an audit of every family: economic certificates take no points. `builder::score` projects the commands, accounts them, and audits only a rule that scores by certificate, which with the restart rule on has nothing to certify. There is no preview bound and no shortlist; every trial's score is exact.
> - **A pass adopts all it can.** The best trial of a pass becomes the incumbent. The other improving trials are carried onto it in order of gain, each device's change applying where the incumbent still holds what the trial started from, and adopted where they still improve it.
> - **Order of trials.** Tariff points no longer order anything in the usual problem, which has no tariff rules. First come each run's steps: either end moved, or the whole run shifted, by 1, 2, 4, … quarters. Then the remaining edits by an estimate of the kronor they gain on the incumbent's own flows (curtailed sun free, exported sun at its sale price, the rest bought, and a store short of its cap credited for what it gains), the likeliest of each source and destination first. The estimate orders trials only.
> - **Certificates propose.** When no span edit improves the incumbent, the audit of every family runs on it and each proven alternative is scored as a trial; an adopted one sends the search back to the span edits. The same audit is the selected plan's report.
> - **Recipe.** 768 trials a pass (`repair_trials` 24), beam width 16, work grant 700 million. A unit of work now buys less overpriced audit preparation and more projection, so it costs more time; 700 million holds the local solve at the 0.3 s it took before. The narrower beam leaves that much more for the climb, which gains more from it on the eleven cases at every grant tried.
>
> Eleven cases, real-price lane, scorer v30: −780.1 before, −739.9 after, every case better; the builder's own account −563.8 → −520.4. All eleven now end `grant_exhausted`: the climb spends what it is given.
>
> **Changed again 10 October 2026 (recipe `rule-forecast-opportunity-v5`, policy `kronor-score-v8`).** Two things, both about the battery:
>
> - **Stress days.** A plan is carried out as booked on a day that is not its forecast: a battery that follows the house follows the real house, and a grid charge or a sale runs at the power the plan booked. The search therefore maximises `policy::objective`, not the forecast score alone: half of the plan's bill is taken as the mean of two stress days, the household's own load a quarter heavier with a quarter less sun, and the reverse (`policy::STRESS_DAYS`, `physics::carried`). Deductions and what the pool and car hold are the forecast's on every day. The selection reports both the forecast account and `objective_sek`.
> - **Battery modes.** The span edits only ever moved grid charges; every other battery command stayed as construction left it. `battery_modes.rs` now searches them: in spans of 1 to 32 quarters, each of supply (follow the house both ways), cover (supply the house, sell surplus: self-consumption with the charge ceiling closed), hold, left out, grid charge and sale. The pool and the car draw what the plan projected whatever the battery does, so a change is judged by carrying the battery and the grid alone through the forecast and stress days, first as an estimate over the span with what a kWh in the pack is worth where it ends (`values`), then exactly for the likeliest. What it selects is scored like any proposal before it is adopted. It runs before the span edits in every round.
> - **Recipe.** Work grant 760 million; the stressed search needs that to settle (at 700 million C-0920 lands 9 kr worse).
>
> Eleven cases: −739.9 → −723.3. The eight cases whose day differed from its forecast gain 20.7 between them (C-0905 +9.6, C-0920 +6.5); the three whose forecast is the measured day itself lose 4.1, the price of the stress days where nothing can go wrong. Bench-proven avoidable cost 67.9 → 54.5 kr; quarters with the battery left out 178 → 69. Local solve 0.31 → 0.35 s. On this bench the stress days alone do not raise the total over the battery-mode search without them (both −723): they move about 7 kr from the three exact-forecast cases to the eight others.

After joint construction and existing certificate repairs, the solver improves
the fully audited incumbent with complete command-span alternatives. The
comparison remains total additive points first, then grid cost plus declared
wear. No other objective or generic pool scheduler is introduced.

## Neighborhood

For pool heating, EV charging, and grid battery charging, identify constant
command spans outside the accepted prefix. Remove a span and relocate it with
its original device setting. Try adjacent-quarter lengths, geometric durations
(e.g. a three-quarter source can become seven quarters in one trial), and every
prefix/suffix of a contiguous tariff band. Only that device's command fields
change. Removed grid charging restores self-consumption permission. Other
bookings and the accepted hour remain intact.

Tariff points order generation, with rounds across source spans, destination
days and duration groups. This is proposal ordering; it cannot select a winner.
Physical projection enforces equipment capabilities, EV availability and
commitments. There is no cash-saving, comfort-preservation or equal-terminal-
inventory admission filter for these search proposals: those remain requirements
of economic *certificates*, not requirements for a points-improving plan.

## Scoring and bounds

Each pass previews at most `32 * repair_trials` distinct alternatives using a
whole-household physical projection and direct rule accounting. Direct points,
plus upper bounds for positive custom witness points and negative direct points
a witness exclusion can remove, bound the total
score because economic certificates only deduct. A preview unable to beat the
incumbent even under this bound is discarded.

A points-ranked shortlist retains representatives across devices and destination
days, then across duration groups. At most `repair_trials` alternatives receive
the same complete bounded witness audit allocation as construction candidates.
Only this fully audited total and the existing cash/wear tie-break can replace
the incumbent. Repeat from an improved incumbent; stop when the bounded pass
finds no improvement or the original work grant cannot fund another pass.

Enumeration, projection, scoring and audits share the existing work grant. At
least one complete audit is reserved while proposals are prepared and screened;
final certification retains its separate reservation throughout. A declined
trial never invalidates an already certified candidate. Termination still
reports grant exhaustion rather than suggesting global optimality.

Native diagnostics report `move_resize_trials`, `move_resize_passes` and
`move_resize_improvements` (passes that improved the incumbent). Recipe
`rule-joint-move-resize-v2` records the changed algorithm; the work grant,
construction beam, rule points and witness allocation remain unchanged.

## Regression coverage

Native tests start from deliberately inferior pool, EV and battery spans. A
complete earlier, longer trial wins on points even when its cash cost rises;
the pool's -2 restart deduction is included. Tests also preserve the accepted
prefix and retain a fully audited incumbent plus final certification budget
when further search is unaffordable. Native/Wasm parity covers exact commands,
physical trajectories, accounts and work diagnostics.

## Case replay findings

Compared with the preceding thermal-buffer refinement, using the same captured
cases and rules, the independent measured bench results are:

| Case | Previous points | New points | Previous grid cost | New grid cost |
|---|---:|---:|---:|---:|
| C-0905 | -43 | 0 | 225.42 kr | 226.18 kr |
| C-0717 | 18 | 116 | 120.48 kr | 338.42 kr |

C-0905 replaces the September 8 07:00–07:45 pool burst with September 7
22:15–September 8 00:15, inside the previously missed cheap window. Its forecast
native account improves from 66 to 96 points, including restart deductions.

C-0717 exposes a remaining incentive in the existing rules: the selected pool
run spans July 17 08:15–July 20 00:00. One uninterrupted eligible episode earns 121
buffer points, July 18 02:00–July 19 08:15, for the July 19 low-solar event. This is
not repeated-event credit. The rules continue paying for warm quarters during
one long heating run, while the separate overheating comparison does not
penalize warmth justified by an adverse future day and cannot assess the final
day. Search therefore finds higher points at substantially higher cash cost.
No arbitrary thermal ceiling or extra objective was added to conceal this
result. A subsequent rule refinement should reward heating demonstrably
displaced during the adverse event rather than indefinite warm holding.

The subsequent [stop-and-coast refinement](thermal-buffer-events.md) closes this
incentive in the point rules. The original 39.343°C July trial cannot prolong its
buffer credit by continuing to heat, earns no cheap-load credit for pool heating
past the reserve, and incurs overheating deductions. A new replay peaks at
32.519°C and costs 116.60 kr. The earlier table records the prior rule version;
its point totals cannot be compared directly with scores under the refined rules.
