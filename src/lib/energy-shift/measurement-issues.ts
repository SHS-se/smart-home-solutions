import type { MeasurementIssue } from '../../../supabase/functions/_shared/planner/measurement-isolation';

export type { MeasurementIssue };

type Translate = (sv: string, en: string) => string;

const DEVICES: Record<MeasurementIssue['device'], [string, string]> = {
  battery: ['Hembatteriet', 'Home battery'],
  ev: ['Bilen', 'Car'],
  pool: ['Poolen', 'Pool'],
};

/** Readings the planner and Home Assistant name, with the unit each is shown in. */
const FIELDS: Record<string, { sv: string; en: string; format: (value: number) => string }> = {
  soc: { sv: 'laddnivån', en: 'the state of charge', format: (v) => `${Math.round(v * 1000) / 10} %` },
  departure_target_soc: { sv: 'laddgränsen', en: 'the charge limit', format: (v) => `${Math.round(v * 1000) / 10} %` },
  capacity_kwh: { sv: 'den härledda batterikapaciteten', en: 'the derived battery capacity', format: (v) => `${Math.round(v * 10) / 10} kWh` },
  energy_remaining: { sv: 'återstående energi', en: 'the remaining energy', format: (v) => `${Math.round(v * 10) / 10} kWh` },
  water_temperature_c: { sv: 'vattentemperaturen', en: 'the water temperature', format: (v) => `${Math.round(v * 10) / 10} °C` },
  connected: { sv: 'anslutningen', en: 'the cable connection', format: (v) => String(v) },
  min_soc: { sv: 'urladdningsgränsen', en: 'the discharge cut-off', format: (v) => `${Math.round(v * 1000) / 10} %` },
};

/** One sentence per left-out device reading, in the reader's language. */
export function describeMeasurementIssue(issue: MeasurementIssue, t: Translate): string {
  const [svDevice, enDevice] = DEVICES[issue.device] ?? [issue.device, issue.device];
  const field = FIELDS[issue.field];
  if (!field || issue.value === null) return `${t(svDevice, enDevice)}: ${issue.reason}`;
  if (typeof issue.value === 'string') {
    // Home Assistant's own state text, such as "unavailable": no reading at all.
    return t(
      `${svDevice}: ${field.sv} saknar användbart mätvärde ("${issue.value}").`,
      `${enDevice}: ${field.en} has no usable reading ("${issue.value}").`,
    );
  }
  const shown = field.format(issue.value);
  return t(
    `${svDevice}: ${field.sv} visar ${shown}, vilket inte kan stämma.`,
    `${enDevice}: ${field.en} reads ${shown}, which cannot be right.`,
  );
}

/** Issues as the plan published them; plans before v43 carry none. */
export function planMeasurementIssues(plan: { measurement_issues?: MeasurementIssue[] } | null | undefined): MeasurementIssue[] {
  return Array.isArray(plan?.measurement_issues) ? plan.measurement_issues : [];
}
