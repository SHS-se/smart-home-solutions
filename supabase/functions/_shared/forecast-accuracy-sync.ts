import type { AccuracyReport } from './forecast-accuracy.ts';

export type AccuracyReportDelta =
  | { state: 'missing'; revision: null }
  | { state: 'unchanged'; revision: string }
  | { state: 'changed'; revision: string; report: AccuracyReport };

/** One transient cache belongs to one authenticated home. Never retain a token
 * without its report: a lost cache must fetch the complete report again. */
export class AccuracyReportCache {
  revision: string | null = null;
  private report: AccuracyReport | null = null;

  clear(): null {
    this.revision = null;
    this.report = null;
    return null;
  }

  apply(delta: AccuracyReportDelta): AccuracyReport | null {
    if (delta?.state === 'missing') return this.clear();
    if (delta?.state === 'changed' && delta.revision && delta.report) {
      this.revision = delta.revision;
      this.report = delta.report;
      return this.report;
    }
    if (delta?.state === 'unchanged' && this.report && delta.revision === this.revision) return this.report;
    this.clear();
    throw new Error('Accuracy report response does not match the retained revision');
  }
}

interface AccuracyReader {
  rpc(name: 'read_energy_forecast_accuracy', args: {p_home_id: string; p_known_revision: string | null}):
    PromiseLike<{data: unknown; error: unknown}>;
}

type StatusAccuracyRequest = {kind: 'notification'} | {kind: 'status'; knownRevision: string | null};
export interface AccuracyStatus {
  forecast_accuracy: AccuracyReport | null;
  forecast_accuracy_revision: string | null;
  forecast_accuracy_state: AccuracyReportDelta['state'] | 'unavailable';
  forecast_accuracy_error: string | null;
}

/** Notifications carry no reporting data. Ordinary clients without a revision
 * receive a full report during the reader-first app rollout. Reporting failures
 * stay in these fields and never fail a runtime write or readiness response. */
export async function readAccuracyStatus(db: AccuracyReader, homeId: string, request: StatusAccuracyRequest):
    Promise<AccuracyStatus | Record<string, never>> {
  if (request.kind === 'notification') return {};
  try {
    const {data, error} = await db.rpc('read_energy_forecast_accuracy', {
      p_home_id: homeId, p_known_revision: request.knownRevision,
    });
    if (error) throw error;
    const delta = data as AccuracyReportDelta;
    if (!delta || !['missing', 'unchanged', 'changed'].includes(delta.state)) throw new Error('Invalid accuracy response');
    return {
      forecast_accuracy: delta.state === 'changed' ? delta.report : null,
      forecast_accuracy_revision: delta.revision,
      forecast_accuracy_state: delta.state,
      forecast_accuracy_error: null,
    };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : 'report_read_failed';
    console.error('[FORECAST-ACCURACY] report read failed', {home_id: homeId, code});
    return {forecast_accuracy: null, forecast_accuracy_revision: null,
      forecast_accuracy_state: 'unavailable', forecast_accuracy_error: 'Accuracy unavailable'};
  }
}
