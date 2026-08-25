// A very small SVG toolkit: d3 for the maths, strings for the output.
//
// Rendering happens in Node, not in a browser, so there is no DOM to mutate and
// no chart library to fight. d3-scale and d3-shape are pure functions over
// numbers — everything else here is string building. The upshot is that a chart
// is a value: same data in, byte-identical SVG out, diffable in git.
//
// Colours are emitted as `var(--…)` rather than hex so one stylesheet drives
// both themes and nothing has to be re-rendered to switch.

import { scaleLinear } from 'd3-scale';
import { area as d3Area, line as d3Line, curveStepAfter, curveMonotoneX } from 'd3-shape';

export const esc = value => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Attributes render in insertion order, so the output stays stable. */
export const el = (tag, attrs = {}, children = '') => {
  const parts = Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => `${key}="${typeof value === 'number' ? round(value) : esc(value)}"`);
  const open = `<${tag}${parts.length ? ` ${parts.join(' ')}` : ''}`;
  return children === '' || children === null || children === undefined
    ? `${open}/>`
    : `${open}>${Array.isArray(children) ? children.join('') : children}</${tag}>`;
};

/** Three decimals is a tenth of a pixel; beyond that is noise in the diff. */
export const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;

export const group = (attrs, children) => el('g', attrs, children);

/**
 * A quarter is a band, not an instant, so every series is drawn stepped and the
 * last quarter is repeated at the right edge to give it its full width.
 */
const stepPoints = values => values.map((value, i) => [i, value]).concat([[values.length, values[values.length - 1]]]);

export const stepLine = (values, x, y) => d3Line()
  .x(d => x(d[0])).y(d => y(d[1])).curve(curveStepAfter)
  .defined(d => Number.isFinite(d[1]))(stepPoints(values));

export const smoothLine = (values, x, y) => d3Line()
  .x((_, i) => x(i + 0.5)).y(d => y(d)).curve(curveMonotoneX)
  .defined(d => Number.isFinite(d))(values);

export const stepArea = (values, x, y, baseline = 0) => d3Area()
  .x(d => x(d[0])).y1(d => y(d[1])).y0(y(baseline)).curve(curveStepAfter)
  .defined(d => Number.isFinite(d[1]))(stepPoints(values));

/** Stacked bands, bottom-first, as [lower, upper] pairs per quarter. */
export const stackBands = seriesValues => {
  const bands = [];
  const running = new Array(seriesValues[0].length).fill(0);
  for (const values of seriesValues) {
    bands.push(values.map((value, i) => {
      const lower = running[i];
      running[i] += value;
      return [lower, running[i]];
    }));
    }
  return bands;
};

export const bandArea = (band, x, y) => d3Area()
  .x(d => x(d[0])).y0(d => y(d[1][0])).y1(d => y(d[1][1])).curve(curveStepAfter)(
    band.map((pair, i) => [i, pair]).concat([[band.length, band[band.length - 1]]]),
  );

export const scale = (domain, range) => scaleLinear().domain(domain).range(range);

/** Nice-ish kW ticks: never more than five, always including zero. */
export const powerTicks = (min, max, count = 4) => {
  const span = max - min;
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(s => s >= raw) ?? magnitude * 10;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(round(t));
  return ticks;
};

/** Hour marks along the bottom, at whatever spacing keeps labels apart. */
export const hourTicks = (rows, everyHours) => rows
  .map((row, i) => ({ i, row }))
  .filter(({ row }) => row.hour % everyHours === 0 && Math.abs(row.hour % 1) < 1e-9);

export const text = (value, attrs = {}) => el('text', attrs, esc(value));

export const CHART_FONT = 'ui-monospace, "IBM Plex Mono", SFMono-Regular, Menlo, monospace';

/** Axis label, gridline and rule presets — one shade off the surface, always solid. */
export const AXIS = {
  grid: { stroke: 'var(--grid)', 'stroke-width': 1 },
  rule: { stroke: 'var(--axis)', 'stroke-width': 1 },
  label: { fill: 'var(--ink-muted)', 'font-size': 10, 'font-family': CHART_FONT },
};

export const yAxis = ({ ticks, y, x0, x1, format, labelX }) => group({}, [
  ...ticks.map(tick => el('line', { ...AXIS.grid, x1: x0, x2: x1, y1: y(tick), y2: y(tick) })),
  ...ticks.map(tick => text(format(tick), {
    ...AXIS.label, x: labelX ?? x0 - 6, y: y(tick) + 3, 'text-anchor': 'end',
  })),
]);

export const svgRoot = ({ width, height, id, children, plot }) => el('svg', {
  // No width/height attributes: `height="auto"` is not a valid SVG length, and
  // the viewBox plus a CSS width is all a responsive SVG actually needs.
  viewBox: `0 0 ${width} ${height}`,
  preserveAspectRatio: 'xMidYMid meet',
  role: 'img',
  id,
  'data-plot': plot ? JSON.stringify(plot) : undefined,
  xmlns: 'http://www.w3.org/2000/svg',
}, children);
