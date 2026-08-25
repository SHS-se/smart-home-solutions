# Plan chart alternatives

Five redraws of the live-plan power chart
(`src/components/portal/energy/plan/sections/PowerSection.tsx`), rendered from
one dataset so the only difference between them is the arrangement.

**Nothing here is imported by the app.** This folder is a drawing board. No file
under `src/` is read or modified by any of it.

```bash
node design/plan-chart-alternatives/build.mjs   # writes out/index.html
```

## Files

| File | What it is |
|------|------------|
| `data.mjs` | The dataset. 144 quarter-hours (36 h) shaped against 2026-08-25 at Phil's house and solved so every quarter balances. Deterministic. |
| `svg.mjs` | Scales and path strings via `d3-scale` / `d3-shape`, rendered to SVG text in Node. No DOM, no chart library. |
| `charts.mjs` | The five renderers. |
| `build.mjs` | Assembles `out/index.html`: page copy, stylesheet, legends, tooltip script, table view. |

## The data

Simulated, not exported — the portal's own day sits behind a login and pulling
it out of Home Assistant one sensor at a time costs more than a drawing exercise
is worth. The shapes are fitted to the screenshot's day and then *solved*, so in
every quarter:

```
solar + import + discharge = consumption + export + charge
```

That matters because alternative B is a chart whose whole job is to show that
identity. It can only be judged on data that satisfies it.

Against the portal's reported figures for the measured day: solar 32.8 kWh,
load 35.7 kWh and export 1.0 kWh match exactly (they are the scaling targets);
import falls out of the battery policy and lands near, not on, the reported
2.9 kWh.

**To draw real data instead**, replace `buildDataset()` with a reader that
returns the same row shape — `{ ms, measured, solarW, loadW, baseW, deviceW,
gridImportW, gridExportW, batteryChargeW, batteryDischargeW, homeSoc, evSoc,
importPriceSekPerKwh, exportPriceSekPerKwh, dispatch, costSek }`. That is
`TimelineRow` from `src/lib/energy-shift/energy-timeline.ts` plus `dispatch`.
No renderer changes.

## The palette

Nine meanings, eight hues and one deliberate neutral. Every hue comes from a
validated categorical set and is bound to one entity across all five charts.

| Entity | Light | Dark |
|---|---|---|
| Solar | `#eb6834` | `#d95926` |
| Grid | `#2a78d6` | `#3987e5` |
| Battery | `#1baf7a` | `#199e70` |
| Hot water | `#e34948` | `#e66767` |
| EV charging | `#4a3aa7` | `#9085e9` |
| Pool | `#008300` | `#008300` |
| Kitchen & cold | `#e87ba4` | `#d55181` |
| Media & office | `#eda100` | `#c98500` |
| Base load & ventilation | `#8a8f98` | `#7d838c` |

The three flow colours clear the colour-vision-deficiency threshold against
*each other* under all-pairs checking in both modes; the load colours clear it
against their neighbours in the stack. Solar does not get yellow: yellow and
orange fail the normal-vision floor when placed together, so the sun took orange
and the battery green. The base grey is below the chroma floor on purpose — it
is the "everything else" neutral, not a series.

Colours are emitted as `var(--c-…)`, so both themes come from one stylesheet and
nothing is re-rendered to switch.
