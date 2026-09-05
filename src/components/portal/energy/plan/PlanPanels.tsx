// One chart, five panels, one shared time axis.
//
// Replaces the single plot that carried kilowatts, per cent and SEK/kWh against
// three y-axes at once. Nothing about a curve said which axis it belonged to,
// so every reading started with a guess — and a dual axis invents a
// relationship that is not in the data, because the alignment between the two
// scales is arbitrary. Each quantity now gets its own strip and its own axis,
// stacked over the same quarters, so reading a moment in time is reading a
// column: what it cost, where the power came from, what used it, what was left
// in store, what it added up to.
//
// The consumption stack draws individual meters, never categories: the planner
// dispatches individual devices, so a band labelled "Kitchen & cold" would
// describe something no schedule can act on. It stays legible by drawing
// *fewer* meters rather than coarser ones — see consumption-series.ts for
// which ones earn a band.

import React, { useMemo, useRef, useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  linearScale, midpointLinePath, niceTicks, placeBandLabels, stackBands,
  stepAreaPath, stepBandPath, stepLinePath, type BandLabelPlacement, type Scale,
} from '@/lib/energy-shift/plan-chart-geometry';
import {
  PRICE_RAMP_STEPS, priceBands, priceGradientStops,
} from '@/lib/energy-shift/price-bands';
import type { ConsumptionSeries } from '@/lib/energy-shift/consumption-series';
import { powerFlowMagnitudes } from '@/lib/energy-shift/power-flows';
import { loadColour, PLAN_COLOURS } from './types';
import { useHomeTimeZone } from '../HomeTimeZoneContext';
import { formatHomeDayMonth, formatHomeTime, homeHourMinute } from '@/lib/energy-shift/home-time';

export interface PlanPanelRow {
  startMs: number;
  /** Axis label for this quarter, already localised. */
  label: string;
  measured: boolean;
  /**
   * Power, in watts. Signs are ignored: import and export are separate fields,
   * as are charge and discharge, so which way the energy went is already
   * carried by which field it is in (see power-flows.ts).
   */
  solarW: number | null;
  loadW: number | null;
  gridImportW: number | null;
  gridExportW: number | null;
  batteryChargeW: number | null;
  batteryDischargeW: number | null;
  /** Percentages, not fractions. */
  homeSoc: number | null;
  evSoc: number | null;
  importPriceSekPerKwh: number | null;
  exportPriceSekPerKwh: number | null;
  /** Running net cost from the start of the window. */
  cumulativeCostSek: number;
}

const VIEW_W = 1160;
const MARGIN_LEFT = 58;
const MARGIN_RIGHT = 92;
const PLOT_W = VIEW_W - MARGIN_LEFT - MARGIN_RIGHT;
const RIGHT = MARGIN_LEFT + PLOT_W;
const GAP = 34;

const kw = (watts: number | null): number | null =>
  watts === null || !Number.isFinite(watts) ? null : watts / 1_000;

const AXIS_TEXT = 'fill-muted-foreground text-[10px] font-mono';

interface Panel { top: number; height: number }

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
const EndLabel: React.FC<{ y: number; colour: string; children: string }> = ({ y, colour, children }) => (
  <g>
    <circle cx={RIGHT} cy={y} r={3} fill={colour} className="stroke-card" strokeWidth={2} />
    <text x={RIGHT + 7} y={y + 3.5} className={AXIS_TEXT}>{children}</text>
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
  /** First planned quarter; equals rows.length when the window is all history. */
  dividerIndex: number;
  hasBattery: boolean;
  hasEvBattery: boolean;
  selectedIndex?: number;
  onQuarterClick?: (index: number) => void;
}> = ({
  rows, series, baseValues, dividerIndex, hasBattery, hasEvBattery,
  selectedIndex = -1, onQuarterClick,
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
    const cost: Panel = { top: soc.top + (showSoc ? soc.height + GAP : 0), height: 72 };
    const axisY = cost.top + cost.height;

    // --- Price ------------------------------------------------------------
    const buy = rows.map(row => row.importPriceSekPerKwh);
    const sell = rows.map(row => row.exportPriceSekPerKwh);
    const bands = priceBands(buy);
    const priceMax = Math.max(0.5, ...buy.filter((v): v is number => v !== null)) * 1.15;
    const priceY = linearScale([0, priceMax], [price.top + price.height, price.top]);

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
      ...loadBands[loadBands.length - 1].map(pair => pair[1]),
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

    const cumulative = rows.map(row => row.cumulativeCostSek);
    const costMin = Math.min(0, ...cumulative);
    const costMax = Math.max(1, ...cumulative) * 1.18;
    const costY = linearScale([costMin, costMax], [cost.top + cost.height, cost.top]);

    return {
      x, axisY, height: axisY + 42,
      price, priceY, priceMax, buy, sell, bands,
      flow, flowY, flowMin, flowMax, supply, disposal, flowLabels,
      load, loadY, loadMax, loadBands, loadLabels,
      soc, socY, cost, costY, cumulative, costMin, costMax,
    };
  }, [baseValues, n, rows, series, showSoc, t]);

  const {
    x, axisY, height, price, priceY, priceMax, buy, sell, bands,
    flow, flowY, flowMin, flowMax, supply, disposal, flowLabels,
    load, loadY, loadMax, loadBands, loadLabels,
    soc, socY, cost, costY, cumulative, costMin, costMax,
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
  const planWidth = dividerIndex >= n ? 0 : x(n) - x(dividerIndex);

  return (
    <div ref={wrapRef} className="relative">
      <div className="overflow-x-auto rounded-lg border bg-card">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          className="block h-auto w-full min-w-[760px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={onQuarterClick ? { cursor: 'pointer' } : undefined}
          role="img"
          tabIndex={0}
          aria-label={t(
            'Pris, effektflöden, förbrukning, lagernivå och kostnad över tid',
            'Price, power flows, consumption, storage and cost over time',
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
            unit={t('SEK/kWh · köp, färgat billigt → dyrt', 'SEK/kWh · buy, shaded cheap → dear')}
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
                {bands.max.toFixed(2)}
              </text>
            </g>
          )}
          <Gridlines ticks={niceTicks(0, priceMax, 3)} y={priceY} format={tick => tick.toFixed(1)} />
          <path d={stepAreaPath(buy, x, priceY, 0)} fill={priceStroke} fillOpacity={0.2} />
          {bands && [bands.cheapAt, bands.dearAt].map(level => (
            <line
              key={level} x1={MARGIN_LEFT} x2={RIGHT} y1={priceY(level)} y2={priceY(level)}
              className="stroke-muted-foreground" strokeWidth={1} strokeOpacity={0.5}
            />
          ))}
          <path
            d={stepLinePath(sell, x, priceY)} fill="none"
            className="stroke-muted-foreground" strokeWidth={1.25}
          />
          <path
            d={stepLinePath(buy, x, priceY)} fill="none"
            stroke={priceStroke} strokeWidth={3} strokeLinejoin="round"
          />

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
            <>
              <PanelHeading title={t('Lager', 'Storage')} unit="%" y={soc.top - 14} />
              <Gridlines ticks={[0, 50, 100]} y={socY} format={tick => String(tick)} />
              {hasBattery && (
                <>
                  <path
                    d={stepAreaPath(rows.map(row => row.homeSoc), x, socY, 0)}
                    fill={PLAN_COLOURS.battery} fillOpacity={0.2}
                  />
                  <path
                    d={stepLinePath(rows.map(row => row.homeSoc), x, socY)}
                    fill="none" stroke={PLAN_COLOURS.battery} strokeWidth={2}
                  />
                </>
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
            </>
          )}

          {/* ----------------------------------------------------- Cost --- */}
          <PanelHeading
            title={t('Vad det kostar', 'What it costs')}
            unit={t('SEK, ackumulerat', 'SEK, cumulative')}
            y={cost.top - 14}
          />
          <Gridlines ticks={niceTicks(costMin, costMax, 4)} y={costY} format={tick => tick.toFixed(0)} />
          <path
            d={stepAreaPath(cumulative, x, costY, 0)}
            className="fill-foreground" fillOpacity={0.07}
          />
          <path
            d={stepLinePath(cumulative, x, costY)} fill="none"
            className="stroke-foreground" strokeWidth={2}
          />
          <EndLabel y={costY(cumulative[n - 1] ?? 0)} colour="currentColor">
            {`${(cumulative[n - 1] ?? 0).toFixed(2)} kr`}
          </EndLabel>

          {/* ------------------------------------------------- Chrome ----- */}
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
        </svg>
      </div>

      {hovered && pointer && (
        <PlanTooltip
          row={hovered}
          series={series}
          baseValue={baseValues[hover as number] ?? 0}
          index={hover as number}
          measured={(hover as number) < dividerIndex}
          hasBattery={hasBattery}
          hasEvBattery={hasEvBattery}
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
  index: number;
  measured: boolean;
  hasBattery: boolean;
  hasEvBattery: boolean;
  left: number;
  top: number;
  bounds: DOMRect | null;
}> = ({
  row, series, baseValue, index, measured, hasBattery, hasEvBattery, left, top, bounds,
}) => {
  const { t } = useLanguage();

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
  const estimated = 190 + running.length * 16;
  const clampedTop = bounds
    ? Math.min(Math.max(4, top - 40), Math.max(4, bounds.height - estimated))
    : Math.max(4, top - 40);

  return (
    <div
      className="pointer-events-none absolute z-10 rounded-lg border bg-popover px-2.5 py-2 text-xs shadow-md"
      style={{ left: Math.max(4, left + offset), top: clampedTop, width }}
    >
      <div className="mb-1 flex items-baseline justify-between gap-2 font-medium">
        <span>{row.label}</span>
        <span className="rounded border px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
          {measured ? t('uppmätt', 'measured') : t('plan', 'plan')}
        </span>
      </div>
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
            value={`${(entry.value / 1_000).toFixed(2)} kW`}
          />
        ))}
        <Reading
          name={t('Baslast', 'Base load')} colour={PLAN_COLOURS.base}
          value={`${(baseValue / 1_000).toFixed(2)} kW`}
        />
      </div>
      <div className="mt-1 border-t pt-1">
        {hasBattery && row.homeSoc !== null && (
          <Reading
            name={t('Hembatteri', 'Home battery')} colour={PLAN_COLOURS.battery}
            value={`${Math.round(row.homeSoc)} %`}
          />
        )}
        {hasEvBattery && row.evSoc !== null && (
          <Reading
            name={t('Bilbatteri', 'Car battery')} colour={PLAN_COLOURS.ev}
            value={`${Math.round(row.evSoc)} %`}
          />
        )}
        {row.importPriceSekPerKwh !== null && (
          <Reading name={t('Köp', 'Buy')} value={`${row.importPriceSekPerKwh.toFixed(2)} SEK/kWh`} />
        )}
        <Reading
          name={t('Kostnad hittills', 'Cost so far')}
          value={`${row.cumulativeCostSek.toFixed(2)} kr`}
        />
      </div>
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
