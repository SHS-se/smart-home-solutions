// Per-device energy and cost for the selected window, as bars.
//
// Each device gets two bars on their own scales: energy split by where it came
// from, and what the grid share of it cost. They sit in separate columns
// rather than on one axis — kWh and SEK are different measures, and a single
// scale would let the larger of the two flatten the other. The numbers behind
// every bar are in the hover card and in the table view (DeviceEnergyTable).

import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLanguage } from '@/contexts/LanguageContext';
import { totalRow, type AttributionResult, type AttributionRow } from '@/lib/energy-shift/energy-attribution';
import { PLAN_COLOURS } from '../charts/palette';

const kwh = (value: number) => value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
const sek = (value: number) => value.toFixed(value >= 100 ? 0 : 2);

// Load the meters say happened but no grid, solar or battery reading supplied.
const UNMEASURED = `repeating-linear-gradient(135deg, ${PLAN_COLOURS.base} 0 2px, transparent 2px 5px)`;

// Money is not a source of energy, so it takes neutral ink rather than a hue.
const COST = 'hsl(var(--foreground) / 0.55)';

const unmeasuredKwh = (row: Pick<AttributionRow, 'totalKwh' | 'gridKwh' | 'solarKwh' | 'batteryKwh'>) =>
  Math.max(0, row.totalKwh - row.gridKwh - row.solarKwh - row.batteryKwh);

type Segment = { key: string; kwh: number; background: string };

const segments = (row: AttributionRow): Segment[] => [
  { key: 'grid', kwh: row.gridKwh, background: PLAN_COLOURS.grid },
  { key: 'solar', kwh: row.solarKwh, background: PLAN_COLOURS.solar },
  { key: 'battery', kwh: row.batteryKwh, background: PLAN_COLOURS.battery },
  { key: 'unmeasured', kwh: unmeasuredKwh(row), background: UNMEASURED },
].filter(segment => segment.kwh > 0.0005);

const percent = (value: number, max: number) => (max > 0 ? `${(value / max) * 100}%` : '0%');

const DeviceEnergyChart: React.FC<{ result: AttributionResult }> = ({ result }) => {
  const { t } = useLanguage();
  const currency = t('kr', 'SEK');
  const totals = totalRow(result.rows);
  const maxKwh = Math.max(0, ...result.rows.map(row => row.totalKwh));
  const maxCost = Math.max(0, ...result.rows.map(row => row.costSek));
  const hasUnmeasured = result.rows.some(row => unmeasuredKwh(row) > 0.0005);

  if (result.rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('Ingen förbrukning i den valda perioden.', 'No consumption in the selected period.')}
      </p>
    );
  }

  const legend = [
    { key: 'grid', label: t('Nät', 'Grid'), background: PLAN_COLOURS.grid },
    { key: 'solar', label: t('Sol', 'Solar'), background: PLAN_COLOURS.solar },
    { key: 'battery', label: t('Batteri', 'Battery'), background: PLAN_COLOURS.battery },
    ...(hasUnmeasured ? [{ key: 'unmeasured', label: t('Källa ej uppmätt', 'Source not measured'), background: UNMEASURED }] : []),
    { key: 'cost', label: t('Kostnad', 'Cost'), background: COST },
  ];

  const detail = (row: AttributionRow) => {
    const unmeasured = unmeasuredKwh(row);
    const lines: Array<[string, string]> = [
      [t('Nät', 'Grid'), `${kwh(row.gridKwh)} kWh`],
      [t('Sol', 'Solar'), `${kwh(row.solarKwh)} kWh`],
      [t('Batteri', 'Battery'), `${kwh(row.batteryKwh)} kWh`],
      ...(unmeasured > 0.0005 ? [[t('Källa ej uppmätt', 'Source not measured'), `${kwh(unmeasured)} kWh`] as [string, string]] : []),
      [t('Totalt', 'Total'), `${kwh(row.totalKwh)} kWh`],
      [t('Kostnad', 'Cost'), `${sek(row.costSek)} ${currency}`],
      ...(row.gridKwh > 0.0005 && row.costSek > 0
        ? [[t('Snittpris nät', 'Average grid price'), `${(row.costSek / row.gridKwh).toFixed(2)} ${currency}/kWh`] as [string, string]]
        : []),
    ];
    return (
      <div className="min-w-48">
        <p className="mb-1 font-medium">{row.name}</p>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
          {lines.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right tabular-nums">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
        {!row.fullyPriced && (
          <p className="mt-1 max-w-56 text-muted-foreground">
            {t('Pris saknas för en del kvartar; kostnaden gäller bara de prissatta.', 'Some quarters have no price; the cost covers only the priced ones.')}
          </p>
        )}
      </div>
    );
  };

  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t('Förklaring', 'Legend')}>
        {legend.map(entry => (
          <li key={entry.key} className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: entry.background }} />
            {entry.label}
          </li>
        ))}
      </ul>

      <div className="hidden grid-cols-[minmax(8rem,14rem)_minmax(0,3fr)_minmax(0,2fr)] gap-x-6 border-b pb-1 text-xs text-muted-foreground sm:grid">
        <span>{t('Enhet', 'Device')}</span>
        <span>{t('Energi · kWh', 'Energy · kWh')}</span>
        <span>{t(`Kostnad · ${currency}`, `Cost · ${currency}`)}</span>
      </div>

      <ul>
        {result.rows.map(row => (
          <Tooltip key={row.key} delayDuration={100}>
            <TooltipTrigger asChild>
              <li
                tabIndex={0}
                className="grid grid-cols-1 gap-x-6 gap-y-1 rounded-sm px-0 py-2 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(8rem,14rem)_minmax(0,3fr)_minmax(0,2fr)] sm:items-center"
              >
                <span className={`truncate text-sm ${row.kind === 'device' ? 'font-medium' : 'text-muted-foreground'}`}>
                  {row.name}
                </span>
                <span className="flex items-center gap-2">
                  <span className="relative h-3 flex-1">
                    <span
                      className="absolute inset-y-0 left-0 flex gap-[2px] overflow-hidden rounded-r"
                      style={{ width: percent(row.totalKwh, maxKwh), minWidth: row.totalKwh > 0 ? 2 : 0 }}
                    >
                      {segments(row).map(segment => (
                        <span
                          key={segment.key}
                          className="h-full shrink-0"
                          style={{ background: segment.background, flexGrow: segment.kwh, flexBasis: 0, minWidth: 1 }}
                        />
                      ))}
                    </span>
                  </span>
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-foreground">
                    {kwh(row.totalKwh)}<span className="text-muted-foreground sm:hidden"> kWh</span>
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="relative h-3 flex-1">
                    <span
                      className="absolute inset-y-0 left-0 rounded-r"
                      style={{ background: COST, width: percent(row.costSek, maxCost), minWidth: row.costSek > 0 ? 2 : 0 }}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-foreground">
                    {row.fullyPriced ? '' : '≥ '}{sek(row.costSek)}<span className="text-muted-foreground sm:hidden"> {currency}</span>
                  </span>
                </span>
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
        {' · '}<span className="font-medium text-foreground">{sek(totals.costSek)} {currency}</span>
      </p>
    </div>
  );
};

export default DeviceEnergyChart;
