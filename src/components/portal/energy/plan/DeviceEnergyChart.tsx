// Per-device energy and cost for the selected window, as bars.
//
// Each device gets two bars across the full width: energy split by where it
// came from, and under it what the grid share of that energy cost. Each bar has
// its own scale — kWh and SEK are different measures, and one scale would let
// the larger flatten the other — so each carries its value and unit beside it.
//
// Stripes mean estimated: planned quarters, energy spread over a delayed
// meter's reporting interval, load the supply meters did not cover (in its
// quarter's mix), and cost at the planner's price where none is published yet. Solid is a reading at a published price. The numbers behind
// every bar are in the hover card and in the table view (DeviceEnergyTable).

import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLanguage } from '@/contexts/LanguageContext';
import { totalRow, type AttributionResult, type AttributionRow } from '@/lib/energy-shift/energy-attribution';
import { PLAN_COLOURS } from '../charts/palette';

const kwh = (value: number) => value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
const sek = (value: number) => value.toFixed(value >= 100 ? 0 : 2);

// Money is not a source of energy, so it takes neutral ink rather than a hue.
const COST = 'hsl(var(--foreground) / 0.55)';
const STRIPES = 'repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.6) 0 2px, transparent 2px 5px)';

const fill = (colour: string, estimated: boolean): React.CSSProperties =>
  estimated ? { backgroundColor: colour, backgroundImage: STRIPES } : { backgroundColor: colour };

type Part = { key: string; value: number; colour: string; estimated: boolean };

const energyParts = (row: AttributionRow): Part[] => [
  { key: 'grid', value: row.gridKwh - row.estimatedGridKwh, colour: PLAN_COLOURS.grid, estimated: false },
  { key: 'grid-est', value: row.estimatedGridKwh, colour: PLAN_COLOURS.grid, estimated: true },
  { key: 'solar', value: row.solarKwh - row.estimatedSolarKwh, colour: PLAN_COLOURS.solar, estimated: false },
  { key: 'solar-est', value: row.estimatedSolarKwh, colour: PLAN_COLOURS.solar, estimated: true },
  { key: 'battery', value: row.batteryKwh - row.estimatedBatteryKwh, colour: PLAN_COLOURS.battery, estimated: false },
  { key: 'battery-est', value: row.estimatedBatteryKwh, colour: PLAN_COLOURS.battery, estimated: true },
].filter(part => part.value > 0.0005);

const costParts = (row: AttributionRow): Part[] => [
  { key: 'cost', value: row.costSek - row.estimatedCostSek, colour: COST, estimated: false },
  { key: 'cost-est', value: row.estimatedCostSek, colour: COST, estimated: true },
].filter(part => part.value > 0.0005);

const percent = (value: number, max: number) => (max > 0 ? `${(value / max) * 100}%` : '0%');

/** One bar on its own scale, with its value and unit at the right. */
const Bar: React.FC<{ parts: Part[]; max: number; height: string; value: React.ReactNode }> = ({ parts, max, height, value }) => {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  return (
    <span className="flex items-center gap-3">
      <span className={`relative flex-1 ${height}`}>
        <span
          className="absolute inset-y-0 left-0 flex gap-[2px] overflow-hidden rounded-r"
          style={{ width: percent(total, max), minWidth: total > 0 ? 2 : 0 }}
        >
          {parts.map(part => (
            <span key={part.key} className="h-full shrink-0"
              style={{ ...fill(part.colour, part.estimated), flexGrow: part.value, flexBasis: 0, minWidth: 1 }} />
          ))}
        </span>
      </span>
      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-foreground">{value}</span>
    </span>
  );
};

const Unit: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-muted-foreground"> {children}</span>
);

const Swatch: React.FC<{ style?: React.CSSProperties }> = ({ style }) => (
  <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={style} />
);

const DeviceEnergyChart: React.FC<{ result: AttributionResult }> = ({ result }) => {
  const { t } = useLanguage();
  const totals = totalRow(result.rows);
  const sources = (row: AttributionRow) => row.gridKwh + row.solarKwh + row.batteryKwh;
  const maxKwh = Math.max(0, ...result.rows.map(sources));
  const maxCost = Math.max(0, ...result.rows.map(row => row.costSek));
  const estimatedKwh = (row: AttributionRow) => row.estimatedGridKwh + row.estimatedSolarKwh + row.estimatedBatteryKwh;
  const hasEstimates = result.rows.some(row => estimatedKwh(row) > 0.0005 || row.estimatedCostSek > 0.0005);

  if (result.rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('Ingen förbrukning i den valda perioden.', 'No consumption in the selected period.')}
      </p>
    );
  }

  const legend = [
    { key: 'grid', label: t('Nät', 'Grid'), style: fill(PLAN_COLOURS.grid, false) },
    { key: 'solar', label: t('Sol', 'Solar'), style: fill(PLAN_COLOURS.solar, false) },
    { key: 'battery', label: t('Batteri', 'Battery'), style: fill(PLAN_COLOURS.battery, false) },
    { key: 'cost', label: t('Kostnad', 'Cost'), style: fill(COST, false) },
    ...(hasEstimates ? [{ key: 'estimated', label: t('Uppskattat', 'Estimated'), style: fill(PLAN_COLOURS.base, true) }] : []),
  ];

  const detail = (row: AttributionRow) => {
    const estimated = estimatedKwh(row);
    const lines: Array<{ label: string; value: string; swatch?: React.CSSProperties; strong?: boolean }> = [
      { label: t('Nät', 'Grid'), value: `${kwh(row.gridKwh)} kWh`, swatch: fill(PLAN_COLOURS.grid, false) },
      { label: t('Sol', 'Solar'), value: `${kwh(row.solarKwh)} kWh`, swatch: fill(PLAN_COLOURS.solar, false) },
      { label: t('Batteri', 'Battery'), value: `${kwh(row.batteryKwh)} kWh`, swatch: fill(PLAN_COLOURS.battery, false) },
      { label: t('Totalt', 'Total'), value: `${kwh(row.totalKwh)} kWh`, strong: true },
      { label: t('Kostnad', 'Cost'), value: `${row.fullyPriced ? '' : '≥ '}${sek(row.costSek)} kr`, swatch: fill(COST, false), strong: true },
      ...(row.gridKwh > 0.0005 && row.costSek > 0
        ? [{ label: t('Snittpris nät', 'Average grid price'), value: `${(row.costSek / row.gridKwh).toFixed(2)} kr/kWh` }]
        : []),
      ...(estimated > 0.0005 ? [{ label: t('Varav uppskattad energi', 'Of which estimated energy'), value: `${kwh(estimated)} kWh`, swatch: fill(PLAN_COLOURS.base, true) }] : []),
      ...(row.estimatedCostSek > 0.0005 ? [{ label: t('Varav uppskattad kostnad', 'Of which estimated cost'), value: `${sek(row.estimatedCostSek)} kr`, swatch: fill(COST, true) }] : []),
    ];
    return (
      <div className="min-w-52">
        <p className="mb-1 font-medium">{row.name}</p>
        <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-0.5">
          {lines.map(line => (
            <React.Fragment key={line.label}>
              {line.swatch ? <Swatch style={line.swatch} /> : <span />}
              <dt className="text-muted-foreground">{line.label}</dt>
              <dd className={`text-right tabular-nums ${line.strong ? 'font-medium' : ''}`}>{line.value}</dd>
            </React.Fragment>
          ))}
        </dl>
        {!row.fullyPriced && (
          <p className="mt-1 max-w-60 text-muted-foreground">
            {t('Pris saknas för en del kvartar; kostnaden gäller bara de prissatta.', 'Some quarters have no price; the cost covers only the priced ones.')}
          </p>
        )}
      </div>
    );
  };

  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t('Förklaring', 'Legend')}>
        {legend.map(entry => (
          <li key={entry.key} className="flex items-center gap-1.5">
            <Swatch style={entry.style} />
            {entry.label}
          </li>
        ))}
      </ul>

      <ul className="border-t">
        {result.rows.map(row => (
          <Tooltip key={row.key} delayDuration={100}>
            <TooltipTrigger asChild>
              <li
                tabIndex={0}
                className="flex flex-col gap-1 rounded-sm py-2 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className={`truncate text-sm ${row.kind === 'device' ? 'font-medium' : 'text-muted-foreground'}`}>
                  {row.name}
                </span>
                <Bar parts={energyParts(row)} max={maxKwh} height="h-3"
                  value={<>{kwh(row.totalKwh)}<Unit>kWh</Unit></>} />
                <Bar parts={costParts(row)} max={maxCost} height="h-2"
                  value={<>{row.fullyPriced ? '' : '≥ '}{sek(row.costSek)}<Unit>kr</Unit></>} />
              </li>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="text-xs">
              {detail(row)}
            </TooltipContent>
          </Tooltip>
        ))}
      </ul>

      <p className="mt-2 border-t pt-2 text-xs text-muted-foreground tabular-nums">
        {t('Summa', 'Total')}: <span className="font-medium text-foreground">{kwh(totals.totalKwh)} kWh</span>
        {' · '}{t('nät', 'grid')} {kwh(totals.gridKwh)}
        {' · '}{t('sol', 'solar')} {kwh(totals.solarKwh)}
        {' · '}{t('batteri', 'battery')} {kwh(totals.batteryKwh)}
        {' · '}<span className="font-medium text-foreground">{sek(totals.costSek)} kr</span>
        {totals.estimatedCostSek > 0.0005 && <>{' '}({t('varav uppskattat', 'of which estimated')} {sek(totals.estimatedCostSek)} kr)</>}
      </p>
    </div>
  );
};

export default DeviceEnergyChart;
