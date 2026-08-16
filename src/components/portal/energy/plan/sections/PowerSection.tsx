// One continuous chart: measured history to the left of now, plan to the right.
//
// History and the plan were separate tabs with separate windows, so "today"
// existed in neither. They are the same quantities on the same grid; the only
// difference is which side of now they fall on.

import React, { useMemo } from 'react';
import {
  Area, Line, ReferenceArea, ReferenceLine,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  attributeEnergy,
  type SupplySlotInput,
} from '@/lib/energy-shift/energy-attribution';
import {
  activeDeviceKeys,
  nowDividerIndex,
  type DayWindow,
  type TimelineRange,
  type TimelineRow,
} from '@/lib/energy-shift/energy-timeline';
import { COLORS, DEVICE_COLORS } from '../types';
import { DayWindowToggle, SeriesToggleLegend, useSeriesVisibility } from '../ui';
import type { PlanModel } from '../usePlanModel';
import DeviceEnergyTable from '../DeviceEnergyTable';
import EnergyPowerChart from '../EnergyPowerChart';

const QUARTER_W_TO_KWH = 4_000;

/**
 * Grid and battery flows are what the plan gets checked against, so they are
 * drawn heavier than any device series. Eighteen device colours will always
 * out-number them; weight is the only thing that keeps them legible.
 */
const FLOW_STROKE_WIDTH = 2.5;

type SeriesKey =
  | 'solar' | 'base' | 'gridImport' | 'gridExport' | 'batteryCharge'
  | 'homeSoc' | 'evSoc' | `device:${string}`;

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
  const { deviceRoleView } = model;

  const scheduled = useMemo(() => activeDeviceKeys(rows, range), [range, rows]);
  const deviceKeys = useMemo(
    () => [...scheduled].sort((left, right) =>
      (deviceNameByKey.get(left) ?? left).localeCompare(deviceNameByKey.get(right) ?? right)),
    [deviceNameByKey, scheduled],
  );

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
    homeSoc: row.batterySoc === null ? null : row.batterySoc * 100,
    evSoc: row.evSoc === null ? null : row.evSoc * 100,
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
  const divider = nowDividerIndex(rows, range);
  const hasHistory = divider > 0;
  const hasPlan = divider < windowed.length;

  const deviceSeries = useMemo(
    () => deviceKeys.map((key, index) => ({
      key: `device:${key}` as SeriesKey,
      dataKey: `device${index}`,
      label: deviceNameByKey.get(key) ?? key,
      color: DEVICE_COLORS[index % DEVICE_COLORS.length],
    })),
    [deviceKeys, deviceNameByKey],
  );
  const legendSeries = useMemo(() => [
    { key: 'solar' as SeriesKey, label: t('Solproduktion', 'Solar production'), color: COLORS.pv },
    { key: 'base' as SeriesKey, label: t('Baslast', 'Base load'), color: COLORS.base },
    ...deviceSeries,
    { key: 'gridImport' as SeriesKey, label: t('Nätimport', 'Grid import'), color: COLORS.import },
    { key: 'gridExport' as SeriesKey, label: t('Nätexport (negativ)', 'Grid export (negative)'), color: COLORS.export },
    { key: 'batteryCharge' as SeriesKey, label: t('Batteriladdning (negativ)', 'Battery charge (negative)'), color: COLORS.batteryCharge },
    ...(hasBattery ? [{ key: 'homeSoc' as SeriesKey, label: t('Hembatteri SOC', 'Home battery SOC'), color: COLORS.soc }] : []),
    ...(hasEvBattery ? [{ key: 'evSoc' as SeriesKey, label: t('Bilbatteri SOC', 'EV battery SOC'), color: COLORS.ev }] : []),
  ], [deviceSeries, hasBattery, hasEvBattery, t]);

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
        <DayWindowToggle value={dayWindow} options={dayWindowOptions} onChange={onDayWindowChange} />
      </div>
      <EnergyPowerChart data={windowed} ticks={ticks} showPercentAxis={hasBattery || hasEvBattery}>
        {/* Everything right of the divider is forecast rather than measured. */}
        {hasPlan && hasHistory && (
          <ReferenceArea yAxisId="power" x1={divider} x2={windowed.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.16} />
        )}
        {visibility.visible('solar') && <Area yAxisId="power" type="monotone" dataKey="solar" name={t('Solproduktion', 'Solar production')} stroke={COLORS.pv} fill={COLORS.pv} fillOpacity={0.14} dot={false} connectNulls />}
        {visibility.visible('base') && <Area yAxisId="power" type="stepAfter" dataKey="base" stackId="load" name={t('Baslast', 'Base load')} fill={COLORS.base} strokeWidth={0} />}
        {deviceSeries.map(series => visibility.visible(series.key) && (
          <Area key={series.key} yAxisId="power" type="stepAfter" dataKey={series.dataKey} stackId="load" name={series.label} fill={series.color} stroke={series.color} fillOpacity={0.65} strokeWidth={1} />
        ))}
        {visibility.visible('gridImport') && <Line yAxisId="power" type="stepAfter" dataKey="gridImport" name={t('Nätimport', 'Grid import')} stroke={COLORS.import} strokeWidth={FLOW_STROKE_WIDTH} dot={false} connectNulls />}
        {visibility.visible('gridExport') && <Line yAxisId="power" type="stepAfter" dataKey="gridExport" name={t('Nätexport (negativ)', 'Grid export (negative)')} stroke={COLORS.export} strokeWidth={FLOW_STROKE_WIDTH} dot={false} connectNulls />}
        {visibility.visible('batteryCharge') && <Line yAxisId="power" type="stepAfter" dataKey="batteryCharge" name={t('Batteriladdning (negativ)', 'Battery charge (negative)')} stroke={COLORS.batteryCharge} strokeWidth={FLOW_STROKE_WIDTH} dot={false} connectNulls />}
        {/* SOC is a percentage, so it rides the right-hand axis. It exists
            only on the planned side; history carries no state of charge. */}
        {hasBattery && visibility.visible('homeSoc') && <Line yAxisId="soc" type="monotone" dataKey="homeSoc" name={t('Hembatteri SOC', 'Home battery SOC')} stroke={COLORS.soc} strokeWidth={1.5} dot={false} connectNulls={false} />}
        {hasEvBattery && visibility.visible('evSoc') && <Line yAxisId="soc" type="monotone" dataKey="evSoc" name={t('Bilbatteri SOC', 'EV battery SOC')} stroke={COLORS.ev} strokeWidth={1.5} dot={false} connectNulls={false} />}
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
          'Fyllda staplar staplas till husets förbrukning. Nätimport, nätexport och batteriladdning är flöden över husets gräns; export och laddning är negativa. Laddningsnivåer läses av på den högra axeln.',
          'Filled bars stack into what the house consumes. Grid import, grid export and battery charge are flows across the house boundary; export and charging are negative. State of charge reads on the right-hand axis.',
        )}
        {idleDeviceCount > 0 && ` ${t(
          `${idleDeviceCount} enheter är dolda eftersom de aldrig drar effekt i den här perioden.`,
          `${idleDeviceCount} device${idleDeviceCount === 1 ? '' : 's'} ${idleDeviceCount === 1 ? 'is' : 'are'} hidden because ${idleDeviceCount === 1 ? 'it draws' : 'they draw'} no power in this period.`,
        )}`}
        {deviceRoleView.requiresPlanRefresh && ` ${t(
          'Den ändrade enhetsrollen visas direkt; schema- och kostnadsberäkningarna uppdateras vid nästa Home Assistant-plan.',
          'The changed device role is shown immediately; schedule and cost calculations update with the next Home Assistant plan.',
        )}`}
      </p>
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
