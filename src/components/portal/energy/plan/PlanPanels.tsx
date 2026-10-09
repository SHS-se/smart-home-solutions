// One chart, a stack of panels, one shared time axis.
//
// Replaces the single plot that carried kilowatts, per cent and SEK/kWh against
// three y-axes at once. Nothing about a curve said which axis it belonged to,
// so every reading started with a guess — and a dual axis invents a
// relationship that is not in the data, because the alignment between the two
// scales is arbitrary. Each quantity now gets its own strip and its own axis,
// stacked over the same quarters, so reading a moment in time is reading a
// column: what it cost, where the power came from, what used it, what was left
// in store, and how warm it was. The planner bench adds a last strip: what each
// of the planners it compares had spent by then. It also draws the planner the
// plan is compared with as dashed lines in the storage and temperature panels.
//
// Under the time axis sits the score: the points the plan's rules gave and took
// in each quarter, and below it why the picked quarter scored what it did. The
// two are one section, the same on the live plan and on the bench.
//
// The consumption stack draws individual meters, never categories: the planner
// dispatches individual devices, so a band labelled "Kitchen & cold" would
// describe something no schedule can act on. It stays legible by drawing
// *fewer* meters rather than coarser ones — see consumption-series.ts for
// which ones earn a band.

import React, { useMemo, useRef, useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  linearScale, midpointLinePath, niceTicks, placeBandLabels, priceDomain, stackBands,
  stepAreaPath, stepBandPath, stepLinePath, type BandLabelPlacement, type Scale,
} from '@/lib/energy-shift/plan-chart-geometry';
import {
  PRICE_RAMP_STEPS, priceBands, priceGradientStops,
} from '@/lib/energy-shift/price-bands';
import { consumptionGapDescription, type ConsumptionIssue, type ConsumptionSeries } from '@/lib/energy-shift/consumption-series';
import { powerFlowMagnitudes } from '@/lib/energy-shift/power-flows';
import { timelineGapDescription } from '@/lib/energy-shift/timeline-gap';
import { loadColour, PLAN_COLOURS } from './types';
import { scoreColour } from './quarter-score';
import { useHomeTimeZone } from '../HomeTimeZoneContext';
import { formatHomeDayMonth, formatHomeTime, homeHourMinute } from '@/lib/energy-shift/home-time';

import type { PlanPanelRow } from '@/lib/energy-shift/plan-chart-data';
export type { PlanPanelRow } from '@/lib/energy-shift/plan-chart-data';

const VIEW_W = 1160;
const MARGIN_LEFT = 58;
const MARGIN_RIGHT = 92;
const PLOT_W = VIEW_W - MARGIN_LEFT - MARGIN_RIGHT;
const RIGHT = MARGIN_LEFT + PLOT_W;
const GAP = 34;

const kw = (watts: number | null): number | null =>
  watts === null || !Number.isFinite(watts) ? null : watts / 1_000;

const AXIS_TEXT = 'fill-muted-foreground text-[10px] font-mono';
/** The pool's own colour, as its band in the consumption stack usually is. */
const POOL_COLOUR = loadColour(2);

interface Panel { top: number; height: number }

/** One planner's running cost, for the bench's cost panel. */
export interface PlanCostLine {
  key: string;
  name: string;
  colour: string;
  dashed?: boolean;
  /** SEK spent from the start of the window to the end of each quarter, aligned with `rows`. */
  values: readonly (number | null)[];
}

/** Another planner's stores over the same quarters, for the bench's storage and temperature panels. */
export interface PlanStoreLines {
  name: string;
  /** Per cent, aligned with `rows`. */
  homeSoc: readonly (number | null)[];
  evSoc: readonly (number | null)[];
  poolC: readonly (number | null)[];
}

/** How the planner a plan is compared with is drawn, in every panel that draws it. */
const COMPARED_DASH = '5 3';
const COMPARED_WIDTH = 1.6;

const PanelHeading: React.FC<{ title: string; unit: string; y: number }> = ({ title, unit, y }) => (
  <>
    <text x={MARGIN_LEFT} y={y} className="fill-foreground text-[11px] font-medium">{title}</text>
    <text x={MARGIN_LEFT + title.length * 6.6 + 10} y={y} className={AXIS_TEXT}>{unit}</text>
  </>
);

const Gridlines: React.FC<{ ticks: number[]; y: Scale; format: (tick: number) => string }> = ({
  ticks, y, format,
}) => (
  <>
    {ticks.map(tick => (
      <g key={tick}>
        <line
          x1={MARGIN_LEFT} x2={RIGHT} y1={y(tick)} y2={y(tick)}
          className="stroke-border" strokeWidth={1}
        />
        <text x={MARGIN_LEFT - 8} y={y(tick) + 3} textAnchor="end" className={AXIS_TEXT}>
          {format(tick)}
        </text>
      </g>
    ))}
  </>
);

/** The one label a line always earns: its own value, at its own end. */
const EndLabel: React.FC<{
  y: number; colour: string; children: string;
  /** Where the text sits when a neighbouring label has taken the line's own height. */
  labelY?: number;
}> = ({ y, colour, children, labelY = y }) => (
  <g>
    <circle cx={RIGHT} cy={y} r={3} fill={colour} className="stroke-card" strokeWidth={2} />
    <text x={RIGHT + 7} y={labelY + 3.5} className={AXIS_TEXT}>{children}</text>
  </g>
);

/** Band order in the flow panel, so a placement can be turned back into a name. */
const FLOW_NAMES = (t: (sv: string, en: string) => string): string[] => [
  t('Sol', 'Solar'), t('Batteri ut', 'Battery out'), t('Nätimport', 'Grid in'),
  t('Batteri in', 'Battery in'), t('Nätexport', 'Grid out'),
];

/** A band's own name, written inside it where there is room. */
const InlineLabel: React.FC<{
  placement: BandLabelPlacement;
  children: React.ReactNode;
}> = ({ placement, children }) => (
  <g>
    <rect
      x={placement.x - placement.width / 2} y={placement.y - placement.height / 2}
      width={placement.width} height={placement.height} rx={3}
      className="fill-card" fillOpacity={0.85}
    />
    <text
      x={placement.x} y={placement.y + 4} textAnchor="middle"
      className="fill-foreground text-[9.5px] font-medium"
    >
      {children}
    </text>
  </g>
);

/** Long enough to name the meter, short enough not to span the plot. */
const INLINE_NAME_MAX = 20;
const shorten = (name: string): string =>
  name.length <= INLINE_NAME_MAX ? name : `${name.slice(0, INLINE_NAME_MAX - 1)}…`;

const PlanPanels: React.FC<{
  rows: PlanPanelRow[];
  /** Meters that earned a band of their own, largest first. */
  series: ConsumptionSeries[];
  /** Base load plus every meter that did not. */
  baseValues: number[];
  consumptionIssues: (ConsumptionIssue | null)[];
  /** First quarter on the plan side, including quarters with missing data. */
  dividerIndex: number;
  hasBattery: boolean;
  hasEvBattery: boolean;
  selectedIndex?: number;
  onQuarterClick?: (index: number) => void;
  /**
   * The points the plan's rules gave and took in each quarter, drawn as a
   * strip under the time axis; null where a quarter has no score, as measured
   * history has none.
   */
  quarterScores?: readonly (number | null)[];
  /** Why the picked quarter scored what it did, shown under the score strip (QuarterScoreDetail). */
  scoreDetail?: React.ReactNode;
  /**
   * Planner bench: every row's price is what the quarter really cost, and
   * the planner was given it.
   */
  realPrices?: boolean;
  /** The pool temperature the owner asked for, drawn as a reference line. */
  poolTargetC?: number | null;
  /**
   * Planner bench: what each compared planner has spent, drawn as the last
   * panel. The portal never passes it.
   */
  costLines?: readonly PlanCostLine[];
  /**
   * Planner bench: the stores of the planner this plan is compared with, drawn
   * dashed under the plan's own lines. The portal never passes it.
   */
  storeLines?: PlanStoreLines;
}> = ({
  rows, series, baseValues, consumptionIssues, dividerIndex, hasBattery, hasEvBattery,
  selectedIndex = -1, onQuarterClick, quarterScores, scoreDetail, realPrices = false, poolTargetC = null,
  costLines, storeLines,
}) => {
  const { t } = useLanguage();
  const homeTimeZone = useHomeTimeZone();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ left: number; top: number } | null>(null);

  const n = rows.length;
  const showSoc = (hasBattery && rows.some(row => row.homeSoc !== null))
    || (hasEvBattery && rows.some(row => row.evSoc !== null));

  const geometry = useMemo(() => {
    const x = linearScale([0, Math.max(1, n)], [MARGIN_LEFT, RIGHT]);

    const price: Panel = { top: 30, height: 68 };
    const flow: Panel = { top: price.top + price.height + GAP, height: 126 };
    const load: Panel = { top: flow.top + flow.height + GAP, height: 150 };
    const soc: Panel = { top: load.top + load.height + GAP, height: showSoc ? 62 : 0 };
    const poolC = rows.map(row => row.poolTemperatureC ?? null);
    const knownPoolC = poolC.filter((value): value is number => value !== null);
    const showPool = knownPoolC.length > 0;
    const comparedPoolC = (storeLines?.poolC.slice(0, n) ?? [])
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const pool: Panel = { top: soc.top + (showSoc ? soc.height + GAP : 0), height: showPool ? 96 : 0 };
    const knownCost = (costLines ?? []).flatMap(line => line.values.slice(0, n))
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const showCost = knownCost.length > 0;
    const cost: Panel = { top: pool.top + (showPool ? pool.height + GAP : 0), height: showCost ? 90 : 0 };
    const axisY = showCost ? cost.top + cost.height
      : showPool ? pool.top + pool.height : (showSoc ? soc.top + soc.height : load.top + load.height);
    // The score is a section of its own, below the axis labels of the panels above.
    const scoreStrip: Panel | null = quarterScores ? { top: axisY + 42 + GAP, height: 16 } : null;

    // --- Price ------------------------------------------------------------
    const buy = rows.map(row => row.importPriceSekPerKwh);
    const sell = rows.map(row => row.exportPriceSekPerKwh);
    // Quoted and estimated quarters are drawn as separate runs so the line can
    // change weight where the market stops. A step run spans [x(i), x(i + 1)),
    // so the two abut exactly at the changeover with no seam and no overlap.
    const quotedBuy = rows.map(row => row.importPriceQuoted ? row.importPriceSekPerKwh : null);
    const modelledBuy = rows.map(row => row.importPriceQuoted ? null : row.importPriceSekPerKwh);
    const hasModelledPrice = !realPrices && modelledBuy.some(value => value !== null);
    const bands = priceBands(buy);
    const [priceMin, priceMax] = priceDomain(buy, sell);
    const priceY = linearScale([priceMin, priceMax], [price.top + price.height, price.top]);

    // --- Flows: into the house above zero, out of it below ----------------
    const flows = powerFlowMagnitudes(rows);
    const toKw = (values: number[]) => values.map(watts => watts / 1_000);
    const toNegativeKw = (values: number[]) => values.map(watts => -watts / 1_000);
    const supply = stackBands([
      toKw(flows.solarDirect), toKw(flows.batteryOut), toKw(flows.gridIn),
    ]);
    const disposal = stackBands([
      toNegativeKw(flows.batteryIn), toNegativeKw(flows.gridOut),
    ]);
    const flowMax = Math.max(0.5, ...supply[2].map(pair => pair[1])) * 1.12;
    const flowMin = Math.min(-0.5, ...disposal[1].map(pair => pair[0])) * 1.1;
    const flowY = linearScale([flowMin, flowMax], [flow.top + flow.height, flow.top]);

    // --- Consumption: base at the floor, movable loads riding on top -------
    const loadBands = stackBands([
      baseValues.map(watts => watts / 1_000),
      ...series.map(entry => entry.values.map(watts => watts / 1_000)),
    ]);
    const loadMax = Math.max(
      0.5,
      ...loadBands.flatMap(band => band.map(pair => pair[1])).filter(Number.isFinite),
      ...rows.map(row => (row.solarW ?? 0) / 1_000),
    ) * 1.1;
    const flowLabels = placeBandLabels([...supply, ...disposal], FLOW_NAMES(t), x, flowY);

    const loadY = linearScale([0, loadMax], [load.top + load.height, load.top]);
    const loadLabels = placeBandLabels(
      loadBands,
      ['', ...series.map(entry => shorten(entry.name))],
      x,
      loadY,
    );

    const socY = linearScale([0, 100], [soc.top + soc.height, soc.top]);

    // Half a degree of air around the readings and the target, on whole half degrees.
    const poolBounds = [...knownPoolC, ...comparedPoolC, ...(poolTargetC === null ? [] : [poolTargetC])];
    const poolMin = Math.floor((Math.min(...poolBounds) - 0.3) * 2) / 2;
    const poolMax = Math.ceil((Math.max(...poolBounds) + 0.3) * 2) / 2;
    const poolY = linearScale([poolMin, poolMax], [pool.top + pool.height, pool.top]);

    // Zero is always on the axis, and a window that cost next to nothing keeps
    // a ten-krona span so its noise is not drawn as a cliff.
    const costMin = Math.min(0, ...knownCost);
    const costMax = Math.max(costMin + 10, 0, ...knownCost);
    const costY = linearScale([costMin, costMax], [cost.top + cost.height, cost.top]);
    const costEnds = (costLines ?? []).flatMap(line => {
      const last = line.values[n - 1];
      return last === null || last === undefined || !Number.isFinite(last)
        ? [] : [{ line, value: last, y: costY(last), labelY: costY(last) }];
    }).sort((a, b) => a.y - b.y);
    costEnds.forEach((end, index) => {
      if (index > 0) end.labelY = Math.max(end.labelY, costEnds[index - 1].labelY + 11);
    });

    return {
      x, axisY, height: scoreStrip ? scoreStrip.top + scoreStrip.height + 10 : axisY + 42, scoreStrip,
      price, priceY, priceMin, priceMax, buy, sell, bands,
      quotedBuy, modelledBuy, hasModelledPrice,
      flow, flowY, flowMin, flowMax, supply, disposal, flowLabels,
      load, loadY, loadMax, loadBands, loadLabels,
      soc, socY, pool, poolY, poolC, showPool, poolMin, poolMax,
      cost, costY, costMin, costMax, costEnds, showCost,
    };
  }, [baseValues, n, rows, series, showSoc, t, quarterScores, realPrices, poolTargetC, costLines, storeLines]);

  const {
    x, axisY, height, scoreStrip, price, priceY, priceMin, priceMax, buy, sell, bands,
    quotedBuy, modelledBuy, hasModelledPrice,
    flow, flowY, flowMin, flowMax, supply, disposal, flowLabels,
    load, loadY, loadMax, loadBands, loadLabels,
    soc, socY, pool, poolY, poolC, showPool, poolMin, poolMax,
    cost, costY, costMin, costMax, costEnds, showCost,
  } = geometry;

  const gradientId = 'plan-price-ramp';
  const priceStroke = bands ? `url(#${gradientId})` : 'var(--plan-price-4)';

  const hourTicks = useMemo(() => {
    const every = n > 200 ? 6 : n > 100 ? 3 : 2;
    return rows
      .map((row, index) => ({ index, date: new Date(row.startMs) }))
      .filter(({ date }) => {
        const { hour, minute } = homeHourMinute(date, homeTimeZone);
        return minute === 0 && hour % every === 0;
      });
  }, [homeTimeZone, n, rows]);

  // The divider marks the home's midnight. Read off the browser's clock it
  // landed an hour or a continent away from the day it was dividing.
  const dayTicks = useMemo(() => rows
    .map((row, index) => ({ index, date: new Date(row.startMs) }))
    .filter(({ index, date }) => {
      const { hour, minute } = homeHourMinute(date, homeTimeZone);
      return index > 0 && hour === 0 && minute === 0;
    }),
  [homeTimeZone, rows]);

  /**
   * Which quarter a pointer is over, straight from its position.
   *
   * Read at click time as well as on move, because `hover` is state and a click
   * can land in the same batch as the move that set it — so the handler would
   * see the previous value. A touch is the case that never works otherwise: a
   * tap has no preceding pointermove at all, so `hover` is still null and the
   * quarter under the finger would be unreachable.
   */
  const quarterAt = (clientX: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    if (box.width === 0) return null;
    const viewX = (clientX - box.left) * (VIEW_W / box.width);
    const index = Math.floor(((viewX - MARGIN_LEFT) / PLOT_W) * n);
    return index < 0 || index >= n ? null : index;
  };

  const handleMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const index = quarterAt(event.clientX);
    if (index === null) { setHover(null); setPointer(null); return; }
    setHover(index);
    const wrapBox = wrap.getBoundingClientRect();
    setPointer({ left: event.clientX - wrapBox.left, top: event.clientY - wrapBox.top });
  };

  const handleKey = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const from = hover ?? Math.min(dividerIndex, n - 1);
    const next = Math.max(0, Math.min(n - 1, from + (event.key === 'ArrowLeft' ? -1 : 1)));
    setHover(next);
    setPointer({ left: ((next + 0.5) / n) * PLOT_W + MARGIN_LEFT, top: flow.top });
  };

  const hovered = hover === null ? null : rows[hover];
  const comparedNote = storeLines ? ` · ${t('streckat', 'dashed')} = ${storeLines.name}` : '';
  const planWidth = dividerIndex >= n ? 0 : x(n) - x(dividerIndex);

  return (
    <div ref={wrapRef} className="relative">
      <div className="rounded-lg border bg-card">
        <div className="overflow-x-auto">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          className="block h-auto w-full min-w-[760px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={onQuarterClick ? { cursor: 'pointer' } : undefined}
          role="img"
          tabIndex={0}
          aria-label={showCost
            ? t(
              'Pris, effektflöden, förbrukning, lagernivå, temperatur och kostnad över tid',
              'Price, power flows, consumption, storage, temperature and cost over time',
            )
            : t(
              'Pris, effektflöden, förbrukning, lagernivå och temperatur över tid',
              'Price, power flows, consumption, storage and temperature over time',
            )}
          onPointerMove={handleMove}
          onPointerLeave={() => { setHover(null); setPointer(null); }}
          onKeyDown={handleKey}
          onClick={event => {
            const index = quarterAt(event.clientX) ?? hover;
            if (index !== null) onQuarterClick?.(index);
          }}
        >
          {bands && (
            <defs>
              <linearGradient
                id={gradientId} gradientUnits="userSpaceOnUse"
                x1={x(0)} y1={0} x2={x(n)} y2={0}
              >
                {priceGradientStops(buy, bands).map((stop, index) => (
                  <stop
                    key={`${stop.offset}-${index}`}
                    offset={stop.offset}
                    stopColor={`var(--plan-price-${stop.step})`}
                  />
                ))}
              </linearGradient>
            </defs>
          )}

          {/* Everything right of now is forecast. Said once, across every
              panel, rather than as a faint tint inside one of them. */}
          {planWidth > 0 && (
            <rect
              x={x(dividerIndex)} y={price.top - 14}
              width={planWidth} height={axisY - price.top + 14}
              fill="var(--plan-wash)"
            />
          )}

          {/* ---------------------------------------------------- Price --- */}
          <PanelHeading
            title={t('Pris', 'Price')}
            unit={realPrices
                ? t('SEK/kWh · köp, verkligt pris', 'SEK/kWh · buy, real price')
                : hasModelledPrice
                  ? t(
                    'SEK/kWh · köp, fast färgskala · streckat = uppskattat, inte marknadspris',
                    'SEK/kWh · buy, fixed colour scale · dashed = estimated, not a market price',
                  )
                  : t('SEK/kWh · köp, fast färgskala', 'SEK/kWh · buy, fixed colour scale')}
            y={price.top - 14}
          />
          {bands && (
            <g>
              {Array.from({ length: PRICE_RAMP_STEPS }, (_, step) => (
                <rect
                  key={step}
                  x={RIGHT - PRICE_RAMP_STEPS * 13 - 6 + step * 13}
                  y={price.top - 23} width={12} height={9}
                  fill={`var(--plan-price-${step + 1})`}
                />
              ))}
              <text
                x={RIGHT - PRICE_RAMP_STEPS * 13 - 12} y={price.top - 15}
                textAnchor="end" className={AXIS_TEXT}
              >
                {bands.min.toFixed(2)}
              </text>
              <text x={RIGHT + 2} y={price.top - 15} className={AXIS_TEXT}>
                {bands.max.toFixed(2)}+
              </text>
            </g>
          )}
          <Gridlines
            ticks={niceTicks(priceMin, priceMax, 3)} y={priceY}
            format={tick => tick.toFixed(tick !== 0 && Math.abs(tick) < 0.1 ? 2 : 1)}
          />
          {priceMin < 0 && (
            <line
              x1={MARGIN_LEFT} x2={RIGHT} y1={priceY(0)} y2={priceY(0)}
              className="stroke-foreground" strokeWidth={1.25}
            />
          )}
          {/* A thinner wash under the estimated stretch, so the difference is
              legible from across the room rather than only on hover. */}
          <path d={stepAreaPath(quotedBuy, x, priceY, 0)} fill={priceStroke} fillOpacity={0.2} />
          <path d={stepAreaPath(modelledBuy, x, priceY, 0)} fill={priceStroke} fillOpacity={0.08} />
          <path
            id="plan-sell-price" d={stepLinePath(sell, x, priceY)} fill="none"
            className="stroke-muted-foreground" strokeWidth={1.25}
          />
          <path
            d={stepLinePath(realPrices ? buy : quotedBuy, x, priceY)} fill="none"
            stroke={priceStroke} strokeWidth={3} strokeLinejoin="round"
          />
          {/* Same colour and same position — only the continuity differs, so a
              forecast never masquerades as a quote the market has published. */}
          {!realPrices && (
            <path
              d={stepLinePath(modelledBuy, x, priceY)} fill="none"
              stroke={priceStroke} strokeWidth={2} strokeLinejoin="round"
              strokeDasharray="5 4"
            />
          )}

          {/* ---------------------------------------------------- Flows --- */}
          <PanelHeading
            title={t('Effektflöden', 'Power flows')}
            unit={t(
              'kW · över noll = in i huset, under = ut',
              'kW · above zero = into the house, below = out of it',
            )}
            y={flow.top - 14}
          />
          <Gridlines
            ticks={niceTicks(flowMin, flowMax, 4)} y={flowY}
            format={tick => tick.toFixed(Math.abs(tick) >= 10 ? 0 : 1)}
          />
          {[PLAN_COLOURS.solar, PLAN_COLOURS.battery, PLAN_COLOURS.grid].map((colour, index) => (
            <path
              key={`supply-${index}`} d={stepBandPath(supply[index], x, flowY)}
              fill={colour} fillOpacity={0.9}
            />
          ))}
          {[PLAN_COLOURS.battery, PLAN_COLOURS.grid].map((colour, index) => (
            <path
              key={`disposal-${index}`} d={stepBandPath(disposal[index], x, flowY)}
              fill={colour} fillOpacity={0.42}
            />
          ))}
          {/* A two-pixel gap of card colour keeps the stack from fusing. */}
          {[supply[0], supply[1]].map((band, index) => (
            <path
              key={`flow-sep-${index}`}
              d={stepLinePath(band.map(pair => pair[1]), x, flowY)}
              fill="none" className="stroke-card" strokeWidth={2}
            />
          ))}
          <line
            x1={MARGIN_LEFT} x2={RIGHT} y1={flowY(0)} y2={flowY(0)}
            className="stroke-foreground" strokeWidth={1.25}
          />
          {flowLabels.map(placement => (
            <InlineLabel key={placement.band} placement={placement}>
              {FLOW_NAMES(t)[placement.band]}
            </InlineLabel>
          ))}

          {/* ---------------------------------------------- Consumption --- */}
          <PanelHeading
            title={t('Förbrukning', 'Consumption')}
            unit={t(
              'kW · styrbara mätare var för sig, resten i baslasten',
              'kW · schedulable meters individually, the rest in base load',
            )}
            y={load.top - 14}
          />
          <Gridlines
            ticks={niceTicks(0, loadMax, 3)} y={loadY}
            format={tick => tick.toFixed(Math.abs(tick) >= 10 ? 0 : 1)}
          />
          {loadBands.map((band, index) => (
            <path
              key={index === 0 ? 'base' : series[index - 1].key}
              d={stepBandPath(band, x, loadY)}
              fill={index === 0 ? PLAN_COLOURS.base : loadColour(series[index - 1].slot)}
              fillOpacity={0.92}
            />
          ))}
          {loadBands.slice(0, -1).map((band, index) => (
            <path
              key={`load-sep-${index}`}
              d={stepLinePath(band.map(pair => pair[1]), x, loadY)}
              fill="none" className="stroke-card" strokeWidth={2}
            />
          ))}
          {loadLabels.filter(placement => placement.band > 0).map(placement => (
            <InlineLabel key={series[placement.band - 1].key} placement={placement}>
              {shorten(series[placement.band - 1].name)}
            </InlineLabel>
          ))}
          {/* Solar as an outline over the stack, so "did the sun cover it?" is
              one comparison between two edges rather than a hunt through fills. */}
          <path
            d={stepLinePath(rows.map(row => kw(row.solarW)), x, loadY)}
            fill="none" stroke={PLAN_COLOURS.solar} strokeWidth={2}
            strokeDasharray="1 3" strokeLinecap="round"
          />

          {/* -------------------------------------------------- Storage --- */}
          {showSoc && (
            <g id="plan-storage">
              <PanelHeading title={t('Lager', 'Storage')} unit={`%${comparedNote}`} y={soc.top - 14} />
              <Gridlines ticks={[0, 50, 100]} y={socY} format={tick => String(tick)} />
              {hasBattery && (
                <path
                  d={stepAreaPath(rows.map(row => row.homeSoc), x, socY, 0)}
                  fill={PLAN_COLOURS.battery} fillOpacity={0.2}
                />
              )}
              {/* Under the plan's own lines: where the two planners agree there
                  is one line, and a dash only shows where they part. */}
              {storeLines && hasBattery && (
                <path
                  d={stepLinePath(storeLines.homeSoc.slice(0, n), x, socY)}
                  fill="none" stroke={PLAN_COLOURS.battery}
                  strokeWidth={COMPARED_WIDTH} strokeDasharray={COMPARED_DASH}
                />
              )}
              {storeLines && hasEvBattery && (
                <path
                  d={midpointLinePath(storeLines.evSoc.slice(0, n), x, socY)}
                  fill="none" stroke={PLAN_COLOURS.ev}
                  strokeWidth={COMPARED_WIDTH} strokeDasharray={COMPARED_DASH}
                />
              )}
              {hasBattery && (
                <path
                  d={stepLinePath(rows.map(row => row.homeSoc), x, socY)}
                  fill="none" stroke={PLAN_COLOURS.battery} strokeWidth={2}
                />
              )}
              {hasEvBattery && (
                <path
                  d={midpointLinePath(rows.map(row => row.evSoc), x, socY)}
                  fill="none" stroke={PLAN_COLOURS.ev} strokeWidth={2}
                />
              )}
              {hasBattery && rows[n - 1]?.homeSoc !== null && (
                <EndLabel y={socY(rows[n - 1].homeSoc as number)} colour={PLAN_COLOURS.battery}>
                  {`${t('hem', 'home')} ${Math.round(rows[n - 1].homeSoc as number)}%`}
                </EndLabel>
              )}
              {hasEvBattery && rows[n - 1]?.evSoc !== null && (
                <EndLabel y={socY(rows[n - 1].evSoc as number)} colour={PLAN_COLOURS.ev}>
                  {`${t('bil', 'car')} ${Math.round(rows[n - 1].evSoc as number)}%`}
                </EndLabel>
              )}
            </g>
          )}

          {/* ---------------------------------------------- Temperature --- */}
          {showPool && (
            <g id="plan-temperature">
              <PanelHeading
                title={t('Temperatur', 'Temperature')}
                unit={`${t('°C · uppmätt före nu, planerad efter', '°C · measured before now, planned after')}${comparedNote}`}
                y={pool.top - 14}
              />
              <Gridlines ticks={niceTicks(poolMin, poolMax, 4)} y={poolY} format={tick => tick.toFixed(1)} />
              {poolTargetC !== null && (
                <>
                  <line
                    x1={MARGIN_LEFT} x2={RIGHT} y1={poolY(poolTargetC)} y2={poolY(poolTargetC)}
                    stroke={PLAN_COLOURS.grid} strokeWidth={1} strokeDasharray="2 3"
                  />
                  <text x={MARGIN_LEFT + 4} y={poolY(poolTargetC) - 3} className="text-[9px]" fill={PLAN_COLOURS.grid}>
                    {`${poolTargetC} °C ${t('mål', 'target')}`}
                  </text>
                </>
              )}
              {storeLines && (
                <path
                  d={midpointLinePath(storeLines.poolC.slice(0, n), x, poolY)} fill="none"
                  stroke={POOL_COLOUR} strokeWidth={COMPARED_WIDTH} strokeLinejoin="round"
                  strokeDasharray={COMPARED_DASH}
                />
              )}
              <path
                d={midpointLinePath(poolC, x, poolY)} fill="none"
                stroke={POOL_COLOUR} strokeWidth={2} strokeLinejoin="round"
              />
              {poolC[n - 1] !== null && (
                <EndLabel y={poolY(poolC[n - 1] as number)} colour={POOL_COLOUR}>
                  {`${t('pool', 'pool')} ${(poolC[n - 1] as number).toFixed(1)} °C`}
                </EndLabel>
              )}
            </g>
          )}

          {/* ----------------------------------------------- Bench cost --- */}
          {showCost && costLines && (
            <g id="plan-cost">
              <PanelHeading
                title={t('Kostnad', 'What it costs')}
                unit={[
                  t('kr, ackumulerad nätkostnad', 'SEK, cumulative grid cost'),
                  ...costLines.map(line => `${line.dashed ? t('streckat', 'dashed') : t('heldraget', 'solid')} = ${line.name}`),
                ].join(' · ')}
                y={cost.top - 14}
              />
              <Gridlines ticks={niceTicks(costMin, costMax, 3)} y={costY} format={tick => tick.toFixed(0)} />
              {costMin < 0 && (
                <line
                  x1={MARGIN_LEFT} x2={RIGHT} y1={costY(0)} y2={costY(0)}
                  className="stroke-foreground" strokeWidth={1.25}
                />
              )}
              {costLines.map(line => (
                <path
                  key={line.key} d={stepLinePath(line.values.slice(0, n), x, costY)} fill="none"
                  stroke={line.colour} strokeWidth={line.dashed ? COMPARED_WIDTH : 2.2} strokeLinejoin="round"
                  strokeDasharray={line.dashed ? COMPARED_DASH : undefined}
                />
              ))}
              {costEnds.map(end => (
                <EndLabel key={end.line.key} y={end.y} labelY={end.labelY} colour={end.line.colour}>
                  {`${end.value.toFixed(0)} kr`}
                </EndLabel>
              ))}
            </g>
          )}

          {/* ------------------------------------------------- Chrome ----- */}
          {rows.map((row, index) => row.missing && (
            <rect
              key={row.startMs}
              x={x(index)} y={flow.top}
              width={x(index + 1) - x(index)} height={axisY - flow.top}
              className="fill-muted" fillOpacity={0.6}
            >
              <title>{`${row.label}: ${timelineGapDescription(row.startMs, Date.now(), t).label}`}</title>
            </rect>
          ))}
          {dividerIndex < n && (
            <g>
              <line
                x1={x(dividerIndex)} x2={x(dividerIndex)} y1={price.top - 14} y2={axisY}
                className="stroke-foreground" strokeWidth={1.5}
              />
              <rect
                x={x(dividerIndex) + 4} y={price.top - 27}
                width={90} height={15} rx={3} className="fill-foreground"
              />
              <text
                x={x(dividerIndex) + 9} y={price.top - 16}
                className="fill-card text-[9.5px] font-mono font-semibold tracking-wider"
              >
                {t('NU · PLAN →', 'NOW · PLAN →')}
              </text>
            </g>
          )}
          {selectedIndex >= 0 && selectedIndex < n && (
            <rect
              x={x(selectedIndex)} y={price.top - 14}
              width={Math.max(2, x(selectedIndex + 1) - x(selectedIndex))}
              height={axisY - price.top + 14}
              className="fill-primary" fillOpacity={0.18}
            />
          )}
          {hover !== null && (
            <g pointerEvents="none">
              <rect
                x={x(hover)} y={price.top - 14}
                width={Math.max(1.5, x(hover + 1) - x(hover))}
                height={axisY - price.top + 14}
                className="fill-foreground" fillOpacity={0.07}
              />
              <line
                x1={x(hover + 0.5)} x2={x(hover + 0.5)} y1={price.top - 14} y2={axisY}
                className="stroke-foreground" strokeWidth={1} strokeOpacity={0.5}
              />
            </g>
          )}

          {/* ------------------------------------------------- X axis ----- */}
          <line
            x1={MARGIN_LEFT} x2={RIGHT} y1={axisY} y2={axisY}
            className="stroke-border" strokeWidth={1}
          />
          {hourTicks.map(({ index, date }) => (
            <text key={index} x={x(index)} y={axisY + 14} textAnchor="middle" className={AXIS_TEXT}>
              {formatHomeTime(date, homeTimeZone)}
            </text>
          ))}
          {dayTicks.map(({ index, date }) => (
            <g key={`day-${index}`}>
              <line
                x1={x(index)} x2={x(index)} y1={axisY - 4} y2={axisY + 4}
                className="stroke-border" strokeWidth={1}
              />
              <text
                x={x(index)} y={axisY + 27} textAnchor="middle"
                className="fill-foreground text-[10px] font-mono font-semibold"
              >
                {formatHomeDayMonth(date, homeTimeZone)}
              </text>
            </g>
          ))}
          {/* ---------------------------------------------------- Score --- */}
          {scoreStrip && quarterScores && (
            <g id="plan-score">
              <line
                x1={MARGIN_LEFT} x2={RIGHT} y1={scoreStrip.top - 22} y2={scoreStrip.top - 22}
                className="stroke-border" strokeWidth={1}
              />
              <PanelHeading
                title={t('Poäng', 'Score')}
                unit={t('regelpoäng per kvart', 'rule points per quarter')}
                y={scoreStrip.top - 6}
              />
              {quarterScores.map((score, index) => {
                if (score === null || score === undefined) return null;
                const left = x(index), width = x(index + 1) - left;
                const colour = scoreColour(score);
                // Digits need about 10 units; narrower quarters (a three-day
                // view) fall back to a coloured cell of the same colour.
                return width >= 9.5 ? (
                  <text
                    key={index} data-score={score} x={left + width / 2} y={scoreStrip.top + 12}
                    textAnchor="middle" fill={colour}
                    className="text-[8.5px] font-mono font-semibold"
                  >
                    {score < 0 ? `−${-score}` : String(score)}
                  </text>
                ) : (
                  <rect
                    key={index} data-score={score} x={left} y={scoreStrip.top + 3}
                    width={Math.max(0.5, width - 0.3)} height={scoreStrip.height - 6}
                    fill={colour}
                  />
                );
              })}
              {selectedIndex >= 0 && selectedIndex < n && (
                <rect
                  x={x(selectedIndex)} y={scoreStrip.top}
                  width={Math.max(2, x(selectedIndex + 1) - x(selectedIndex))} height={scoreStrip.height}
                  className="fill-none stroke-foreground" strokeWidth={1.25}
                />
              )}
              {hover !== null && (
                <rect
                  x={x(hover)} y={scoreStrip.top}
                  width={Math.max(1.5, x(hover + 1) - x(hover))} height={scoreStrip.height}
                  className="fill-foreground" fillOpacity={0.07} pointerEvents="none"
                />
              )}
            </g>
          )}
        </svg>
        </div>
        {scoreDetail && <div className="border-t px-3 py-2 text-sm">{scoreDetail}</div>}
      </div>

      {hovered && pointer && (
        <PlanTooltip
          row={hovered}
          series={series}
          baseValue={baseValues[hover as number]}
          consumptionIssue={consumptionIssues[hover as number]}
          index={hover as number}
          measured={(hover as number) < dividerIndex}
          hasBattery={hasBattery}
          hasEvBattery={hasEvBattery}
          realPrices={realPrices}
          costLines={showCost ? costLines : undefined}
          storeLines={storeLines}
          left={pointer.left}
          top={pointer.top}
          bounds={wrapRef.current?.getBoundingClientRect() ?? null}
        />
      )}
    </div>
  );
};

/**
 * Only what was actually happening, and in the colours it was drawn in.
 *
 * The old tooltip listed every series in the chart, so a house with twenty
 * meters produced twenty lines, nearly all of them "0.00 kW", and the two that
 * were running were lost among them. The swatches are the chart's own colours:
 * a reader matching a band to a number should not have to count bands.
 */
const PlanTooltip: React.FC<{
  row: PlanPanelRow;
  series: ConsumptionSeries[];
  baseValue: number;
  consumptionIssue: ConsumptionIssue | null;
  index: number;
  measured: boolean;
  hasBattery: boolean;
  hasEvBattery: boolean;
  realPrices: boolean;
  costLines?: readonly PlanCostLine[];
  storeLines?: PlanStoreLines;
  left: number;
  top: number;
  bounds: DOMRect | null;
}> = ({
  row, series, baseValue, consumptionIssue, index, measured, hasBattery, hasEvBattery, realPrices, costLines, storeLines,
  left, top, bounds,
}) => {
  const { t } = useLanguage();
  const gap = row.missing ? timelineGapDescription(row.startMs, Date.now(), t) : null;

  // Magnitudes, like the panel: "Battery in −3.59 kW" says the same thing
  // twice, once in the label and once in a minus sign that disagrees with the
  // band it is describing.
  const magnitudes = powerFlowMagnitudes([row]);
  const flows: Array<[string, number, string]> = [
    [t('Sol till huset', 'Solar to house'), magnitudes.solarDirect[0] / 1_000, PLAN_COLOURS.solar],
    [t('Nätimport', 'Grid in'), magnitudes.gridIn[0] / 1_000, PLAN_COLOURS.grid],
    [t('Nätexport', 'Grid out'), magnitudes.gridOut[0] / 1_000, PLAN_COLOURS.grid],
    [t('Batteri ut', 'Battery out'), magnitudes.batteryOut[0] / 1_000, PLAN_COLOURS.battery],
    [t('Batteri in', 'Battery in'), magnitudes.batteryIn[0] / 1_000, PLAN_COLOURS.battery],
  ];
  const running = series
    .map(entry => ({ ...entry, value: entry.values[index] ?? 0 }))
    .filter(entry => entry.value >= 10);

  const width = 244;
  // Flip to the other side of the pointer rather than run off the edge, and
  // keep the whole card inside the chart.
  const offset = bounds && left + width + 24 > bounds.width ? -width - 16 : 16;
  // The compared planner's reading, under the plan's own, where it has one.
  const compared = (
    name: string, colour: string | undefined, values: readonly (number | null)[] | undefined,
    format: (value: number) => string,
  ) => {
    const value = values?.[index];
    return value === null || value === undefined || !Number.isFinite(value) ? null : (
      <Reading name={`${name} · ${storeLines?.name}`} colour={colour} value={format(value)} />
    );
  };
  const estimated = 190 + (running.length + (costLines?.length ?? 0) + (storeLines ? 3 : 0)) * 16;
  const clampedTop = bounds
    ? Math.min(Math.max(4, top - 40), Math.max(4, bounds.height - estimated))
    : Math.max(4, top - 40);

  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 rounded-lg border bg-popover px-2.5 py-2 text-xs shadow-md"
      style={{ left: Math.max(4, left + offset), top: clampedTop, width }}
    >
      <div className="mb-1 flex items-baseline justify-between gap-2 font-medium">
        <span>{row.label}</span>
        <span className="rounded border px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
          {gap ? gap.label : measured ? t('uppmätt', 'measured') : t('plan', 'plan')}
        </span>
      </div>
      {gap ? (
        <p className="text-muted-foreground">{gap.detail}</p>
      ) : <>
      {flows.filter(([, value]) => value >= 0.02).map(([name, value, colour]) => (
        <Reading key={name} name={name} colour={colour} value={`${value.toFixed(2)} kW`} />
      ))}
      <div className="mt-1 border-t pt-1">
        <Reading
          name={t('Husets förbrukning', 'House demand')}
          value={`${Math.abs(kw(row.loadW) ?? 0).toFixed(2)} kW`}
        />
        {running.map(entry => (
          <Reading
            key={entry.key} name={entry.name} colour={loadColour(entry.slot)}
            value={`${entry.partial[index] ? "≥ " : ""}${(entry.value / 1_000).toFixed(2)} kW`}
          />
        ))}
        <Reading
          name={t('Baslast', 'Base load')} colour={PLAN_COLOURS.base}
          value={Number.isFinite(baseValue) ? `${(baseValue / 1_000).toFixed(2)} kW` : t('Ej tillgänglig', 'Unavailable')}
        />
        {consumptionIssue && <p className="mt-1 text-muted-foreground">
          {consumptionGapDescription(consumptionIssue, t)}
        </p>}
      </div>
      <div className="mt-1 border-t pt-1">
        {hasBattery && row.homeSoc !== null && (
          <Reading
            name={t('Hembatteri', 'Home battery')} colour={PLAN_COLOURS.battery}
            value={`${Math.round(row.homeSoc)} %`}
          />
        )}
        {hasBattery && compared(
          t('Hembatteri', 'Home battery'), PLAN_COLOURS.battery, storeLines?.homeSoc, value => `${Math.round(value)} %`,
        )}
        {hasEvBattery && row.evSoc !== null && (
          <Reading
            name={t('Bilbatteri', 'Car battery')} colour={PLAN_COLOURS.ev}
            value={`${Math.round(row.evSoc)} %`}
          />
        )}
        {hasEvBattery && compared(
          t('Bilbatteri', 'Car battery'), PLAN_COLOURS.ev, storeLines?.evSoc, value => `${Math.round(value)} %`,
        )}
        {row.importPriceSekPerKwh !== null && (
          <Reading
            name={realPrices
              ? t('Köp (verkligt)', 'Buy (real)')
              : row.importPriceQuoted
                ? t('Köp', 'Buy')
                : t('Köp (uppskattat)', 'Buy (estimated)')}
            value={`${row.importPriceSekPerKwh.toFixed(2)} SEK/kWh`}
          />
        )}
        {row.exportPriceSekPerKwh !== null && (
          <Reading
            name={realPrices
              ? t('Sälj (verkligt)', 'Sell (real)')
              : row.importPriceQuoted
              ? t('Sälj', 'Sell')
              : t('Sälj (uppskattat)', 'Sell (estimated)')}
            value={`${row.exportPriceSekPerKwh.toFixed(2)} SEK/kWh`}
          />
        )}
        {row.poolTemperatureC != null && (
          <Reading
            name={t('Pooltemperatur', 'Pool temperature')}
            value={`${row.poolTemperatureC.toFixed(1)} °C`}
          />
        )}
        {compared(t('Pooltemperatur', 'Pool temperature'), undefined, storeLines?.poolC, value => `${value.toFixed(1)} °C`)}
        {costLines
          ? costLines.map(line => {
            const value = line.values[index];
            return value === null || value === undefined ? null : (
              <Reading
                key={line.key} name={`${t('Kostnad', 'Cost so far')} · ${line.name}`} colour={line.colour}
                value={`${value.toFixed(2)} kr`}
              />
            );
          })
          : (
            <Reading
              name={t('Kostnad hittills', 'Cost so far')}
              value={`${row.cumulativeCostSek.toFixed(2)} kr`}
            />
          )}
      </div>
      </>}
    </div>
  );
};

/**
 * A swatch carries the identity; the text stays in ink.
 *
 * Colouring the label itself would put a 2:1 yellow on a light popover, which
 * is the one place the chart's palette cannot survive being text.
 */
const Reading: React.FC<{ name: string; value: string; colour?: string }> = ({
  name, value, colour,
}) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span
        className="mt-px h-2 w-2 shrink-0 rounded-sm"
        style={{ backgroundColor: colour ?? 'transparent' }}
        aria-hidden="true"
      />
      <span className="truncate">{name}</span>
    </span>
    <span className="shrink-0 tabular-nums">{value}</span>
  </div>
);

export default PlanPanels;
