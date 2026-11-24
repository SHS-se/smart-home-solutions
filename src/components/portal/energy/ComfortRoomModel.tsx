import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { readMeasuredRoomAssessmentPage, MEASURED_ROOM_RUN_PAGE_SIZE, readRoomAssessmentPage, ROOM_RUN_PAGE_SIZE } from '@/lib/energy-shift/room-run-points';
import { readRoomResponseView } from '@/lib/energy-shift/room-response-view';
import { THERMAL_REJECTION_EN, THERMAL_REJECTION_SV } from './plan/types';
import { FittedRoomWarnings, LatestRoomSourceEvidence, LatestRoomRunEvidence } from './RoomModelEvidence';
import RoomRunCharts from './RoomRunCharts';

/** Published room response and revision-scoped measured-run evidence. */
export default function ComfortRoomModel({ homeId, roomId }: { homeId: string; roomId: string }) {
  const { t } = useLanguage();
  const query = useQuery({
    queryKey: ['room-response-evidence', homeId, roomId],
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.rpc('get_energy_room_response_evidence', {
        p_home_id: homeId, p_room_key: roomId,
      }).abortSignal(signal);
      if (error) throw error;
      const view = readRoomResponseView(data);
      if (!view) throw new Error('Invalid room response evidence');
      const revision = view.response?.revision;
      if (revision && view.assessed === 'shared' && view.observedRuns !== null) {
        const measured = view.response?.measuredRuns != null;
        const pageSize = measured ? MEASURED_ROOM_RUN_PAGE_SIZE : ROOM_RUN_PAGE_SIZE;
        const seen = new Set([...view.points, ...view.measuredPoints].map(point => point.id));
        // Database reads stay bounded and revision-scoped. The chart receives
        // the complete ledger, so dates never divide the visible evidence.
        for (let offset = seen.size; offset < view.observedRuns; offset += pageSize) {
          const { data, error } = await supabase.rpc('get_energy_room_run_assessments', {
            p_home_id: homeId, p_room_key: roomId, p_revision: revision, p_offset: offset, p_limit: pageSize,
          }).abortSignal(signal);
          if (error) throw error;
          const count = Math.min(pageSize, view.observedRuns - offset);
          const points = measured ? [] : readRoomAssessmentPage(data, count);
          const measuredPoints = measured ? readMeasuredRoomAssessmentPage(data, count) : [];
          if (!points || !measuredPoints) throw new Error('Invalid room assessment page');
          for (const point of [...points, ...measuredPoints]) {
            if (seen.has(point.id)) throw new Error('Duplicate room assessment');
            seen.add(point.id);
          }
          view.points.push(...points);
          view.measuredPoints.push(...measuredPoints);
        }
      }
      return view;
    },
  });
  const view = query.data ?? null;
  const room = view?.room;
  const rejection = room?.rejection_reason;
  const empty = view && !view.response && view.points.length === 0;
  return <div className="min-w-0 space-y-3 rounded-md border p-4 text-sm">
    <h3 className="font-semibold">{t('Rummets värmemodell', 'Room heating model')}</h3>
    {view && !empty ? <>
      <RoomRunCharts key={JSON.stringify([homeId, roomId, view.response?.revision])} view={view} />
      {view.response && <FittedRoomWarnings warnings={view.response.warnings} />}
    </> : <p role={query.isError || (query.data !== undefined && !view) ? 'alert' : 'status'} className="text-muted-foreground">
      {query.isPending ? t('Laddar modell…', 'Loading model…') : query.isError || !view
        ? t('Modellen kunde inte läsas.', 'The model could not be loaded.')
        : rejection && THERMAL_REJECTION_EN[rejection] ? t(THERMAL_REJECTION_SV[rejection], THERMAL_REJECTION_EN[rejection])
          : t('Ingen tränad modell har publicerats för rummet ännu.', 'A trained model has yet to be published for this room.')}
    </p>}
    {room && <LatestRoomRunEvidence attempt={room.last_fit_attempt} />}
    {room && <LatestRoomSourceEvidence attempt={room.last_fit_attempt} />}
    <Link className="inline-flex min-h-11 items-center font-medium text-primary" to="?tab=setup&section=thermal">
      {t('Visa temperaturhistorik', 'View temperature history')}
    </Link>
  </div>;
}
