// One chart, five panels, one shared time axis.
//
// Replaces the single plot that carried kilowatts, per cent and SEK/kWh against
// three y-axes at once. Nothing about a curve said which axis it belonged to,
// so every reading started with a guess — and a dual axis invents a
// relationship that is not in the data, because the alignment between the two
// scales is arbitrary. Each quantity now gets its own strip and its own axis,
// stacked over the same quarters, so reading a moment in time is reading a
// column: what it cost, where the power came from, which meters were running,
// what was left in store, what it added up to.
//
// Devices are drawn as a matrix rather than a stack, one row per meter. Colour
// cannot carry nineteen identities — eight distinguishable hues is the ceiling,
// and the previous chart cycled a palette of eight across all of them, so three
// meters shared every colour — and grouping them is not available either: the
// planner schedules individual devices, so a chart that buckets them describes
// something the plan cannot act on. Position carries identity here and darkness
// carries power, which has no such ceiling.

import React, { useMemo, useRef, useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  linearScale, midpointLinePath, niceTicks, spansOf, stackBands,
  stepAreaPath, stepBandPath, stepLinePath, type Band, type Scale,
} from '@/lib/energy-shift/plan-chart-geometry';
import {
  PRICE_RAMP_STEPS, priceBands, priceGradientStops,
} from '@/lib/energy-shift/price-bands';
import { SIGNIFICANT_POWER_W } from '@/lib/energy-shift/energy-timeline';

export interface PlanPanelRow {
  startMs: number;
  /** Axis label for this quarter, already localised. */
  label: string;
  measured: boolean;
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

export interface PlanPanelDevice {
  key: string;
  name: string;
  /** Watts per quarter, one entry per row. */
  values: number[];
  kwh: number;
}

const VIEW_W = 1160;
/** Wide enough for a meter name; every panel shares it so columns line up. */
const MARGIN_LEFT = 138;
const MARGIN_RIGHT = 88;
const PLOT_W = VIEW_W - MARGIN_LEFT - MARGIN_RIGHT;
const GAP = 34;
const ROW_H = 15;
const ROW_GAP = 2;
const CELL_STEPS = 6;
const NAME_MAX = 22;

const kw = (watts: number | null): number | null =>
  watts === null || !Number.isFinite(watts) ? null : watts / 1_000;

const AXIS_TEXT = 'fill-muted-foreground text-[10px] font-mono';
const TITLE_TEXT = 'fill-foreground text-[11px] font-medium';
const UNIT_TEXT = 'fill-muted-foreground text-[10px] font-mono';

interface Panel {
  top: number;
  height: number;
}

const truncate = (name: string): string =>
  name.length <= NAME_MAX ? name : `${name.slice(0, NAME_MAX - 1)}…`;

const PanelHeading: React.FC<{ title: string; unit: string; y: number }> = ({ title, unit, y }) => (
  <>
    <text x={MARGIN_LEFT} y={y} className={TITLE_TEXT}>{title}</text>
    <text x={MARGIN_LEFT + title.length * 6.6 + 10} y={y} className={UNIT_TEXT}>{unit}</text>
  </>
);

const Gridlines: React.FC<{
  ticks: number[];
  y: Scale;
  format: (tick: number) => string;
}> = ({ ticks, y, format }) => (
  <>
    {ticks.map(tick => (
      <g key={tick}>
        <line
          x1={MARGIN_LEFT} x2={MARGIN_LEFT + PLOT_W} y1={y(tick)} y2={y(tick)}
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
    <circle cx={MARGIN_LEFT + PLOT_W} cy={y} r={3} fill={colour} className="stroke-card" strokeWidth={2} />
    <text x={MARGIN_LEFT + PLOT_W + 7} y={y + 3.5} className={AXIS_TEXT}>{children}</text>
  </g>
);

const PlanPanels: React.FC<{
  rows: PlanPanelRow[];
  devices: PlanPanelDevice[];
  /** First planned quarter; equals rows.length when the window is all history. */
  dividerIndex: number;
  hasBattery: boolean;
  hasEvBattery: boolean;
  selectedIndex?: number;
  onQuarterClick?: (index: number) => void;
}> = ({ rows, devices, dividerIndex, hasBattery, hasEvBattery, selectedIndex = -1, onQuarterClick }) => {
  const { t } = useLanguage();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ left: number; top: number } | null>(null);

  const n = rows.length;
  const showSoc = (hasBattery && rows.some(row => row.homeSoc !== null))
    || (hasEvBattery && rows.some(row => row.evSoc !== null));

  const geometry = useMemo(() => {
    const x = linearScale([0, Math.max(1, n)], [MARGIN_LEFT, MARGIN_LEFT + PLOT_W]);

    const price: Panel = { top: 30, height: 68 };
    const flow: Panel = { top: price.top + price.height + GAP, height: 126 };
    const matrixTop = flow.top + flow.height + GAP;
    const matrixHeight = Math.max(
      ROW_H,
      devices.length * (ROW_H + ROW_GAP) - ROW_GAP,
    );
    const matrix: Panel = { top: matrixTop, height: matrixHeight };
    const soc: Panel = { top: matrix.top + matrix.height + GAP, height: showSoc ? 62 : 0 };
    const cost: Panel = {
      top: soc.top + (showSoc ? soc.height + GAP : 0),
      height: 72,
    };
    const axisY = cost.top + cost.height;

    // --- Price ------------------------------------------------------------
    const buy = rows.map(row => row.importPriceSekPerKwh);
    const sell = rows.map(row => row.exportPriceSekPerKwh);
    const bands = priceBands(buy);
    const priceMax = Math.max(0.5, ...buy.filter((v): v is number => v !== null)) * 1.15;
    const priceY = linearScale([0, priceMax], [price.top + price.height, price.top]);

    // --- Flows: into the house above zero, out of it below ----------------
    // Solar counted here is what the house used *directly*: what the panels
    // made, less whatever was exported or stored. Counting all of it would
    // credit the same watt twice.
    const supply = stackBands([
      rows.map(row => Math.max(
        0,
        (row.solarW ?? 0) - (row.gridExportW ?? 0) - (row.batteryChargeW ?? 0),
      ) / 1_000),
      rows.map(row => (row.batteryDischargeW ?? 0) / 1_000),
      rows.map(row => (row.gridImportW ?? 0) / 1_000),
    ]);
    const disposal = stackBands([
      rows.map(row => -(row.batteryChargeW ?? 0) / 1_000),
      rows.map(row => -(row.gridExportW ?? 0) / 1_000),
    ]);
    const flowMax = Math.max(0.5, ...supply[2].map(pair => pair[1])) * 1.12;
    const flowMin = Math.min(-0.5, ...disposal[1].map(pair => pair[0])) * 1.1;
    const flowY = linearScale([flowMin, flowMax], [flow.top + flow.height, flow.top]);

    // --- Devices ----------------------------------------------------------
    const peakKw = Math.max(0.05, ...devices.flatMap(device => device.values)) / 1_000;
    // Square root, not linear: a 90 W fridge and a 7 kW charger share one ramp,
    // and on a linear scale everything but the charger is blank.
    const cellStep = (watts: number): number => watts < SIGNIFICANT_POWER_W
      ? 0
      : Math.max(1, Math.min(CELL_STEPS, Math.ceil(
        Math.min(1, Math.sqrt((watts / 1_000) / peakKw)) * CELL_STEPS,
      )));
    const maxKwh = Math.max(0.01, ...devices.map(device => device.kwh));
    const barW = linearScale([0, maxKwh], [0, 52]);

    // --- Storage ----------------------------------------------------------
    const socY = linearScale([0, 100], [soc.top + soc.height, soc.top]);

    // --- Cost -------------------------------------------------------------
    const cumulative = rows.map(row => row.cumulativeCostSek);
    const costMin = Math.min(0, ...cumulative);
    const costMax = Math.max(1, ...cumulative) * 1.18;
    const costY = linearScale([costMin, costMax], [cost.top + cost.height, cost.top]);

    return {
      x, axisY, height: axisY + 42,
      price, priceY, priceMax, buy, sell, bands,
      flow, flowY, flowMin, flowMax, supply, disposal,
      matrix, cellStep, barW,
      soc, socY, cost, costY, cumulative, costMin, costMax,
    };
  }, [devices, n, rows, showSoc]);

  const {
    x, axisY, height, price, priceY, priceMax, buy, sell, bands,
    flow, flowY, flowMin, flowMax, supply, disposal,
    matrix, cellStep, barW, soc, socY, cost, costY, cumulative, costMin, costMax,
  } = geometry;

  const gradientId = 'plan-price-ramp';
  const gradientStroke = bands ? `url(#${gradientId})` : 'var(--plan-price-4)';

  /** Hour marks, thinned so labels never collide at a narrow width. */
  const hourTicks = useMemo(() => {
    const every = n > 200 ? 6 : n > 100 ? 3 : 2;
    return rows
      .map((row, index) => ({ index, row, date: new Date(row.startMs) }))
      .filter(({ date }) => date.getMinutes() === 0 && date.getHours() % every === 0);
  }, [n, rows]);

  const dayTicks = useMemo(() => rows
    .map((row, index) => ({ index, date: new Date(row.startMs) }))
    .filter(({ index, date }) => index > 0 && date.getHours() === 0 && date.getMinutes() === 0),
  [rows]);

  const indexFromClientX = (clientX: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    if (box.width === 0) return null;
    const viewX = (clientX - box.left) * (VIEW_W / box.width);
    const index = Math.floor(((viewX - MARGIN_LEFT) / PLOT_W) * n);
    return index >= 0 && index < n ? index : null;
  };

  const handleMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const index = indexFromClientX(event.clientX);
    setHover(index);
    const wrap = wrapRef.current;
    if (index === null || !wrap) { setPointer(null); return; }
    const box = wrap.getBoundingClientRect();
    setPointer({ left: event.clientX - box.left, top: event.clientY - box.top });
  };

  const handleKey = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const from = hover ?? dividerIndex;
    const next = Math.max(0, Math.min(n - 1, from + (event.key === 'ArrowLeft' ? -1 : 1)));
    setHover(next);
    setPointer({ left: ((next + 0.5) / n) * PLOT_W + MARGIN_LEFT, top: flow.top });
  };

  const hovered = hover === null ? null : rows[hover];
  const planWidth = dividerIndex >= n ? 0 : x(n) - x(dividerIndex);

  const flowBand = (band: Band, colour: string, opacity: number, key: string) => (
    <path key={key} d={stepBandPath(band, x, flowY)} fill={colour} fillOpacity={opacity} />
  );

  return (
    <div ref={wrapRef} className="relative">
      <div className="overflow-x-auto rounded-lg border bg-card">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          className="block h-auto w-full min-w-[820px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={onQuarterClick ? { cursor: 'pointer' } : undefined}
          role="img"
          tabIndex={0}
          aria-label={t(
            'Pris, effektflöden, enheter, lagernivå och kostnad över tid',
            'Price, power flows, devices, storage and cost over time',
          )}
          onPointerMove={handleMove}
          onPointerLeave={() => { setHover(null); setPointer(null); }}
          onKeyDown={handleKey}
          onClick={() => { if (hover !== null) onQuarterClick?.(hover); }}
        >
          {bands && (
            <defs>
              <linearGradient
                id={gradientId}
                gradientUnits="userSpaceOnUse"
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
              <rect
                x={MARGIN_LEFT + PLOT_W - PRICE_RAMP_STEPS * 13 - 6}
                y={price.top - 23}
                width={PRICE_RAMP_STEPS * 13} height={9}
                fill={`url(#${gradientId})`} opacity={0}
              />
              {Array.from({ length: PRICE_RAMP_STEPS }, (_, step) => (
                <rect
                  key={step}
                  x={MARGIN_LEFT + PLOT_W - PRICE_RAMP_STEPS * 13 - 6 + step * 13}
                  y={price.top - 23} width={12} height={9}
                  fill={`var(--plan-price-${step + 1})`}
                />
              ))}
              <text
                x={MARGIN_LEFT + PLOT_W - PRICE_RAMP_STEPS * 13 - 12}
                y={price.top - 15} textAnchor="end" className={AXIS_TEXT}
              >
                {bands.min.toFixed(2)}
              </text>
              <text x={MARGIN_LEFT + PLOT_W + 2} y={price.top - 15} className={AXIS_TEXT}>
                {bands.max.toFixed(2)}
              </text>
            </g>
          )}
          <Gridlines
            ticks={niceTicks(0, priceMax, 3)} y={priceY}
            format={tick => tick.toFixed(1)}
          />
          <path d={stepAreaPath(buy, x, priceY, 0)} fill={gradientStroke} fillOpacity={0.2} />
          {bands && [bands.cheapAt, bands.dearAt].map(level => (
            <line
              key={level}
              x1={MARGIN_LEFT} x2={MARGIN_LEFT + PLOT_W} y1={priceY(level)} y2={priceY(level)}
              className="stroke-muted-foreground" strokeWidth={1} strokeOpacity={0.5}
            />
          ))}
          <path
            d={stepLinePath(sell, x, priceY)} fill="none"
            className="stroke-muted-foreground" strokeWidth={1.25}
          />
          <path
            d={stepLinePath(buy, x, priceY)} fill="none"
            stroke={gradientStroke} strokeWidth={3} strokeLinejoin="round"
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
          {flowBand(supply[0], 'var(--plan-solar)', 0.9, 'solar')}
          {flowBand(supply[1], 'var(--plan-battery)', 0.9, 'discharge')}
          {flowBand(supply[2], 'var(--plan-grid)', 0.9, 'import')}
          {flowBand(disposal[0], 'var(--plan-battery)', 0.42, 'charge')}
          {flowBand(disposal[1], 'var(--plan-grid)', 0.42, 'export')}
          {/* A two-pixel gap of card colour keeps the stack from fusing. */}
          {[supply[0], supply[1]].map((band, index) => (
            <path
              key={`sep-${index}`}
              d={stepLinePath(band.map(pair => pair[1]), x, flowY)}
              fill="none" className="stroke-card" strokeWidth={2}
            />
          ))}
          <line
            x1={MARGIN_LEFT} x2={MARGIN_LEFT + PLOT_W} y1={flowY(0)} y2={flowY(0)}
            className="stroke-foreground" strokeWidth={1.25}
          />

          {/* -------------------------------------------------- Devices --- */}
          <PanelHeading
            title={t('Enheter', 'Devices')}
            unit={t(
              'mörkare = mer effekt · störst först',
              'darker = more power · largest first',
            )}
            y={matrix.top - 14}
          />
          <g>
            {Array.from({ length: CELL_STEPS + 1 }, (_, step) => (
              <rect
                key={step}
                x={MARGIN_LEFT + PLOT_W - (CELL_STEPS + 1) * 13 - 6 + step * 13}
                y={matrix.top - 23} width={12} height={9}
                fill={`var(--plan-cell-${step})`}
              />
            ))}
            <text x={MARGIN_LEFT + PLOT_W + 2} y={matrix.top - 15} className={AXIS_TEXT}>
              kWh
            </text>
          </g>
          {devices.map((device, rowIndex) => {
            const top = matrix.top + rowIndex * (ROW_H + ROW_GAP);
            return (
              <g key={device.key}>
                {spansOf(device.values.map(cellStep)).map(span => (
                  <rect
                    key={span.from}
                    x={x(span.from)} y={top}
                    width={Math.max(0.5, x(span.to) - x(span.from))} height={ROW_H}
                    fill={`var(--plan-cell-${span.value})`}
                  />
                ))}
                <text
                  x={MARGIN_LEFT - 10} y={top + ROW_H - 4}
                  textAnchor="end" className="fill-foreground text-[9.5px]"
                >
                  {truncate(device.name)}
                  <title>{device.name}</title>
                </text>
                <rect
                  x={MARGIN_LEFT + PLOT_W + 10} y={top + 3}
                  width={Math.max(1, barW(device.kwh))} height={ROW_H - 6} rx={1}
                  className="fill-muted-foreground" fillOpacity={0.5}
                />
                <text
                  x={MARGIN_LEFT + PLOT_W + 66} y={top + ROW_H - 4}
                  className="fill-muted-foreground text-[9px] font-mono"
                >
                  {device.kwh.toFixed(1)}
                </text>
              </g>
            );
          })}

          {/* -------------------------------------------------- Storage --- */}
          {showSoc && (
            <>
              <PanelHeading title={t('Lager', 'Storage')} unit="%" y={soc.top - 14} />
              <Gridlines ticks={[0, 50, 100]} y={socY} format={tick => String(tick)} />
              {hasBattery && (
                <>
                  <path
                    d={stepAreaPath(rows.map(row => row.homeSoc), x, socY, 0)}
                    fill="var(--plan-battery)" fillOpacity={0.2}
                  />
                  <path
                    d={stepLinePath(rows.map(row => row.homeSoc), x, socY)}
                    fill="none" stroke="var(--plan-battery)" strokeWidth={2}
                  />
                </>
              )}
              {hasEvBattery && (
                <path
                  d={midpointLinePath(rows.map(row => row.evSoc), x, socY)}
                  fill="none" stroke="var(--plan-ev)" strokeWidth={2}
                />
              )}
              {hasBattery && rows[n - 1]?.homeSoc !== null && (
                <EndLabel y={socY(rows[n - 1].homeSoc as number)} colour="var(--plan-battery)">
                  {`${t('hem', 'home')} ${Math.round(rows[n - 1].homeSoc as number)}%`}
                </EndLabel>
              )}
              {hasEvBattery && rows[n - 1]?.evSoc !== null && (
                <EndLabel y={socY(rows[n - 1].evSoc as number)} colour="var(--plan-ev)">
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
          <Gridlines
            ticks={niceTicks(costMin, costMax, 4)} y={costY}
            format={tick => tick.toFixed(0)}
          />
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
            x1={MARGIN_LEFT} x2={MARGIN_LEFT + PLOT_W} y1={axisY} y2={axisY}
            className="stroke-border" strokeWidth={1}
          />
          {hourTicks.map(({ index, date }) => (
            <text
              key={index} x={x(index)} y={axisY + 14}
              textAnchor="middle" className={AXIS_TEXT}
            >
              {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
                {date.toLocaleDateString([], { day: '2-digit', month: '2-digit' })}
              </text>
            </g>
          ))}
        </svg>
      </div>

      {hovered && pointer && (
        <PlanTooltip
          row={hovered}
          devices={devices}
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
 * Only what was actually happening.
 *
 * The old tooltip listed every series in the chart, so a house with twenty
 * meters produced twenty lines, nearly all of them "0.00 kW", and the two that
 * were running were lost among them.
 */
const PlanTooltip: React.FC<{
  row: PlanPanelRow;
  devices: PlanPanelDevice[];
  index: number;
  measured: boolean;
  hasBattery: boolean;
  hasEvBattery: boolean;
  left: number;
  top: number;
  bounds: DOMRect | null;
}> = ({ row, devices, index, measured, hasBattery, hasEvBattery, left, top, bounds }) => {
  const { t } = useLanguage();
  const running = devices
    .map(device => ({ name: device.name, value: device.values[index] ?? 0 }))
    .filter(entry => entry.value >= SIGNIFICANT_POWER_W)
    .sort((a, b) => b.value - a.value);

  const flows: Array<[string, number | null]> = [
    [t('Sol', 'Solar'), kw(row.solarW)],
    [t('Nätimport', 'Grid in'), kw(row.gridImportW)],
    [t('Nätexport', 'Grid out'), kw(row.gridExportW)],
    [t('Batteri ut', 'Battery out'), kw(row.batteryDischargeW)],
    [t('Batteri in', 'Battery in'), kw(row.batteryChargeW)],
  ];

  const width = 236;
  // Flip to the other side of the pointer rather than run off the edge, and
  // keep the whole card inside the chart however tall the device matrix is.
  const offset = bounds && left + width + 24 > bounds.width ? -width - 16 : 16;
  const estimatedHeight = 150 + running.slice(0, 7).length * 16;
  const top_ = bounds
    ? Math.min(Math.max(4, top - 40), Math.max(4, bounds.height - estimatedHeight))
    : Math.max(4, top - 40);

  return (
    <div
      className="pointer-events-none absolute z-10 rounded-lg border bg-popover px-2.5 py-2 text-xs shadow-md"
      style={{ left: Math.max(4, left + offset), top: top_, width }}
    >
      <div className="mb-1 flex items-baseline justify-between gap-2 font-medium">
        <span>{row.label}</span>
        <span className="rounded border px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
          {measured ? t('uppmätt', 'measured') : t('plan', 'plan')}
        </span>
      </div>
      {flows.filter(([, value]) => value !== null && Math.abs(value) >= 0.02).map(([name, value]) => (
        <Reading key={name} name={name} value={`${(value as number).toFixed(2)} kW`} />
      ))}
      <div className="mt-1 border-t pt-1">
        <Reading
          name={t('Husets förbrukning', 'House demand')}
          value={`${(kw(row.loadW) ?? 0).toFixed(2)} kW`}
        />
        {running.slice(0, 6).map(entry => (
          <Reading
            key={entry.name} name={entry.name} value={`${(entry.value / 1_000).toFixed(2)} kW`} muted
          />
        ))}
        {running.length > 6 && (
          <Reading
            name={t(`+ ${running.length - 6} till`, `+ ${running.length - 6} more`)}
            value="" muted
          />
        )}
      </div>
      <div className="mt-1 border-t pt-1">
        {hasBattery && row.homeSoc !== null && (
          <Reading name={t('Hembatteri', 'Home battery')} value={`${Math.round(row.homeSoc)} %`} />
        )}
        {hasEvBattery && row.evSoc !== null && (
          <Reading name={t('Bilbatteri', 'Car battery')} value={`${Math.round(row.evSoc)} %`} />
        )}
        {row.importPriceSekPerKwh !== null && (
          <Reading
            name={t('Köp', 'Buy')}
            value={`${row.importPriceSekPerKwh.toFixed(2)} SEK/kWh`}
          />
        )}
        <Reading
          name={t('Kostnad hittills', 'Cost so far')}
          value={`${row.cumulativeCostSek.toFixed(2)} kr`}
        />
      </div>
    </div>
  );
};

const Reading: React.FC<{ name: string; value: string; muted?: boolean }> = ({ name, value, muted }) => (
  <div className={`flex items-baseline justify-between gap-3 ${muted ? 'text-muted-foreground' : ''}`}>
    <span className="truncate">{name}</span>
    <span className="shrink-0 tabular-nums">{value}</span>
  </div>
);

export default PlanPanels;
