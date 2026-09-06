# Historical record: Portal And Reporting

[Architecture index](../../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [History index](README.md)

> **Historical evidence, not current requirements.** This is a preserved part of the pre-split document, including superseded claims, old implementation statuses, and unresolved experiments. The current topic specifications linked from the architecture index take precedence. References to deployed behaviour describe the date of the original entry, not a fresh verification.

<!-- BEGIN PRESERVED SOURCE -->
<a id="legacy-section-1.3"></a>

### 1.3 Portal surface and energy-performance decisions (2026-08-13)

Decisions taken with Phil on 2026-08-13. Recorded here because they change what
the portal is *for*, not just how a screen looks.

<a id="legacy-section-1.3.1"></a>

#### 1.3.1 The energy-performance page was reporting a fabricated class

The Energiprestanda card showed **class A, 43.9 kWh/m²·år** for a 424 m² house in
Täby. The figure reconciles exactly with `src/lib/energiprestanda.ts`:

```
annualize = 365 / 43 = 8.488
heating 648 + hot water 8480 + cooling 9 + property 1204 = 10,341 kWh
10,341 × 1.8 / 424 = 43.9 kWh/m²  →  48.8% of 90  →  A
```

Working backwards, the window held **76 kWh of heating over 43 days ending
2026-08-11** — late June to mid-August. A pure summer sample was multiplied by
8.5 and presented as an annual heating figure. At this Atemp the class
boundaries sit at heating ≤ 907 kWh (A), ≤ 6,207 (B), ≤ 11,507 (C), ≤ 18,927 (D),
against roughly 10,261 kWh lifetime on electric heaters and 11,443 kWh on
aircon. The honest answer for this house is around C/D.

Five defects, all confirmed by reading the code rather than inferred:

| # | Defect | Location |
|---|---|---|
| 1 | `MIN_COVERAGE_DAYS = 30` plus naive linear `365/n` annualization. Heating is the most seasonal quantity in the building and is extrapolated from the least informative days of the year. | `energiprestanda.ts:36,191` |
| 2 | Two annualization gates differing by 10×, and the weaker one wins. The grid-import estimate refuses to annualize below `MIN_ANNUAL_COVERAGE_DAYS = 300`; the measured path annualizes from 30; `resolveEnergyPerformance` gives measured unconditional precedence. 43 days of summer HA data therefore override a year-plus of Ellevio data. | `energy-usage-series.ts:187`, `energy-performance.ts:139` |
| 3 | Two large errors partly cancelling, which is why the output looked plausible. Heating understated ~20–30×; hot water overstated ~4× (BEN's 20 × Atemp gives 8,480 kWh against ~2,000 kWh/yr measured). 82% of the total is a constant shared by every 424 m² house in Sweden, so the number barely measures the building. | `energiprestanda.ts:225` |
| 4 | The screen contradicts itself: the row is labelled "Heating (degree-day corrected)" while the evidence card says "No degree-day correction". `degreeDayFactor` needs ≥328 days of weather *inside the window*, so it is null and silently becomes ×1. Included posts are annualized, excluded posts are measured, both shown as bare kWh in adjacent columns. | `energiprestanda.ts:199-213`, `EnergiprestandaSection.tsx:379,417` |
| 5 | No geographic adjustment factor in the measured path at all, and Stockholm's 1.0 hardcoded in the estimate. Per BBR 31 (BFS 2024:14) Table 9:2c, F_geo applies to the heating term; the calculation is only valid where F_geo = 1.0. `energyClassForEp` also classifies against a flat 90 while the UI classifies via `smallHouseNewBuildRequirement`; they diverge below 130 m². Dead code today, wrong dead code. | `energiprestanda.ts:66`, `indicative-energy-performance.ts:28` |

Defects 1 and 2 are **deliberate and tested** — `energy-performance.test.ts`
contains `'prefers measured category data over the grid estimate'` and
`'reports medium confidence when category data covers only part of the year'`.
Correcting them changes tested intent; it is not a patch.

<a id="legacy-section-1.3.2"></a>

#### 1.3.2 Cold start is the primary path, not the fallback

Phil's house is not the normal case. Most customers will have, at best, a
whole-home total — often from a solar inverter's load meter rather than the
utility meter, so understated by whatever the inverter does not see. Per-category
measurement is the exception; **disaggregating a single total against a
reference model is the norm.**

This inverts the precedence in `energy-performance.ts`. The decision:

- Build an **archetype prior library**: expected annual kWh per BEN category,
  keyed on `dwelling_type` × `year_built` band × `heating_types` × climate, from
  published Swedish housing-stock statistics with the source and confidence
  recorded per entry.
- Measured per-category data wins **only at sufficient seasonal coverage**,
  measured as captured heating degree days against the normal year — never as a
  day count.
- Below that, show the prior (or the grid-import estimate where whole-home
  history exists), badged **modelled, not measured**, blending toward measured
  as coverage grows.
- The same layer serves the prospect pitch and the honest partial-year answer
  for a connected customer, so it is built once.

`home_questions` already carries the archetype key: `year_built`,
`dwelling_type`, `heated_boarea_m2`/`heated_biarea_m2`, `heating_types`,
`hot_water_type`, `occupants`, `has_solar`/`has_battery`/`has_ev`, `main_fuse_a`.

<a id="legacy-section-1.3.3"></a>

#### 1.3.3 Historical backfill is an integration action, not a one-off script

`recorder.purge_keep_days: 30` purges **states**; long-term statistics for
`total_increasing` energy sensors are retained indefinitely at hourly resolution
and are readable through `recorder/statistics_during_period`. A customer's full
history is therefore already available locally.

Decision: implement it as a `shs_energy` backfill action that walks statistics
and posts daily category totals through the existing ingest endpoint, rather
than a bespoke script for one house. Any customer with history benefits, and the
houses that do have category history become the calibration set for [§1.3.2](portal-and-reporting.md#legacy-section-1.3.2)'s
priors.

<a id="legacy-section-1.3.4"></a>

#### 1.3.4 The legacy simulator UI is removed

[§3.1](contracts-and-controls.md#legacy-section-3.1)'s limitations table stands, but the conclusion changes: the browser
simulator is not retained as a product surface. The **library** (`simulate-device-day.ts`
and the five device models) is kept for counterfactual and replay work; the tabs
built on it are deleted.

Verified before agreeing to the removal — none of these tables are read by the
planner path:

| Surface | Only consumers | Superseded by |
|---|---|---|
| `HomeDevicesTab`, `AddDeviceModal` (`home_device_assignments`) | `SimulatorTab`, `HomeDevicesTab`, `AddDeviceModal` | `energy_optimisation_devices` from Energy Dashboard discovery |
| `HouseSetupTab` (`energy_home_settings.ua_w_per_k`, `thermal_capacity_class`, `overrides`) | `SimulatorTab`, `HouseSetupTab` | Empirical per-zone fit ([§9.3](models-and-delivery.md#legacy-section-9.3)) |
| `TariffPricingTab` (`tariff_instances`, `energy_home_settings.tariff_instance_id`) | `SimulatorTab`, `TariffPricingTab` | `energy_tariff_profiles`/`_settings`/`_versions`, served by `integration-tariff` and edited at Settings → Energy Tariff |

`HouseSetupTab` also edited `home_answers`, but `/portal/home-profile`
(`HomeProfileForm`) loads **all** active `home_questions` and upserts the same
table — a strict superset. Deleting the tab loses no archetype input. That route
must stay reachable: `integration-tariff` reads `home_questions`/`home_answers`
directly, so the home profile is load-bearing for the live integration.

<a id="legacy-section-1.3.4a"></a>

#### 1.3.4a Reference data behind the archetype priors

Implemented in `src/lib/energy-archetypes.ts`. Every number carries a
`provenance` of `published`, `interpolated` or `modelled` and a source string;
nothing in the table is an unattributed guess.

**Source** — Energimyndigheten, *Energistatistik för småhus 2024*, workbook
`smh_2024_tabellverk_v2.xlsx` (2025-06-10), committed to the repository so the
constants can be re-derived. Tables 2.14 (by build year) and 2.15 (by heating
system), both **temperature-corrected**, both heating and hot water only,
excluding household electricity and excluding heat absorbed from ground/air by
heat pumps. That basis is the delivered ("köpt") energy the BBR primary-energy
number is built from. Temperature-corrected is used throughout because a prior
should describe a normal year — the same basis the degree-day normalization
targets.

| Build year | kWh/m² | | Heating system | kWh/m² | ÷ 93.3 |
|---|---|---|---|---|---|
| ≤1940 | 113.6 | | Enbart elvärme (d) | 74.0 | 0.793 |
| 1941–1960 | 93.9 | | Enbart elvärme (v) | 64.8 | 0.695 |
| 1961–1970 | 89.4 | | Berg/jord/sjövärmepump | 50.2 | 0.538 |
| 1971–1980 | 81.1 | | Enbart fjärrvärme | 122.4 | 1.312 |
| 1981–1990 | 94.7 | | Enbart biobränsle | 167.9 | 1.800 |
| 1991–2000 | 98.4 | | Olja | 176.7 | 1.894 |
| 2001–2010 | 82.3 | | **SAMTLIGA** | **93.3** | 1.000 |
| 2011–2020 | 55.5 | | | | |
| 2021– | 40.2 | | | | |

**Two confident assumptions were wrong**, and both are recorded in the module
and pinned by tests so they cannot quietly return:

1. **Energy use is not monotonic in build year.** It falls to 81.1 for
   1971–1980, then *rises* to 94.7 and 98.4 for the 1980s and 1990s. The
   interpolation put 1991–2000 at 72 against a published 98.4 — a 26 kWh/m²
   error, more than a class boundary for a large house. A 1990 house now scores
   worse than a 1975 one, which is counterintuitive and published.
2. **Direct electric heating is *below* the stock average.** The modelled factor
   was 1.35, reasoning that a resistive house buys every kWh of heat it uses.
   Published: 0.793. The physics was right and the baseline was wrong — the
   stock average is dragged up by oil (1.894) and biomass (1.800) homes, and
   electrically heated houses skew newer and better insulated.

**Remaining modelled values**: dwelling-form multipliers; air-air, exhaust-air
and air-water heat pumps, which table 2.15 does not separate (they are electric
heating and sit inside the "enbart elvärme" rows, which already blend homes with
and without them); property energy at 3 kWh/m². The build-year × heating-system
combination is multiplicative, which assumes independence they do not exactly
have — newer homes are likelier to have heat pumps, so some effect is counted
twice. Tables 2.18–2.20 give published joint values but only for bergvärme and
the two electric categories, and are *inklusive hushållsel*, so they are not a
drop-in replacement.

Energimyndigheten also publishes an "uppgift saknas" row at 108.8 — homes with
no recorded build year use well above average. We deliberately use SAMTLIGA
(93.3) instead when build year is unknown: a blank in our questionnaire is not
the same population as a blank in the property register, and assuming the worst
about a prospect's house is not a neutral default.

Reference home (424 m², 43 summer days of category data, prior only): **EP 128.6
→ class E** for a 1975 air-air-heated build, against the 648 kWh of heating and
class A the old page produced. The E is **not a claim about that house** — it is
the prior for an un-upgraded build of that age and size, and **`home_questions`
has no renovation input**, so the prior is structurally pessimistic for an
improved older house. That is the right direction for a prior and is what
blending with measured data exists to correct, but a renovation-year question
would materially sharpen the cold start.

<a id="legacy-section-1.3.4a-2"></a>

#### 1.3.4a-2 Ground truth: the 2020 energideklaration for the reference home

An official certificate for the reference home (Porfyrvägen 10, Täby;
Energideklarations-ID **1110952**, John Eriksson, Svensk Kvalitetssäkring,
2020-08-27, measurement period 2019-08 → 2020-07) is the first hard validation
of any of this. Every figure below is from that document.

| Field | Value |
|---|---|
| Nybyggnadsår | **1970** |
| Atemp, **measured** (excl. warm garage) | **435 m²** |
| Heating system | Värmepump-luft/luft (el) + el (direktverkande) |
| Ventilation | Självdrag (no heat recovery) |
| El (direktverkande) | 2,200 kWh |
| Värmepump-luft/luft (el) | 8,350 kWh |
| Tappvarmvatten (el) | 6,700 kWh |
| Fastighetsel | **0** |
| Hushållsel (excluded) | 13,050 kWh |
| Sum 1–17 (measured) | 17,250 kWh |
| Byggnadens energianvändning (normal-year) | 19,567 kWh |
| Byggnadens primärenergianvändning | 31,307 kWh |
| **Energiprestanda** | **72 kWh/m²·år → class C** |
| Specifik energianvändning | 45 kWh/m²·år |
| Referensvärde 1 (nybyggnadskrav) | 90 kWh/m²·år |
| **Referensvärde 2 (liknande byggnader)** | **148 kWh/m²·år** |

**Three facts fall straight out of the arithmetic and settle open questions:**

1. **F_geo for Täby is exactly 1.0.** 19,567 × 1.6 = 31,307 to the kWh, so the
   heating term was divided by 1.0. [§1.3.1](portal-and-reporting.md#legacy-section-1.3.1) defect 5 listed F_geo as unknown;
   for this municipality it is now known.
2. **The electricity weighting factor was 1.6, not 1.8.** 31,307 / 19,567 =
   1.6000. BBR 29 (BFS 2020:4) raised it to 1.8 effective 2020-09-01 — three
   days after this certificate was issued. **Any comparison against an older
   declaration must restate it**, or the same house appears to get worse for a
   purely regulatory reason.
3. **72 restated on today's factor is 81 kWh/m² — still class C** (90% of the
   90 requirement).

**Why the portal said E where the certificate said C.** They are not
measurements of the same thing, and the prior is behaving correctly:

| | kWh | vs actual |
|---|---|---|
| Actual heating (normal-year) | 12,867 | — |
| Actual hot water | 6,700 (15.4 kWh/m²) | — |
| Actual fastighetsel | 0 | — |
| **Actual building energy** | **19,567** | — |
| Prior heating | 23,944 | **1.86×** |
| Prior hot water (BEN 20 × Atemp) | 8,700 | 1.30× |
| Prior property energy | 1,305 | ∞ |
| **Prior building energy** | **33,949** | **1.74×** |

The prior gives **140.5 kWh/m²** for this house. Boverket's own *Referensvärde
2, liknande byggnader* on the same certificate is **148**. The prior is within
**5%** of the authority's figure for comparable buildings — it is predicting
"a typical 1970 Täby småhus of this size" accurately. This house measured
**81 kWh/m² restated, i.e. 55% of typical**. It was already an outlier in 2020,
and the improvements since then move it further down, not up.

So the C→E gap is almost entirely *this house being much better than its
cohort*, plus a 1.6→1.8 accounting change. It is exactly the situation the
"modelled, not measured" badge exists for, and it is the strongest possible
argument for the renovation input noted in [§1.3.4a](portal-and-reporting.md#legacy-section-1.3.4a).

**Three corrections the certificate forces:**

- **Property energy must be 0 for a detached småhus, not 3 kWh/m².**
  Fastighetsel is common-area/plant electricity; a friliggande småhus has
  none. Note the HA `property_energy` category is a *different* concept and
  must not be mapped onto BBR fastighetsel without thought.
- **BEN's 20 kWh/m² hot-water schablon overstates for large houses.** A
  certified expert recorded 15.4 kWh/m² for this building. It is still the
  regulation-prescribed normalisation and we keep using it, but the page must say so,
  because for a 435 m² house it is 26% of the whole primary-energy number.
- **A measured Atemp should beat our estimate.** Official 435 m² against our
  boarea+biarea estimate of 424 — only 2.5% out, which is reassuring for homes
  with no certificate, but where a certificate exists its Atemp is authoritative.

<a id="legacy-section-1.3.4a-3"></a>

#### 1.3.4a-3 Energideklaration upload (implemented 2026-08-13)

Certificates are parsed by the **existing** energy-data upload (Energy history →
Data), not a new surface. The uploader already distinguishes grid invoices,
electricity invoices, grid import and whole-home CSVs; a declaration is a fifth
kind. It is tried **before** the invoice parsers, because it is unambiguous to
detect and would otherwise be rejected with a useless `unknown_format`.

| File | Role |
|---|---|
| `src/lib/energy-declaration-parser.ts` | Pure parser. Accepts both the one-page summary and the full declaration. |
| `src/lib/energy-declaration-storage.ts` | Import, fetch latest, and `restatedPrimaryEnergy()`. |
| `supabase/migrations/20260813100000_add_energy_declarations.sql` | Table + `create_energy_declaration` definer function. |

Design points worth keeping:

- **Posts are parsed by number, not label.** Boverket's form numbers its energy
  rows (1)–(19) and those numbers are stable; the labels are translated,
  reordered and footnote-marked between versions. A row printed without a value
  ("Fjärrvärme (1) kWh") must stay *absent* rather than becoming zero, or an
  all-electric house acquires phantom district heating.
- **The weighting factor is taken from the document, not its date.**
  `primary_energy_kwh_per_year / building_energy_kwh_per_year` gives 1.6000 on
  the reference certificate. That is immune to a misparsed date and to
  transitional issuance. The date is the fallback.
- **Only structured data is stored**, matching the invoice behaviour. The PDF is
  not retained.
- **Writes go through a SECURITY DEFINER function** with direct INSERT revoked,
  matching `create_energy_billing_document`. A client must not be able to invent
  a certificate or fabricate an energy class.

One defect worth recording because the live document did not catch it: the
first version of the kWh/år pattern allowed the digit run to start mid-word and
to span a newline, so the footnote marker in "primärenergianvändning**6**" was
read as part of the value — 19,567 became 619,567, which in turn made the
implied weighting factor 0.05. The real PDF happened to lay out in a way that
hid this; the test fixture did not. Anchoring with `(?:^|\s)` and a space-only
inner class fixed it. **The fixture is more adversarial than the source
document, and that is the point of having one.**

<a id="legacy-section-1.3.4a-4"></a>

#### 1.3.4a-4 Typed events (implemented 2026-08-13)

Events existed as free text on a date, drawn on the charts, entered from a form
buried under a chart in Comparisons. That makes them a caption. They are now an
**input**, because most of what looks wrong in energy data has a mundane
explanation only the customer has: they were away, the heat pump was broken,
someone moved in.

They live at **Energy history → Events**, alongside Data, because they explain
the data. Deliberately *not* added to `home_questions`, which is already
overloaded and is about the building rather than its timeline.

The axis that matters is not the label but the treatment:

| Treatment | Types | Effect |
|---|---|---|
| **Step** | renovation, heating system change, solar/battery installed, major load added/removed, occupancy increase/decrease | Data before the date describes a different house or household. Comparison across it is not like-for-like. Does **not** remove days. |
| **Period** | absence, guests, equipment fault | Those days happened but are unrepresentative. Excluded from anything that fits a model. Carries an end date, enforced by a check constraint. |
| **None** | other | Recorded and drawn, affects no calculation. Every pre-existing untyped note defaults here, so nothing retroactively changes. |

Wired in: `energiprestanda` drops flagged days from both the energy *and* the
degree days (dropping a fortnight's kWh while keeping its cold days would make
a house look worse for having gone away), reports `excludedDayCount`, and the
performance card names the adjustment rather than making it silently.

**A defect this found, and the invariant that now prevents it.** The first
implementation applied a renovation by shifting the effective build year toward
the renovation year — a 1970 house renovated in 1990 was treated as built in
1990. The published band table is **not monotonic** (1981–1990 uses 94.7 kWh/m²
against 89.4 for 1961–1970), so recording a renovation made the rating *worse*:
135.1 → 142.6 kWh/m². The bands describe original construction cohorts, not
renovation states.

A renovation is now a direct reduction in modelled heat demand — physically what
it is, and monotone by construction. The magnitude (15%) is `modelled` and
applied once regardless of how many renovations are recorded.
`heating_system_change` deliberately takes no discount, because the published
per-system factors in `HEATING_SYSTEM_FACTORS` already carry that improvement
and applying both would count it twice. A test now pins the invariant:
**a recorded renovation must never make the modelled rating worse.**

One further test note worth keeping. "Excluding a holiday must not distort the
degree-day ratio" initially failed with a 3.5 kWh/m² swing depending on whether
the excluded fortnight was in winter or summer. That was the *fixture*, not the
code: it used a flat 12 kWh/day of heating, which violates the proportionality
the whole normalization rests on. Under a physical fixture — heating
proportional to degree days — the estimator is unbiased, as it should be.

<a id="legacy-section-1.3.4b"></a>

#### 1.3.4b The staff Device Catalog is removed too

Checked before agreeing: `device_types`, `device_instances`, `device_profiles`
and `performance_data` are read only by the simulator/catalogue components,
`src/lib/simulator/device-bindings.ts`, `src/lib/performance-data.ts`, and the
`delete-customer`/`delete-contact` cleanup functions. Nothing in the planner
path touches them.

The catalogue also holds no data — the Devices list is empty, and the type
taxonomy already contains visible duplicates (Air-Air Heat Pump, Appliance,
Base Load, Electric Heater, EV Charger and Hot Water Heater each appear twice).
There is nothing to preserve.

It is **not** needed for cold start: the archetype layer is building-level
(kWh/m² per BEN category by build year, dwelling form and heating system), not
device-level, and `include_in_standard_home` carries no information while the
device tables are empty.

One caveat for the future: [§9.1](models-and-delivery.md#legacy-section-9.1) assigns device dynamics to "manufacturer
profile, then measured calibration", so a manufacturer-profile store has a
designed role. It should be reintroduced as a fresh design against the schema-5
device contract rather than by preserving this schema.

<a id="legacy-section-1.3.4c"></a>

#### 1.3.4c Implementation status (2026-08-13)

Energy-performance correction and cold-start priors are **implemented**:

| File | Change |
|---|---|
| `src/lib/energy-degree-days.ts` | New. HDD/CDD, normal-year degree days, and `seasonalCoverage()` — the fraction of a normal year's degree days that fell inside the days actually measured. |
| `src/lib/energy-archetypes.ts` | New. Build-year bands, heating-system and dwelling factors, `archetypePrior()`, `disaggregateWholeHome()`, questionnaire normalizers. |
| `src/lib/energiprestanda.ts` | Rewritten. Per-post normalization (heating on HDD, cooling on CDD, property linear, hot water by BEN standard), seasonal-coverage gate, F_geo on the heating term, per-category coverage days, class bands expressed as percentages of the building's own requirement. |
| `src/lib/energy-performance.ts` | Precedence inverted: measured → grid estimate → modelled prior, with blending between the coverage thresholds. Adds `isModelled`, `measuredWeight`, `geographicFactorAssumed`. |
| `src/lib/home-profile-functional-data.ts` | Also reads `year_built`, `dwelling_type`, `heating_types` for the prior. |
| `EnergiprestandaSection.tsx`, `EnergyHistory.tsx` | "Modelled, not measured" badge, a basis message naming what the figure rests on, heating-season coverage replacing the day count, and the degree-day label contradiction removed. |

Thresholds: heating may not be extrapolated below **60%** of a normal year's
heating degree days, stands alone at **90%**, and is blended linearly between.
`MIN_COVERAGE_DAYS = 30` is gone.

Verified by compiling the modules with `tsc` and running the assertions under
Node (Deno is not installable in the agent sandbox; `deno task test` remains the
project runner and both suites are written for it). 28/28 on the performance
pipeline, 17/17 on the archetype table. `tsc --noEmit` and `eslint` are clean.

Effect on the reference home's 43-day summer window:

| | Before | After |
|---|---|---|
| Heating-season coverage | not measured (43/365 = 11.8% of *days*) | **0.97%** of a normal year's degree days |
| Method | `measured_categories` | `insufficient_heating_season` → falls through |
| EP | 43.9 kWh/m² | 128.6 kWh/m² from the prior |
| Class | **A**, "medium confidence" | **E**, "low confidence, modelled not measured" |

With Ellevio history present the live page will resolve to
`estimated_from_grid` rather than the prior. The true answer arrives after a
winter of category data. See [§1.3.4a](portal-and-reporting.md#legacy-section-1.3.4a) on why the prior reads pessimistically for
this house.

<a id="legacy-section-1.3.5"></a>

#### 1.3.5 Portal navigation

- The page is renamed **Energy Optimisation / Energioptimering**.
- `LoadShiftTab`'s four `PlanningDimension` values are promoted to top-level
  tabs. The resulting tab set is **ROI · Plan · Power · Thermal · Economics ·
  Storage**, with `Plan` holding the plan header cards (issue time, source,
  cost difference, battery low, validation errors) so the four dimensions are
  charts only.
- Multiple homes remain supported; `HomeSelector` stays.
- `Home Setup`, `Home Devices`, `Tariff & Pricing` and `Simulator` are removed
  per [§1.3.4](portal-and-reporting.md#legacy-section-1.3.4), and the staff `Device Catalog` route per [§1.3.4b](portal-and-reporting.md#legacy-section-1.3.4b).
- `/portal/home-profile` and Settings → Energy Tariff must stay reachable —
  they are where the archetype inputs and the real tariff now live.

<a id="legacy-section-1.3.5a"></a>

#### 1.3.5a Navigation restructure (implemented 2026-08-13)

Delivered as decided in [§1.3.5](portal-and-reporting.md#legacy-section-1.3.5):

| Change | Detail |
|---|---|
| Page renamed | **Energy Optimisation / Energioptimering**, in the page, sidebar and customer dashboard card |
| Tabs | **ROI · Plan · Power · Thermal · Economics · Storage** |
| `LoadShiftTab.tsx` → `PlanWorkspace.tsx` | Internal `PlanningDimension` state replaced by a `section: PlanSection` prop |
| Deleted | `SimulatorTab`, `HouseSetupTab`, `HomeDevicesTab`, `TariffPricingTab`, `DeviceCatalogTab`, `DeviceModelsTab`, `DeviceTypesManager`, `HouseModelTab`, `AddDeviceModal`, `DeviceEditorForm`, `CurveUploadModal`, `PerformanceDataEditor`, `PerformanceDataStatus`, `PerformanceCurveChart`, `EnergyVsTempChart`, `LoadCurveChart`, `pages/portal/DeviceCatalog` |
| Also removed | the `/portal/device-catalog` route, its sidebar entry and its dashboard card |
| Retained | `src/lib/simulator/*` for counterfactual/replay work ([§3.1](contracts-and-controls.md#legacy-section-3.1)), `HomeSelector`, `EmpiricalDeviceModelsCard`, `ROITab` |

Two implementation notes worth keeping:

- **The plan sections render outside `TabsContent`.** `TabsList` is used as a
  segmented control and one `PlanWorkspace` instance is rendered below it. That
  keeps the component mounted across the five plan sections, so switching tabs
  changes a prop rather than remounting and refetching a 72-hour plan. Putting
  each section in its own `TabsContent` would have refetched on every click.
- **Content is split by section, not just the chart.** `Plan` owns the delta and
  KPI grids, plan-versus-actual, and data-source health. Each chart tab shows
  the plan header (status, issue time, With/Without plan toggle) plus its own
  chart, and the thermal readiness panel now lives on `Thermal` where it
  belongs. Validation errors show on every section because they always matter.

**Done in a follow-up commit.** `PlanWorkspace.tsx` went 1,467 → 627 lines:

| File | Holds |
|---|---|
| `plan/types.ts` | shared types, colours, thermal helpers |
| `plan/ui.tsx` | `Kpi`, `DeltaKpi`, `SeriesToggleLegend`, `SourceRow`, `EmptyState` |
| `plan/usePlanModel.ts` | every value the sections derive from one plan row |
| `plan/ThermalReadinessPanel.tsx` | per-zone model readiness |
| `plan/ActualPerformance.tsx` | plan-versus-actual reporting |
| `plan/sections/*Section.tsx` | one component per chart tab |

Series *visibility* deliberately stayed out of the model hook: it is per-section
UI state, so it lives in the section that owns the chart and toggling a series
on Power no longer re-renders Storage. Each section destructures only the model
fields it uses.

Because the app cannot be run from the agent sandbox, equivalence was checked
mechanically: whitespace-normalised diffs of the moved JSX and the derived-state
body against the previous commit are character-identical, the only deliberate
edit being an explicit `'good' | 'bad' | undefined` annotation on `costTone`,
which returning it through an object literal would otherwise widen to `string`.

<a id="legacy-section-1.3.6"></a>

#### 1.3.6 ROI is rebuilt on the planner

`ROITab` compares `model_runs` rows by `scenario`, but `simulateDeviceDay()` has
no `scenario` input — `SimulatorTab.tsx:477` writes it and nothing reads it. The
dumb/smart comparison runs the same simulation twice, and ROI selects the newest
of each independently, so the two sides need not share tariffs or model version.
Investment costs are hardcoded (50k/15k/299) rather than drawn from SKU/quote
data.

`comparePlans()` already yields the correct deltas (`netCostSekDelta`,
`terminalAdjustedCostSekDelta`). The gap is horizon: 72 hours is not a year.

**Implemented 2026-08-13** in `src/lib/energy-roi.ts` and a rewritten `ROITab`.
Savings now come from `energy_optimisation_plan_runs` — the planner's own
priority-versus-baseline comparison for this home, which is real, specific and
accumulating. Three properties of that data shaped the design:

1. **Runs overlap.** They are issued hourly over a 72-hour horizon, so
   consecutive runs share 71/72 of their window. Averaging *rates* is unbiased,
   but the independent sample is the number of **distinct days**, not runs. The
   UI reports days; a test pins this (240 runs over 10 days must read as 10).
2. **Retention is 30 days** (`prune_energy_optimisation_data`), so a *measured*
   annual saving can never be accumulated. The annual figure is therefore an
   explicit "if this rate held all year" extrapolation, labelled as such on the
   card and in the method note. A durable monthly rollup is the proper fix and
   remains outstanding.
3. **Only `ready` runs count.** An infeasible or incomplete run has no
   meaningful cost to compare and would drag the median.

Below `MIN_DAYS_FOR_OBSERVED_RATE` (7 days) the page states **no figure at all**
and says which of "no plan history" or "too few days" applies. It does not
substitute a modelled number for the customer's own.

<a id="legacy-section-1.3.6a"></a>

#### 1.3.6a The seasonal fixtures found a planner regression

The first plan was to derive the annual figure from the [§10.1](models-and-delivery.md#legacy-section-10.1) seasonal fixtures.
Running them stopped that:

| Fixture | Priority | Baseline | Saving over 72 h |
|---|---|---|---|
| Winter | 154.39 | 160.07 | +5.68 |
| Spring | 55.05 | 63.09 | +8.05 |
| Summer | −10.26 | −0.65 | +9.61 |
| **Autumn** | **112.38** | **99.61** | **−12.77** |

**In the autumn fixture the priority plan costs 12.77 SEK more than its own
baseline**, and both plans end at an identical 55% SOC, so it is not a
terminal-valuation artefact. Weighted by season the reference home's "annual
saving" comes to 313 SEK — a number that would have been presented as a business
case while burying a planner defect inside it.

So the fixtures are **not** used as a customer figure. `seasonalPlannerCheck()`
runs them as a diagnostic, flags any season where the plan loses to its own
baseline, and the ROI page shows that regression explicitly rather than
averaging it away. Investigating the autumn case belongs with the [§10.1](models-and-delivery.md#legacy-section-10.1) autumn
scenario work: "stable seasonal restart, preheating and forecast-error
recovery".

Investment and subscription remain manual inputs, now labelled as example
values rather than presented as if sourced. Pulling them from an accepted quote
is separate work.

<a id="legacy-section-1.3.7"></a>

#### 1.3.7 Measured history becomes its own tab, and gets a price (2026-08-13)

Decided with Phil on 2026-08-13. The Plan tab carried two charts: the forward
plan and `ActualPerformance`'s trailing 72 hours. They are separated, both get a
1/2/3-day window control, and both gain a per-device table underneath. The
history tab gains window summary cards (grid import, grid export, cost, house
consumption, solar production).

<a id="legacy-section-1.3.7.1"></a>

##### 1.3.7.1 The portal has no historical price, and could not derive one honestly

Everything below follows from one gap. The website stores measured energy and
nothing else:

| Store | Holds | Covers |
|---|---|---|
| `energy_optimisation_actual_slots` | kWh per quarter, per category | past, 120-day retention |
| `energy_optimisation_device_slots` | kWh per quarter, per device | past, 120-day retention |
| `energy_optimisation_current.plan` | priced slots | **now → +72 h only** |
| `energy_optimisation_plan_runs` | `summary` jsonb, no slots | past, 30 days |

The plan's prices never overlap the history window, and the plan runs keep no
slot array, so no stored row anywhere prices a past quarter.

Recomputing one in the portal was rejected. The price the planner optimises
against is **all-in** — supplier spot × the effective-dated supplier terms,
plus grid transfer, plus energy tax, plus VAT (`coordinator.py:2141`, summing
`supplier_import` and `grid["import_price_sek_per_kwh"]`). The supplier half is
already shared TypeScript (`_shared/energy-supplier-pricing.ts`), but the grid
half exists only as Python in `tariff.py:_transfer_rate`/`_energy_tax_rate`.
Reimplementing it in TypeScript would create a second pricing implementation
free to drift from the one that actually spent the customer's money, and the
history tab exists precisely to audit that spending. **One price implementation,
and it is the integration's.**

<a id="legacy-section-1.3.7.2"></a>

##### 1.3.7.2 Home Assistant sends the price; a new archive stores it

The integration already holds both halves for any timestamp, past or future:
`integration-prices` accepts `from`/`to` and serves historical spot up to 62 days
per request, and grid tariffs are effective-dated and published ahead, so
`current_grid_prices(catalog, when)` resolves a past quarter exactly rather than
predicting it. So the integration sends the number it used.

- New table **`energy_optimisation_price_slots`** — `(home_id, start_ts)` unique,
  all-in import and export price, `source`, 120-day pruning alongside the other
  quarter tables.
- New optional **`price_slots`** array on the ingest payload.

Prices are a separate array rather than two more columns on `actual_slots`, for
three reasons: a price exists for future quarters that have no actuals; the
ingest deliberately refuses actuals older than 8 days to keep the recorder
watermark honest, and a backfill needs a far wider window; and a published price
is a property of a quarter for the home, not of a measurement of it.

**The ingest also archives the snapshot's own priced slots** (`source =
'snapshot'`). The snapshot already carries the same all-in numbers for its
horizon, so this costs nothing, and it means the archive starts filling from the
moment the website deploys rather than waiting on a HACS release. Both writers
produce the same figure by construction — the snapshot's prices *are* the
integration's — so the upsert lets either win and only records which arrived
last.

<a id="legacy-section-1.3.7.3"></a>

##### 1.3.7.3 Backfill is an integration action

Phil is tuning the planner and needs to check historical figures now, so the
archive filling forward is not sufficient. `shs_energy.backfill_prices` walks a
requested window, pairs historical supplier prices with the tariff catalogue
quarter by quarter, and pushes them in chunks. It reuses the machinery the
supplier daily-cost backfill already has for 61-day chunked historical fetches
(`coordinator.py:987`).

<a id="legacy-section-1.3.7.4"></a>

##### 1.3.7.4 Only grid energy costs money

Solar and battery energy are priced at zero. Panel and cell degradation are real
costs and are deliberately out of scope; the tables say so rather than implying
self-consumption is free in an accounting sense.

Each quarter is decomposed into where the load's energy came from, before any
device sees it. Exported energy is assumed to be solar before it is battery, and
battery charging is assumed to take surplus solar before it takes grid:

```
solarToExport  = min(S, E)
solarToBattery = min(S − solarToExport, Bc)
gridToBattery  = Bc − solarToBattery
solarToLoad    = S − solarToExport − solarToBattery
batteryToLoad  = Bd
gridToLoad     = G − gridToBattery
```

Every device in the quarter then takes a share `e_d / L` of each of
`gridToLoad`, `solarToLoad` and `batteryToLoad`, and is charged
`grid_d × import_price` for that quarter. Four energy columns — **Grid, Solar,
Battery, Total** — plus SEK, sorted by Total descending.

Two rows exist so the columns reconcile against the bill rather than
approximately resembling it:

- **Base load — everything else**, `L − Σ e_d`. Without it the table would omit
  every unmetered device and quietly understate the house.
- **Battery charging**, carrying `gridToBattery` and `solarToBattery`. Grid
  energy that charged the battery is real grid energy on a real invoice; with no
  row to hold it the Grid column would sum to less than the metered import and
  the cost column to less than the bill.

With both rows the Grid column sums to `G` and the cost column to
`Σ G × import_price`, exactly.

**The meter balance residual is shown, not smoothed.** `total_load_kwh` is
derived from the category balance when it is not measured directly
(`coordinator.py:_actual_quarters`), in which case
`gridToLoad + solarToLoad + batteryToLoad = L` identically and the residual is
zero. Where the load is separately metered the two can disagree. That difference
is reported as its own figure rather than scaled away across the devices: this
tab is a debugging surface for the planner, and a scaling factor hiding a broken
category mapping is the exact failure [§1.3.1](portal-and-reporting.md#legacy-section-1.3.1) was written about.

<a id="legacy-section-1.3.7.5"></a>

##### 1.3.7.5 A randomised test caught surplus solar being billed as consumption

The fixed unit cases all passed. A property test over 2,000 randomised quarters
did not, and the defect it found is one those cases could not reach.

`total_load_kwh` is derived as `max(0, G + S + Bd − Bc − E)`. When solar exceeds
everything the house consumed, stored and exported — curtailment, or a load
meter reading low — that `max` clamps and the balance identity stops holding
from *above*: the sources exceed the load. The first implementation still
handed every device its share of all three source terms, so each one was
credited with solar that never reached it, and the solar column inflated. Over
the randomised window this came to **358 kWh of fictitious consumption**.

The supply terms are now capped at the reported load, and **only solar and
battery give way**. The grid term must survive intact, because
`grid column = metered import` is the one identity that has to match an invoice.
Whatever is held back is reported as unmatched supply rather than discarded
silently — on this tab that number is a symptom worth reading, not noise.

Two properties are now pinned by test across the randomised window: the grid
column totals the metered import, and the cost column totals
`Σ import × price`. Both to within 0.05 kWh and 0.05 SEK over 2,000 quarters.

<a id="legacy-section-1.3.7.6"></a>

##### 1.3.7.6 The backfill moved to the portal, which reverses [§1.3.7.1](portal-and-reporting.md#legacy-section-1.3.7.1)

[§1.3.7.1](portal-and-reporting.md#legacy-section-1.3.7.1) rejected pricing in the portal because it would mean a second
implementation of the grid tariff. That reasoning was sound and the conclusion
is now overridden, deliberately, for a reason that only appeared in use:
**a backfill that runs in Home Assistant is not a backfill anyone will run.**
The integration action worked, but it put a manual Developer-Tools step between
the customer and a priced history, and it failed opaquely when the data behind
it was missing. The portal owns the surface that shows the gap, so it should own
the button that closes it.

**What actually failed first was data, not code.** `shs_energy.backfill_prices`
returned `502 price_lookup_failed` for every historical date. The Tibber profile
was seeded with a single version valid from **2026-08-13**, and
`integration-prices` resolves supplier terms per day:

```js
const version = versions.find(candidate =>
  candidate.valid_from <= localDate && (!candidate.valid_to || ...));
if (!version) throw new Error(`supplier terms missing for ${localDate}`);
```

so every date before today threw into the catch-all. The grid half was never the
problem — the Ellevio catalogue is effective-dated from 2025-01-01. Three
consequences:

1. **`integration-prices` now separates the cases.** Absent terms return
   **422 `supplier_terms_missing`** naming the date and the earliest terms on
   file; a malformed range returns 400; only a genuine upstream failure is a
   502. The old behaviour cost an afternoon of reading Home Assistant
   tracebacks to learn something the server already knew.
2. **Historical Tibber terms are an explicit assumption.** Revision
   `tibber_se_assumed_from_2025-01-01` carries today's terms backwards, named so
   it can never be mistaken for sourced data, and superseded automatically by
   publishing the real terms. The spot price it multiplies is real per-quarter
   market data, so the error is bounded by the markup — a few öre per kWh, not
   the price itself.
3. **`backfill-energy-prices`** prices a home's window from published spot plus
   the tariff in force, and the History tab offers it exactly where the unpriced
   quarters are counted. It reports which days it skipped and why, rather than
   failing the run — the integration action aborted on its first bad chunk, and
   since chunks ran oldest-first, the one window that would have worked was last
   and never ran.

**The duplicate implementation is answered structurally, not by argument.**
`_shared/energy-grid-pricing.ts` ports only the marginal per-kWh path of
`current_grid_prices` — monthly invoicing, fixed fees and demand charges stay in
the integration alone. `grid-price-parity.fixture.json` holds 17 cases captured
from the Python (band edges, weekends, Christmas Eve, computed Easter dates,
reduced energy tax, VAT-registered export, per-selector transfer, outside the
catalogue) and is **duplicated verbatim in both repositories**, because CI cannot
reach across them. Each repo asserts its own implementation against it, so
changing the calculation in either place fails that repo's suite. The duplication
is the mechanism, not an oversight.

`source` on a price row records which writer produced it — `integration`,
`snapshot` or `portal_backfill` — so if the parity check ever does fail, the
affected quarters can be found rather than guessed at.


<!-- END PRESERVED SOURCE -->
