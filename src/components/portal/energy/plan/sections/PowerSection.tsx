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
  | 'solar' | 'base' | 'totalLoad' | 'gridImport' | 'gridExport'
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
  const { deviceRoleView } = model;

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
    totalLoad: row.loadW,
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
    row.totalLoad,
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
    return sharedZeroAxes({
      priceMin: prices.length > 0 ? Math.min(...prices) : 0,
      priceMax: prices.length > 0 ? Math.max(...prices) : 0,
      powerMinW: rawPowerDomain[0],
      powerMaxW: rawPowerDomain[1],
    });
  }, [rawPowerDomain, showPrices, windowed]);
  const powerDomain = priceAxes?.power.domain ?? rawPowerDomain;
  const socDomain = useMemo(() => socAxisDomain(powerDomain), [powerDomain]);

  const divider = nowDividerIndex(rows, range);
  const hasHistory = divider > 0;
  const hasPlan = divider < windowed.length;
  const firstModelled = windowed.findIndex(row => row.modelledImportPrice !== null);

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
    { key: 'allInImportPrice' as const, label: t('Totalt köppris', 'All-in import price'), color: COLORS.import, modelled: false },
    { key: 'allInExportPrice' as const, label: t('Totalt säljpris', 'All-in export price'), color: COLORS.export, modelled: false },
    { key: 'modelledImportPrice' as const, label: t('Totalt köppris (modellerat)', 'All-in import price (modelled)'), color: COLORS.import, modelled: true },
    { key: 'modelledExportPrice' as const, label: t('Totalt säljpris (modellerat)', 'All-in export price (modelled)'), color: COLORS.export, modelled: true },
  ], [t]);
  const legendSeries = useMemo(() => [
    { key: 'solar' as SeriesKey, label: t('Solproduktion', 'Solar production'), color: COLORS.pv },
    // Same order as the stack, bottom to top, so the two agree.
    ...deviceSeries,
    { key: 'base' as SeriesKey, label: t('Baslast', 'Base load'), color: COLORS.base },
    { key: 'totalLoad' as SeriesKey, label: t('Total förbrukning', 'Total consumption'), color: COLORS.base },
    { key: 'gridImport' as SeriesKey, label: t('Nätimport', 'Grid import'), color: COLORS.import },
    { key: 'gridExport' as SeriesKey, label: t('Nätexport (negativ)', 'Grid export (negative)'), color: COLORS.export },
    { key: 'batteryCharge' as SeriesKey, label: t('Batteriladdning (negativ)', 'Battery charge (negative)'), color: COLORS.batteryCharge },
    { key: 'batteryDischarge' as SeriesKey, label: t('Batteriurladdning', 'Battery discharge'), color: COLORS.batteryDischarge },
    ...(hasBattery ? [{ key: 'homeSoc' as SeriesKey, label: t('Hembatteri SOC', 'Home battery SOC'), color: COLORS.soc }] : []),
    ...(hasEvBattery ? [{ key: 'evSoc' as SeriesKey, label: t('Bilbatteri SOC', 'EV battery SOC'), color: COLORS.ev }] : []),
    ...(showPrices ? priceSeries : []),
  ], [deviceSeries, hasBattery, hasEvBattery, priceSeries, showPrices, t]);

  const idleDeviceCount = Math.max(0, deviceNameByKey.size - deviceKeys.length);

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
        showPercentAxis={hasBattery || hasEvBattery}
        priceAxis={priceAxes?.price}
        powerDomain={powerDomain}
        socDomain={socDomain}
      >
        {/* Everything right of the divider is forecast rather than measured. */}
        {hasPlan && hasHistory && (
          <ReferenceArea yAxisId="power" x1={divider} x2={windowed.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.16} />
        )}
        {visibility.visible('solar') && <Area yAxisId="power" type="monotone" dataKey="solar" name={t('Solproduktion', 'Solar production')} stroke={COLORS.pv} fill={COLORS.pv} fillOpacity={0.14} dot={false} connectNulls />}
        {deviceSeries.map(series => visibility.visible(series.key) && (
          <Area key={series.key} yAxisId="power" type="stepAfter" dataKey={series.dataKey} stackId="load" name={series.label} fill={series.color} stroke={series.color} fillOpacity={0.65} strokeWidth={1} />
        ))}
        {visibility.visible('base') && <Area yAxisId="power" type="stepAfter" dataKey="base" stackId="load" name={t('Baslast', 'Base load')} fill={COLORS.base} strokeWidth={0} />}
        {visibility.visible('totalLoad') && <Line yAxisId="power" type="stepAfter" dataKey="totalLoad" name={t('Total förbrukning', 'Total consumption')} stroke={COLORS.base} strokeWidth={1.8} dot={false} connectNulls={false} />}
        {visibility.visible('gridImport') && <Line yAxisId="power" type="stepAfter" dataKey="gridImport" name={t('Nätimport', 'Grid import')} stroke={COLORS.import} strokeWidth={FLOW_STROKE_WIDTH} dot={false} connectNulls />}
        {visibility.visible('gridExport') && <Line yAxisId="power" type="stepAfter" dataKey="gridExport" name={t('Nätexport (negativ)', 'Grid export (negative)')} stroke={COLORS.export} strokeWidth={FLOW_STROKE_WIDTH} dot={false} connectNulls />}
        {visibility.visible('batteryCharge') && <Line yAxisId="power" type="stepAfter" dataKey="batteryCharge" name={t('Batteriladdning (negativ)', 'Battery charge (negative)')} stroke={COLORS.batteryCharge} strokeWidth={FLOW_STROKE_WIDTH} dot={false} connectNulls />}
        {visibility.visible('batteryDischarge') && <Line yAxisId="power" type="stepAfter" dataKey="batteryDischarge" name={t('Batteriurladdning', 'Battery discharge')} stroke={COLORS.batteryDischarge} strokeWidth={FLOW_STROKE_WIDTH} dot={false} connectNulls />}
        {/* SOC is a percentage, so it rides the right-hand axis. It exists
            only on the planned side; history carries no state of charge. */}
        {hasBattery && visibility.visible('homeSoc') && <Line yAxisId="soc" type="monotone" dataKey="homeSoc" name={t('Hembatteri SOC', 'Home battery SOC')} stroke={COLORS.soc} strokeWidth={1.5} dot={false} connectNulls={false} />}
        {hasEvBattery && visibility.visible('evSoc') && <Line yAxisId="soc" type="monotone" dataKey="evSoc" name={t('Bilbatteri SOC', 'EV battery SOC')} stroke={COLORS.ev} strokeWidth={1.5} dot={false} connectNulls={false} />}
        {showPrices && priceSeries.map(series => visibility.visible(series.key) && (
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
      <p className="mt-2 text-xs text-muted-foreground">
        {hasHistory && hasPlan
          ? t('Till vänster om linjen är uppmätt, till höger planerat.', 'Left of the line is measured; right of it is planned.')
          : hasHistory
            ? t('Hela dagen är uppmätt.', 'The whole day is measured.')
            : t('Hela dagen är planerad.', 'The whole day is planned.')}
        {' '}
        {t(
          'Fyllda staplar visar förbrukningens delar och den grå linjen visar deras exakta total. Nätimport, nätexport, batteriladdning och batteriurladdning är flöden över husets gräns; export och laddning är negativa. Laddningsnivåer läses av på den högra axeln.',
          'Filled bars show the parts of consumption and the grey line shows their exact total. Grid import, grid export, battery charging and battery discharge are flows across the home boundary; export and charging are negative. State of charge reads on the right-hand axis.',
        )}
        {showPrices && ` ${t(
          'Köppriset är hela den rörliga kostnaden per kWh som planen kan påverka: leverantörens spotpris och påslag, nätöverföring, energiskatt och moms. Fasta månadsavgifter ingår inte eftersom tidpunkten inte ändrar dem. Säljpriset är leverantörsersättning plus nätnytta utan moms. Heldraget är uppmätt eller publicerat; streckat är planerarens modell efter den publicerade prisperioden.',
          'The import price contains every variable per-kWh cost the plan can affect: supplier spot price and terms, grid transfer, energy tax and VAT. Fixed monthly charges are excluded because timing cannot change them. The export price is supplier payment plus grid compensation, without VAT. Solid lines are measured or published; dashed lines are the planner’s model beyond the published price period.',
        )}`}
        {idleDeviceCount > 0 && ` ${t(
          `${idleDeviceCount} enheter är dolda eftersom de aldrig drar effekt i den här perioden.`,
          `${idleDeviceCount} device${idleDeviceCount === 1 ? '' : 's'} ${idleDeviceCount === 1 ? 'is' : 'are'} hidden because ${idleDeviceCount === 1 ? 'it draws' : 'they draw'} no power in this period.`,
        )}`}
        {deviceRoleView.requiresPlanRefresh && ` ${t(
          'Den ändrade enhetsrollen visas direkt; schema- och kostnadsberäkningarna uppdateras vid nästa Home Assistant-plan.',
          'The changed device role is shown immediately; schedule and cost calculations update with the next Home Assistant plan.',
        )}`}
      </p>
      {/*
        Above the per-device table on purpose. The device table says how much
        each thing used; this says why the plan chose that at all, and a reader
        working down the page wants the reason before the arithmetic.
      */}
      <div className="mt-6 border-t pt-6">
        <StoreDecisions model={model} rows={rows} range={range} />
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
