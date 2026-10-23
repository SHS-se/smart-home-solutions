import BoilerSlotDetail from '../BoilerSlotDetail';
// One continuous chart: measured history to the left of now, plan to the right.
//
// History and the plan were separate tabs with separate windows, so "today"
// existed in neither. They are the same quantities on the same grid; the only
// difference is which side of now they fall on.
//
// The chart itself is five panels sharing one time axis (EnergyChart). It
// replaced a single plot that carried kilowatts, per cent and SEK/kWh against
// three y-axes, with nineteen device meters stacked underneath in a palette of
// eight cycled colours. Both problems were structural rather than cosmetic:
// nothing said which axis a curve belonged to, and no band in that stack could
// be looked up.
//
// Under the chart is the plan's score: the points its rules gave and took in
// each planned quarter, as the planner itself counted them when it chose this
// schedule (`rule_points`), and why the picked quarter scored what it did. The
// planner bench shows the same section for the plans it compares. Measured
// history has no score, and neither has a plan from a planner without rules;
// the section then holds only its last part, the replay download.

import React, { useMemo, useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { attributeEnergy, supplySlotsFromTimeline } from '@/lib/energy-shift/energy-attribution';
import {
  nowDividerIndex,
  type DayWindow,
  type TimelineRange,
  type TimelineRow,
} from '@/lib/energy-shift/energy-timeline';
import { projectPlanChart, type ChartHotWater } from '@/lib/energy-shift/plan-chart-data';
import { hotWaterQuarter } from '@/lib/energy-shift/hot-water-gate';
import { DayWindowToggle } from '../ui';
import type { PlanModel } from '../usePlanModel';
import DeviceEnergyChart from '../DeviceEnergyChart';
import DeviceEnergyTable, { DeviceEnergyNotes } from '../DeviceEnergyTable';
import { Button } from '@/components/ui/button';
import PlanReplayDownload from '../PlanReplayDownload';
import { replayDescription } from '@/lib/energy-shift/plan-replay';
import EnergyChart, { type EnergyRoomLine } from '../../charts/EnergyChart';
import { planChartRelations } from '@/lib/energy-shift/plan-chart-relations';
import type { ChartRoom } from '@/lib/energy-shift/room-temperature';
import QuarterScoreDetail, { type QuarterScoreExplanation } from '../QuarterScoreDetail';
import { DEFAULT_RULES } from '@/lib/planner-bench/score';
import { PLAN_COLOURS } from '../../charts/palette';
import { ownerColour, type EmpiricalEnergyDevice } from '@/lib/energy-shift/device-colours';
import { poolHeaters } from '../../../../../../supabase/functions/_shared/planner/pool-devices';
import { useHomeTimeZone } from '../../HomeTimeZoneContext';

const RULE_LABEL = new Map(DEFAULT_RULES.map(rule => [rule.key, rule.label]));
const total = (points: Record<string, number>) => Object.values(points).reduce((a, b) => a + b, 0);

const PowerSection: React.FC<{
  model: PlanModel;
  rows: TimelineRow[];
  range: TimelineRange;
  dayWindow: DayWindow;
  dayWindowOptions: DayWindow[];
  onDayWindowChange: (value: DayWindow) => void;
  devices: readonly EmpiricalEnergyDevice[];
  /** Meters the plan is allowed to move. Only these earn a band of their own. */
  schedulableKeys: ReadonlySet<string>;
  hasBattery: boolean;
  hasEvBattery: boolean;
  /** The owner's pool target, when the plan was made from one. */
  poolTargetC?: number | null;
  /** Rooms the plan drives, drawn in the room temperature panel. */
  rooms?: readonly ChartRoom[];
}> = ({
  model,
  rows,
  range,
  dayWindow,
  dayWindowOptions,
  onDayWindowChange,
  devices,
  schedulableKeys,
  hasBattery,
  hasEvBattery,
  poolTargetC = null,
  rooms = [],
}) => {
  const { t } = useLanguage();
  const homeTimeZone = useHomeTimeZone();
  const [selectedQuarterStart, setSelectedQuarterStart] = useState<string | null>(null);
  const view = useMemo(() => rows.slice(range.from, range.to), [range.from, range.to, rows]);

  const { plan } = model;
  const deviceNameByKey = useMemo(() => new Map(devices.map(device => [device.device_key, device.name])), [devices]);
  const colours = useMemo(() => ({
    pool: ownerColour(devices, poolHeaters(plan.device_models).map(device => device.key), PLAN_COLOURS.pool),
    ev: ownerColour(devices, plan.device_models.filter(device => device.category === 'ev_charging').map(device => device.key), PLAN_COLOURS.ev),
    water: ownerColour(devices, plan.device_models.filter(device => device.category === 'hot_water' && device.control_type === 'permit_inhibit').map(device => device.key), PLAN_COLOURS.water),
  }), [devices, plan.device_models]);
  const hotWater = useMemo((): ChartHotWater | undefined => {
    if (!plan.capabilities.boiler) return undefined;
    const keys = plan.device_models.filter(device => device.category === 'hot_water' && device.control_type === 'permit_inhibit').map(device => device.key);
    return {
      name: t('Varmvattenberedare', 'Water boiler'), colour: colours.water, keys,
      byStart: new Map(model.active.slots.map(slot => [Date.parse(slot.start), hotWaterQuarter(slot, keys)])),
    };
  }, [model.active.slots, plan.capabilities.boiler, plan.device_models, colours.water, t]);

  const chart = useMemo(() => projectPlanChart({ rows, range, timeZone: homeTimeZone, prices: { kind: 'live' },
    devices: devices.map(device => ({
      key: device.device_key, name: device.name, colour: device.colour, schedulable: schedulableKeys.has(device.device_key),
    })),
    hotWater,
  }), [rows, range, homeTimeZone, devices, schedulableKeys, hotWater]);
  const { rows: panelRows, consumption } = chart;
  // A room is drawn in its heater's band colour, so the line and the energy
  // that moved it read as one thing.
  const roomLines = useMemo((): EnergyRoomLine[] => rooms.map(room => ({
    key: room.key, name: room.name, colour: ownerColour(devices, room.deviceKeys, PLAN_COLOURS.room),
  })), [rooms, devices]);

  const divider = nowDividerIndex(rows, range);
  const plannedStarts = useMemo(
    () => new Set(model.active.slots.map(slot => Date.parse(slot.start))),
    [model.active.slots],
  );
  const selectedIndex = selectedQuarterStart === null
    ? -1
    : view.findIndex(row => Date.parse(row.start) === Date.parse(selectedQuarterStart));

  const rulePoints = useMemo(() => new Map(model.active.slots.flatMap(slot =>
    slot.rule_points ? [[Date.parse(slot.start), slot.rule_points] as const] : [])), [model.active.slots]);
  const scored = (index: number) => view[index] && !view[index].measured ? rulePoints.get(view[index].startMs) : undefined;
  const quarterScores = rulePoints.size ? view.map((_, index) => {
    const fired = scored(index);
    return fired ? total(fired) : null;
  }) : undefined;
  const explained = ((): QuarterScoreExplanation | null => {
    const fired = scored(selectedIndex), row = panelRows[selectedIndex];
    if (!fired || !row) return null;
    return {
      score: total(fired), when: row.label, price: row.importPriceSekPerKwh,
      priceNote: row.importPriceQuoted ? t('publicerat', 'published') : t('uppskattat', 'estimated'),
      lines: Object.entries(fired).map(([key, points]) => ({ key, points, label: RULE_LABEL.get(key) ?? key })),
    };
  })();

  const attribution = useMemo(() => attributeEnergy(supplySlotsFromTimeline(view), new Map(deviceNameByKey), {
    baseLoad: t('Baslast — allt övrigt', 'Base load — everything else'),
    batteryCharging: t('Batteriladdning', 'Battery charging'),
  }), [deviceNameByKey, t, view]);
  const [deviceView, setDeviceView] = useState<'chart' | 'table'>('chart');

  if (view.length === 0) {
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

  const hasHistory = divider > 0;
  const hasPlan = divider < view.length;
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
      <EnergyChart
        rows={panelRows}
        colours={colours}
        series={consumption.series}
        baseValues={consumption.baseValues}
        consumptionIssues={consumption.issues}
        dividerIndex={divider}
        hasBattery={hasBattery}
        hasEvBattery={hasEvBattery}
        poolTargetC={poolTargetC}
        rooms={roomLines}
        relations={planChartRelations({ series: consumption.series, deviceModels: plan.device_models, rooms })}
        quarterScores={quarterScores}
        scoreDetail={(quarterScores || model.active.slots.length > 0) && (
          <QuarterScoreDetail
            id="plan-quarter-explanation" quarter={explained}
            selectedLabel={panelRows[selectedIndex]?.label}
            slotDetail={panelRows[selectedIndex]?.hotWater && <BoilerSlotDetail quarter={panelRows[selectedIndex].hotWater} />}
            empty={quarterScores ? undefined : replayDescription(t)}
            action={<PlanReplayDownload model={model} rows={rows} range={range} selectedStart={selectedQuarterStart} />}
          />
        )}
        selectedIndex={selectedIndex}
        onQuarterClick={index => {
          const row = view[index];
          if (row && plannedStarts.has(Date.parse(row.start))) setSelectedQuarterStart(row.start);
        }}
      />
      {hasHistory && <p className="text-xs text-muted-foreground">{t(
        'Historisk förbrukning visas med denna plans enhetsindelning.',
        'Historical consumption is reclassified using this plan’s device roles.')}</p>}
      {consumption.invalidIndices.length > 0 && <p role="status" className="text-xs text-muted-foreground">{t(
        'Baslasten saknas när mätvärden inte kan stämmas av. Tillgängliga enhetsvärden visas fortfarande; ≥ anger en ofullständig grupp.',
        'Base load is unavailable when readings cannot be reconciled. Available device readings remain visible; ≥ marks an incomplete group.')}</p>}
      <div className="mt-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">
              {t('Förbrukning per enhet', 'Consumption by device')}
            </h3>
            <p className="mb-2 text-xs text-muted-foreground">
              {t('Största förbrukaren först, för den valda perioden.', 'Largest consumer first, for the selected period.')}
            </p>
          </div>
          <div className="flex gap-1" role="group" aria-label={t('Visa som', 'Show as')}>
            {([['chart', t('Diagram', 'Chart')], ['table', t('Tabell', 'Table')]] as const).map(([key, label]) => (
              <Button key={key} size="sm" variant={deviceView === key ? 'secondary' : 'ghost'}
                aria-pressed={deviceView === key} onClick={() => setDeviceView(key)}>{label}</Button>
            ))}
          </div>
        </div>
        {deviceView === 'chart' ? <DeviceEnergyChart devices={devices} result={attribution} /> : <DeviceEnergyTable devices={devices} result={attribution} />}
        <DeviceEnergyNotes result={attribution} />
      </div>
    </>
  );
};

export default PowerSection;
