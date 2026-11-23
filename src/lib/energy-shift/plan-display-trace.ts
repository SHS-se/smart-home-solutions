import type { ConsumptionSeries } from './consumption-series';
import type { PortalOptimisationPlan } from './contracts';
import { SLOT_MS, type DayWindow } from './energy-timeline';
import type { HaRuntimeRow } from './ha-runtime';
import type { PlanPanelRow } from './plan-chart-data';
import type { ReplanRow } from './replan-request';
import { hasDeviceInstruction } from './plan-device-instruction';

type TraceRow = ReplanRow & HaRuntimeRow & {
  generation_request_id: string | null;
  ha_ack_status: 'pending' | 'accepted' | 'rejected';
  ha_acknowledged_at: string | null;
};

export function planTraceIdentity(row: TraceRow | null, reported: HaRuntimeRow | null = row) {
  return {
    plan_id: row?.plan_id ?? null,
    generation_request_id: row?.generation_request_id ?? null,
    replan_request_id: row?.replan_request_id ?? null,
    completed_replan_request_id: row?.replan_completed_request_id ?? null,
    replan_failed: Boolean(row?.replan_error),
    ha_ack_status: row?.ha_ack_status ?? null,
    ha_acknowledged_at: row?.ha_acknowledged_at ?? null,
    ha_reported_plan_id: reported?.ha_runtime?.plan_id ?? null,
    ha_reported_state: reported?.ha_runtime?.state ?? null,
    ha_recovering: reported?.ha_runtime?.recovering ?? false,
  };
}

type PowerSource = 'measured' | 'estimated_meter' | 'scheduled' | 'advisory' | 'forecast_without_command';
type PowerSummary = Partial<Record<PowerSource, { quarters: number; chart_kwh: number; peak_w: number }>>;

export function describePlanChart({
  plan, rows, series, baseValues, dayWindow, timeZone, poolHeaterKeys, hotWaterKey,
}: {
  plan: PortalOptimisationPlan;
  rows: readonly PlanPanelRow[];
  series: readonly ConsumptionSeries[];
  baseValues: readonly number[];
  dayWindow: DayWindow;
  timeZone: string;
  poolHeaterKeys: ReadonlySet<string>;
  hotWaterKey?: string;
}) {
  const slots = new Map(plan.plans.priority.slots.map(slot => [Date.parse(slot.start), slot]));
  const visibleSlots = rows.map(row => row.measured || row.missing ? undefined : slots.get(row.startMs));
  const first = rows[0];
  const last = rows.at(-1);
  const ev = rows.filter(row => !row.missing && row.evSoc !== null);
  const lastEv = ev.at(-1);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const driving = ev.reduce((gap, row) =>
    Math.max(gap, (row.evSocFromCharging ?? row.evSoc!) - row.evSoc!), 0);

  const power = [{ key: '$base_load', values: baseValues }, ...series].map(({ key, values }) => {
    const owner = plan.operating_scope?.device_owners[key];
    const bySource: PowerSummary = {};
    for (const [index, value] of values.entries()) {
      const row = rows[index];
      if (row.missing || !Number.isFinite(value) || value <= 0) continue;
      const slot = visibleSlots[index];
      const hasCommand = hasDeviceInstruction(slot, key, poolHeaterKeys)
        || (key === hotWaterKey && row.hotWater && row.hotWater.state !== 'uncontrolled');
      const source: PowerSource = row.measured ? (row.estimatedEnergy ? 'estimated_meter' : 'measured')
        : hasCommand ? (slot?.binding ? 'scheduled' : 'advisory') : 'forecast_without_command';
      const totals = bySource[source] ??= { quarters: 0, chart_kwh: 0, peak_w: 0 };
      totals.quarters++;
      totals.chart_kwh += value / 4000;
      totals.peak_w = Math.max(totals.peak_w, value);
    }
    for (const totals of Object.values(bySource)) {
      totals.chart_kwh = round(totals.chart_kwh);
      totals.peak_w = round(totals.peak_w);
    }
    return { device_key: key, operating_mode: owner ? plan.operating_scope?.modes[owner] ?? null : null, power_by_source: bySource };
  });
  const backgroundForecasts = plan.device_models.flatMap(model => {
    const values = visibleSlots.flatMap(slot => {
      const value = slot?.device_loads_w?.[model.key];
      return !hasDeviceInstruction(slot, model.key, poolHeaterKeys) &&
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? [value] : [];
    });
    return values.length ? [{ device_key: model.key, quarters: values.length,
      chart_kwh: round(values.reduce((sum, value) => sum + value / 4000, 0)), peak_w: round(Math.max(...values)) }] : [];
  });

  return {
    window: dayWindow,
    time_zone: timeZone,
    from: first ? new Date(first.startMs).toISOString() : null,
    until: last ? new Date(last.startMs + SLOT_MS).toISOString() : null,
    measured_quarters: rows.filter(row => !row.missing && row.measured).length,
    missing_quarters: rows.filter(row => row.missing).length,
    binding_quarters: visibleSlots.filter(slot => slot?.binding).length,
    advisory_quarters: visibleSlots.filter(slot => slot && !slot.binding).length,
    ev_soc: lastEv ? {
      last_at: new Date(lastEv.startMs).toISOString(),
      last_percent: round(lastEv.evSoc!),
      last_charge_only_percent: lastEv.evSocFromCharging === undefined ? null : round(lastEv.evSocFromCharging),
      includes_estimated_driving: driving > 0,
      max_driving_difference_points: round(driving),
    } : null,
    power,
    background_forecasts: backgroundForecasts,
  };
}

type Identity = ReturnType<typeof planTraceIdentity>;
type Event =
  | { event: 'replan_clicked'; displayed_plan_id: string | null }
  | { event: 'replan_response'; replan_request_id: string | null; queued: boolean }
  | { event: 'replan_completed'; replan_request_id: string; displayed_plan_id: string | null }
  | ({ event: 'portal_response'; includes_plan_payload: boolean } & Identity)
  | { event: 'refresh_failed'; stage: 'read' | 'unsupported_plan'; displayed_plan_id: string | null }
  | ({ event: 'chart_rendered'; issued_at: string; chart: ReturnType<typeof describePlanChart> } & Identity);

const TRACE_LIMIT = 100;

/** One workspace's in-memory trace. The user exports it directly from the page. */
export class PlanDisplayTrace {
  private readonly events: (Event & { at: string; read_ms?: number })[] = [];
  private readonly lastState = new Map<string, string>();
  private droppedEvents = 0;

  record(event: Event, readMs?: number) {
    if (event.event === 'portal_response' || event.event === 'chart_rendered' || event.event === 'refresh_failed') {
      const signature = JSON.stringify(event);
      if (this.lastState.get(event.event) === signature) return;
      this.lastState.set(event.event, signature);
    }
    this.events.push({ ...event, at: new Date().toISOString(), ...(readMs === undefined ? {} : { read_ms: Math.round(readMs) }) });
    if (this.events.length > TRACE_LIMIT) {
      this.events.shift();
      this.droppedEvents++;
    }
  }

  report() {
    return {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      dropped_events: this.droppedEvents,
      events: [...this.events],
    };
  }
}
