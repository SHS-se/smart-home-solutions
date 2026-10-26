import type { Json } from '@/integrations/supabase/types';

type Translate = (sv: string, en: string) => string;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const object = (value: Json): Record<string, Json | undefined> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function replanAuditReason(value: Json, t: Translate): string {
  const reason = object(value);
  if (Array.isArray(reason.changes)) return reason.changes.map(change => {
    const row = object(change!);
    const cause = row.cause;
    const owner = row.owner === '$ev' ? t('bilen', 'car') : row.owner === '$pool' ? t('poolen', 'pool')
      : row.owner === '$battery' ? t('hembatteriet', 'home battery') : String(row.owner);
    if (cause === 'battery_energy_shortfall' || cause === 'pool_temperature_shortfall') {
      const name = cause === 'battery_energy_shortfall' ? t('Hembatteriet saknar', 'Home battery shortfall:') : t('Poolen är kallare än prognosen med', 'Pool below forecast by');
      const unit = cause === 'battery_energy_shortfall' ? 'kWh' : '°C';
      return `${name} ${row.magnitude} ${unit} (${Number(row.persistence_ms) / 60000} min).`;
    }
    if (cause === 'vehicle_disconnected') return t('Bilen var urkopplad när laddning var planerad.', 'Car was unplugged when charging was scheduled.');
    if (cause === 'required_source_unavailable') return t(`En nödvändig sensor för ${owner} saknades i minst 15 minuter.`, `A required sensor for ${owner} was unavailable for at least 15 minutes.`);
    if (cause === 'execution_recovered') return t(`Tidigare blockerat arbete för ${owner} kan återupptas.`, `Previously blocked work for ${owner} can resume.`);
    // A measured shortfall is not a control error; the device did as asked.
    if (cause === 'observed_state_cannot_meet_target') return t(`Uppmätt nivå för ${owner} kan inte längre nå planens mål i tid.`, `Measured level of ${owner} can no longer reach the planned target in time.`);
    if (cause === 'shortfall_without_recovery_authority') return t(`${capital(owner)} ligger efter planen utan tillåten återhämtning.`, `${capital(owner)} fell behind the plan with no permitted recovery.`);
    return row.status === 'faulted'
      ? t(`Planerat arbete för ${owner} blockerades av ett styrfel (${cause}).`, `Scheduled work for ${owner} was blocked by a control error (${cause}).`)
      : t(`Planerat arbete för ${owner} kunde inte utföras (${cause}).`, `Scheduled work for ${owner} could not execute (${cause}).`);
  }).join(' ');
  const code = String(reason.reason ?? reason.code ?? 'unknown');
  const labels: Record<string, [string, string]> = {
    no_accepted_plan: ['Första planen.', 'First plan.'],
    new_published_prices: ['Nya elpriser.', 'New electricity prices.'],
    manual_replan_button: ['Begärd med portalens knapp.', 'Requested with the portal button.'],
    local_manual_request: ['Begärd med appens knapp.', 'Requested with the app button.'],
    controller_source_selected: ['Styrenhetens källa ändrades.', 'Controller source was changed.'],
    configuration_changed: ['Konfigurationen ändrades.', 'Configuration was changed.'],
    pending_configuration_on_startup: ['En konfigurationsändring väntade vid start.', 'A configuration change was pending at startup.'],
    fixed_schedule_changed: ['Det fasta schemat ändrades.', 'Fixed schedule was changed.'],
    unattributed_database_request: ['Databasbegäran utan uppgift om initiativtagare.', 'Database request with no recorded initiator.'],
    request_predates_audit: ['Begäran gjordes innan historiken infördes.', 'Request predates the audit history.'],
    job_predates_audit: ['Planeringen startade innan historiken infördes.', 'Planning started before audit history was introduced.'],
  };
  return labels[code] ? t(...labels[code]) : code;
}

export function replanAuditState(state: string, t: Translate, completionBasis?: string): string {
  if (state === 'published' && completionBasis === 'publication') return t('Publicerad', 'Published');
  const labels: Record<string, [string, string]> = {
    requested: ['Begärd', 'Requested'], admitted: ['Köad', 'Queued'], solving: ['Beräknas', 'Calculating'],
    published: ['Publicerad – inväntar hemmets bekräftelse', 'Published – awaiting home acceptance'],
    accepted: ['Accepterad av hemmet', 'Accepted by home'], rejected: ['Avvisad av hemmet', 'Rejected by home'],
    failed: ['Misslyckades', 'Failed'], request_failed: ['Begäran misslyckades', 'Request failed'], superseded: ['Ersatt', 'Superseded'],
  };
  return labels[state] ? t(...labels[state]) : state;
}
