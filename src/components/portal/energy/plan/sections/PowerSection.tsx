// One continuous chart: measured history to the left of now, plan to the right.
//
// History and the plan were separate tabs with separate windows, so "today"
// existed in neither. They are the same quantities on the same grid; the only
// difference is which side of now they fall on.

import React, { useMemo, useState } from 'react';
import {
  Area, Line, ReferenceArea, ReferenceLine,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import {
  attributeEnergy,
  type SupplySlotInput,
} from '@/lib/energy-shift/energy-attribution';
import {
  activeDeviceKeys,
  nowDividerIndex,
  powerAxisDomain,
  SIGNIFICANT_POWER_W,
  socAxisDomain,
  stackOrder,
  type DayWindow,
  type TimelineRange,
  type TimelineRow,
} from '@/lib/energy-shift/energy-timeline';
import { sharedZeroAxes } from '@/lib/energy-shift/chart-axes';
import { COLORS, DEVICE_COLORS } from '../types';
import { DayWindowToggle, SeriesToggleLegend, useSeriesVisibility } from '../ui';
import type { PlanModel } from '../usePlanModel';
import DeviceEnergyTable from '../DeviceEnergyTable';
import StoreDecisions from '../StoreDecisions';
import EnergyPowerChart from '../EnergyPowerChart';

const QUARTER_W_TO_KWH = 4_000;

/**
 * Grid and battery flows are what the plan gets checked against, so they are
 * drawn heavier than any device series. Eighteen device colours will always
 * out-number them; weight is the only thing that keeps them legible.
 */
const FLOW_STROKE_WIDTH = 2.5;

type SeriesKey =
  | 'solar' | 'base' | 'gridImport' | 'gridExport'
  | 'batteryCharge' | 'batteryDischarge'
  | 'homeSoc' | 'evSoc'
  | 'allInImportPrice' | 'allInExportPrice'
  | 'modelledImportPrice' | 'modelledExportPrice'
  | `device:${string}`;

const PowerSection: React.FC<{
  model: PlanModel;
  rows: TimelineRow[];
  range: TimelineRange;
  dayWindow: DayWindow;
  dayWindowOptions: DayWindow[];
  onDayWindowChange: (value: DayWindow) => void;
  deviceNameByKey: ReadonlyMap<string, string>;
  hasBattery: boolean;
  hasEvBattery: boolean;
}> = ({
  model,
  rows,
  range,
  dayWindow,
  dayWindowOptions,
  onDayWindowChange,
  deviceNameByKey,
  hasBattery,
  hasEvBattery,
}) => {
  const { t } = useLanguage();
  const visibility = useSeriesVisibility<SeriesKey>();
  const [showPrices, setShowPrices] = useState(false);
  const [selectedQuarterStart, setSelectedQuarterStart] = useState<string | null>(null);
  const [selectionRequest, setSelectionRequest] = useState(0);

  const scheduled = useMemo(() => activeDeviceKeys(rows, range), [range, rows]);
  // Bottom of the stack first. Recharts draws stacked areas in render order,
  // so this list is the drawing order as well as the reading order.
  const deviceKeys = useMemo(() => {
    const view = rows.slice(range.from, range.to);
    return stackOrder([...scheduled].map(key => ({
      key,
      values: view.map(row => row.deviceW[key] ?? 0),
    })));
  }, [range.from, range.to, rows, scheduled]);

  const windowed = useMemo(() => rows.slice(range.from, range.to).map((row, index) => ({
    i: index,
    start: row.start,
    label: new Date(row.start).toLocaleString([], {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }),
    solar: row.solarW,
    base: row.baseW,
    gridImport: row.gridImportW,
    gridExport: row.gridExportW,
    batteryCharge: row.batteryChargeW,
    batteryDischarge: row.batteryDischargeW,
    homeSoc: row.batterySoc === null ? null : row.batterySoc * 100,
    evSoc: row.evSoc === null ? null : row.evSoc * 100,
    allInImportPrice: row.importPriceSekPerKwh,
    allInExportPrice: row.exportPriceSekPerKwh,
    modelledImportPrice: row.shadowImportSekPerKwh,
    modelledExportPrice: row.shadowExportSekPerKwh,
    ...Object.fromEntries(deviceKeys.map((key, keyIndex) => [
      `device${keyIndex}`,
      row.deviceW[key] ?? 0,
    ])),
  })), [deviceKeys, range.from, range.to, rows]);

  const ticks = useMemo(
    () => windowed
      .filter(row => {
        const start = new Date(row.start);
        return start.getMinutes() === 0
          && start.getHours() % (dayWindow === 'all' ? 6 : 3) === 0;
      })
      .map(row => row.i),
    [dayWindow, windowed],
  );
  const rawPowerDomain = useMemo(() => powerAxisDomain(windowed.flatMap(row => [
    row.solar,
    row.gridImport,
    row.gridExport,
    row.batteryCharge,
    row.batteryDischarge,
    // The stack total, not its parts: that is what reaches the top.
    deviceKeys.reduce(
      (total, _key, index) => total + Number(row[`device${index}`] ?? 0),
      row.base ?? 0,
    ),
  ])), [deviceKeys, windowed]);
  const priceAxes = useMemo(() => {
    if (!showPrices) return null;
    const prices = windowed.flatMap(row => [
      row.allInImportPrice,
      row.allInExportPrice,
      row.modelledImportPrice,
      row.modelledExportPrice,
    ]).filter((value): value is number => value !== null && Number.isFinite(value));
    if (prices.length === 0) return null;
    return sharedZeroAxes({
      priceMin: Math.min(...prices),
      priceMax: Math.max(...prices),
      powerMinW: rawPowerDomain[0],
      powerMaxW: rawPowerDomain[1],
    });
  }, [rawPowerDomain, showPrices, windowed]);
  const powerDomain = priceAxes?.power.domain ?? rawPowerDomain;
  const socDomain = useMemo(() => socAxisDomain(powerDomain), [powerDomain]);

  const divider = nowDividerIndex(rows, range);
  const hasHistory = divider > 0;
  const hasPlan = divider < windowed.length;
  const firstModelled = windowed.findIndex(row =>
    row.modelledImportPrice !== null || row.modelledExportPrice !== null);
  const selectedQuarterIndex = selectedQuarterStart === null
    ? -1
    : windowed.findIndex(row => Date.parse(row.start) === Date.parse(selectedQuarterStart));
  const plannedStarts = useMemo(
    () => new Set(model.active.slots.map(slot => Date.parse(slot.start))),
    [model.active.slots],
  );

  const deviceSeries = useMemo(
    () => deviceKeys.map((key, index) => ({
      key: `device:${key}` as SeriesKey,
      dataKey: `device${index}`,
      label: deviceNameByKey.get(key) ?? key,
      color: DEVICE_COLORS[index % DEVICE_COLORS.length],
    })),
    [deviceKeys, deviceNameByKey],
  );
  const priceSeries = useMemo(() => [
    { key: 'allInImportPrice' as const, label: t('Totalt köppris', 'All-in import price'), color: COLORS.importPrice, modelled: false },
    { key: 'allInExportPrice' as const, label: t('Totalt säljpris', 'All-in export price'), color: COLORS.exportPrice, modelled: false },
    { key: 'modelledImportPrice' as const, label: t('Totalt köppris (modellerat)', 'All-in import price (modelled)'), color: COLORS.importPrice, modelled: true },
    { key: 'modelledExportPrice' as const, label: t('Totalt säljpris (modellerat)', 'All-in export price (modelled)'), color: COLORS.exportPrice, modelled: true },
  ], [t]);

  const availableSeries = useMemo(() => {
    const available = new Set<SeriesKey>(deviceSeries.map(series => series.key));
    const powerKeys = [
      'solar',
      'base',
      'gridImport',
      'gridExport',
      'batteryCharge',
      'batteryDischarge',
    ] as const;
    for (const key of powerKeys) {
      if (windowed.some(row => {
        const value = row[key];
        return value !== null && Number.isFinite(value) && Math.abs(value) >= SIGNIFICANT_POWER_W;
      })) available.add(key);
    }
    if (hasBattery && windowed.some(row => row.homeSoc !== null && Number.isFinite(row.homeSoc))) {
      available.add('homeSoc');
    }
    if (hasEvBattery && windowed.some(row => row.evSoc !== null && Number.isFinite(row.evSoc))) {
      available.add('evSoc');
    }
    const priceKeys = [
      'allInImportPrice',
      'allInExportPrice',
      'modelledImportPrice',
      'modelledExportPrice',
    ] as const;
    for (const key of priceKeys) {
      if (windowed.some(row => row[key] !== null && Number.isFinite(row[key]))) available.add(key);
    }
    return available;
  }, [deviceSeries, hasBattery, hasEvBattery, windowed]);

  const legendSeries = useMemo(() => [
    { key: 'solar' as SeriesKey, label: t('Solproduktion', 'Solar production'), color: COLORS.pv },
    // Same order as the stack, bottom to top, so the two agree.
    ...deviceSeries,
    { key: 'base' as SeriesKey, label: t('Baslast', 'Base load'), color: COLORS.base },
    { key: 'gridImport' as SeriesKey, label: t('Nätimport', 'Grid import'), color: COLORS.import },
    { key: 'gridExport' as SeriesKey, label: t('Nätexport (negativ)', 'Grid export (negative)'), color: COLORS.export },
    { key: 'batteryCharge' as SeriesKey, label: t('Batteriladdning (negativ)', 'Battery charge (negative)'), color: COLORS.batteryCharge },
    { key: 'batteryDischarge' as SeriesKey, label: t('Batteriurladdning', 'Battery discharge'), color: COLORS.batteryDischarge },
    ...(hasBattery ? [{ key: 'homeSoc' as SeriesKey, label: t('Hembatteri SOC', 'Home battery SOC'), color: COLORS.soc }] : []),
    ...(hasEvBattery ? [{ key: 'evSoc' as SeriesKey, label: t('Bilbatteri SOC', 'EV battery SOC'), color: COLORS.evSoc }] : []),
    ...(showPrices ? priceSeries : []),
  ].filter(series => availableSeries.has(series.key)), [availableSeries, deviceSeries, hasBattery, hasEvBattery, priceSeries, showPrices, t]);

  const seriesVisible = (key: SeriesKey): boolean =>
    availableSeries.has(key) && visibility.visible(key);

  const attribution = useMemo(() => {
    const slots: SupplySlotInput[] = rows.slice(range.from, range.to).map(row => ({
      start: row.start,
      loadKwh: (row.loadW ?? 0) / QUARTER_W_TO_KWH,
      solarKwh: (row.solarW ?? 0) / QUARTER_W_TO_KWH,
      gridImportKwh: (row.gridImportW ?? 0) / QUARTER_W_TO_KWH,
      gridExportKwh: Math.abs(row.gridExportW ?? 0) / QUARTER_W_TO_KWH,
      batteryChargeKwh: Math.abs(row.batteryChargeW ?? 0) / QUARTER_W_TO_KWH,
      batteryDischargeKwh: 0,
      deviceKwh: Object.fromEntries(
        Object.entries(row.deviceW).map(([key, value]) => [key, value / QUARTER_W_TO_KWH]),
      ),
      importPriceSekPerKwh: null,
      exportPriceSekPerKwh: null,
    }));
    return attributeEnergy(slots, new Map(deviceNameByKey), {
      baseLoad: t('Baslast — allt övrigt', 'Base load — everything else'),
      batteryCharging: t('Batteriladdning', 'Battery charging'),
    });
  }, [deviceNameByKey, range.from, range.to, rows, t]);

  if (windowed.length === 0) {
    return (
      <>
        <div className="mb-2 flex justify-end">
          <DayWindowToggle value={dayWindow} options={dayWindowOptions} onChange={onDayWindowChange} />
        </div>
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t('Ingen data för den valda dagen.', 'No data for the selected day.')}
        </p>
      </>
    );
  }

  const title = !hasPlan
    ? t('Uppmätt förbrukning', 'Historical consumption')
    : !hasHistory
      ? t('Planerad förbrukning', 'Planned consumption')
      : t('Uppmätt och planerad förbrukning', 'Historical and planned consumption');

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant={showPrices ? 'secondary' : 'outline'}
            aria-pressed={showPrices}
            onClick={() => setShowPrices(current => !current)}
          >
            {showPrices ? t('Dölj priser', 'Hide prices') : t('Visa priser', 'Show prices')}
          </Button>
          <DayWindowToggle value={dayWindow} options={dayWindowOptions} onChange={onDayWindowChange} />
        </div>
      </div>
      <EnergyPowerChart
        data={windowed}
        ticks={ticks}
        showPercentAxis={availableSeries.has('homeSoc') || availableSeries.has('evSoc')}
        priceAxis={priceAxes?.price}
        powerDomain={powerDomain}
        socDomain={socDomain}
        onQuarterClick={row => {
          if (plannedStarts.has(Date.parse(row.start))) {
            setSelectedQuarterStart(row.start);
            setSelectionRequest(current => current + 1);
          }
        }}
      >
        {/* Everything right of the divider is forecast rather than measured. */}
        {hasPlan && hasHistory && (
          <ReferenceArea yAxisId="power" x1={divider} x2={windowed.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.16} />
        )}
        {seriesVisible('solar') && <Area yAxisId="power" type="monotone" dataKey="solar" name={t('Solproduktion', 'Solar production')} stroke={COLORS.pv} fill={COLORS.pv} fillOpacity={0.14} dot={false} connectNulls />}
        {deviceSeries.map(series => seriesVisible(series.key) && (
          <Area key={series.key} yAxisId="power" type="stepAfter" dataKey={series.dataKey} stackId="load" name={series.label} fill={series.color} stroke={series.color} fillOpacity={0.65} strokeWidth={1} />
        ))}
        {seriesVisible('base') && <Area yAxisId="power" type="stepAfter" dataKey="base" stackId="load" name={t('Baslast', 'Base load')} fill={COLORS.base} strokeWidth={0} />}
        {seriesVisible('gridImport') && <Line yAxisId="power" type="stepAfter" dataKey="gridImport" name={t('Nätimport', 'Grid import')} stroke={COLORS.import} strokeWidth={FLOW_STROKE_WIDTH} dot={false} connectNulls />}
        {seriesVisible('gridExport') && <Line yAxisId="power" type="stepAfter" dataKey="gridExport" name={t('Nätexport (negativ)', 'Grid export (negative)')} stroke={COLORS.export} strokeWidth={FLOW_STROKE_WIDTH} dot={false} connectNulls />}
        {seriesVisible('batteryCharge') && <Line yAxisId="power" type="stepAfter" dataKey="batteryCharge" name={t('Batteriladdning (negativ)', 'Battery charge (negative)')} stroke={COLORS.batteryCharge} strokeWidth={FLOW_STROKE_WIDTH} dot={false} connectNulls />}
        {seriesVisible('batteryDischarge') && <Line yAxisId="power" type="stepAfter" dataKey="batteryDischarge" name={t('Batteriurladdning', 'Battery discharge')} stroke={COLORS.batteryDischarge} strokeWidth={FLOW_STROKE_WIDTH} dot={false} connectNulls />}
        {/* SOC is a percentage, so it rides the right-hand axis. It exists
            only on the planned side; history carries no state of charge. */}
        {seriesVisible('homeSoc') && <Line yAxisId="soc" type="monotone" dataKey="homeSoc" name={t('Hembatteri SOC', 'Home battery SOC')} stroke={COLORS.soc} strokeWidth={1.5} dot={false} connectNulls={false} />}
        {seriesVisible('evSoc') && <Line yAxisId="soc" type="monotone" dataKey="evSoc" name={t('Bilbatteri SOC', 'EV battery SOC')} stroke={COLORS.evSoc} strokeWidth={1.5} dot={false} connectNulls={false} />}
        {showPrices && priceSeries.map(series => seriesVisible(series.key) && (
          <Line
            key={series.key}
            yAxisId="price"
            type="stepAfter"
            dataKey={series.key}
            name={series.label}
            stroke={series.color}
            strokeWidth={2}
            strokeDasharray={series.modelled ? '5 4' : undefined}
            dot={false}
            connectNulls={false}
          />
        ))}
        {selectedQuarterIndex >= 0 && (
          <ReferenceLine
            yAxisId="power"
            x={selectedQuarterIndex}
            stroke="#0284c7"
            strokeWidth={3}
            strokeOpacity={0.7}
          />
        )}
        <ReferenceLine yAxisId="power" y={0} stroke="currentColor" className="text-muted-foreground" strokeWidth={1} />
        {hasPlan && hasHistory && (
          <ReferenceLine
            yAxisId="power"
            x={divider}
            stroke="currentColor"
            className="text-foreground"
            strokeWidth={1.5}
            label={{ value: t('nu', 'now'), position: 'top', fontSize: 11 }}
          />
        )}
        {showPrices && firstModelled > 0 && (
          <ReferenceLine
            yAxisId="price"
            x={firstModelled}
            stroke="currentColor"
            className="text-muted-foreground"
            strokeDasharray="3 3"
            label={{ value: t('modellerat härifrån', 'modelled from here'), position: 'insideTopRight', fontSize: 10 }}
          />
        )}
      </EnergyPowerChart>
      <SeriesToggleLegend
        series={legendSeries}
        hidden={visibility.hidden}
        onToggle={visibility.toggle}
        ariaLabel={t('Effektserier', 'Power series')}
      />
      {/*
        Above the per-device table on purpose. The device table says how much
        each thing used; this says why the plan chose that at all, and a reader
        working down the page wants the reason before the arithmetic.
      */}
      <div className="mt-6 border-t pt-6">
        <StoreDecisions
          model={model}
          rows={rows}
          range={range}
          selectedStart={selectedQuarterStart}
          selectionRequest={selectionRequest}
          onSelectedStartChange={setSelectedQuarterStart}
        />
      </div>
      <div className="mt-6">
        <h3 className="text-sm font-medium">
          {t('Förbrukning per enhet', 'Consumption by device')}
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          {t('Största förbrukaren först, för den valda perioden.', 'Largest consumer first, for the selected period.')}
        </p>
        <DeviceEnergyTable result={attribution} />
      </div>
    </>
  );
};

export default PowerSection;
