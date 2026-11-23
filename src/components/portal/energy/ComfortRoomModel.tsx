import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { readMeasuredRoomAssessmentPage, MEASURED_ROOM_RUN_PAGE_SIZE, readRoomAssessmentPage, ROOM_RUN_PAGE_SIZE, type RoomRunPoint } from '@/lib/energy-shift/room-run-points';
import { Button } from '@/components/ui/button';
import { readRoomResponseView, type RoomResponseView } from '@/lib/energy-shift/room-response-view';
import { THERMAL_REJECTION_EN, THERMAL_REJECTION_SV } from './plan/types';
import { FittedRoomWarnings, LatestRoomSourceEvidence, LatestRoomRunEvidence } from './RoomModelEvidence';
import RoomRunCharts from './RoomRunCharts';
import type { MeasuredRoomAssessment } from '../../../../supabase/functions/_shared/planner/models/room/measured-evidence';

/** Mounted for one room/revision. An outstanding request belongs only to that revision. */
function RoomRunPages({ homeId, roomId, view }: { homeId: string; roomId: string; view: RoomResponseView }) {
  const { language, t } = useLanguage();
  const total = view.observedRuns ?? 0;
  const revision = view.response?.revision;
  const measured = view.response?.measuredRuns != null;
  const pageSize = measured ? MEASURED_ROOM_RUN_PAGE_SIZE : ROOM_RUN_PAGE_SIZE;
  const [page, setPage] = useState<{ start: number; points: RoomRunPoint[]; measuredPoints: MeasuredRoomAssessment[] } | null>(null);
  const request = useMutation({
    mutationFn: async (start: number) => {
      if (start === 0) return { start, points: view.points, measuredPoints: view.measuredPoints };
      if (!revision) throw new Error('Missing room response revision');
      const { data, error } = await supabase.rpc('get_energy_room_run_assessments', {
        p_home_id: homeId, p_room_key: roomId, p_revision: revision, p_offset: start, p_limit: pageSize,
      });
      if (error) throw error;
      const count = Math.min(pageSize, total - start);
      const points = measured ? [] : readRoomAssessmentPage(data, count);
      const measuredPoints = measured ? readMeasuredRoomAssessmentPage(data, count) : [];
      if (!points || !measuredPoints) throw new Error('Invalid room assessment page');
      return { start, points, measuredPoints };
    },
    onSuccess: result => setPage(result.start ? result : null),
  });
  const offset = page?.start ?? 0;
  const points = page?.points ?? view.points;
  const measuredPoints = page?.measuredPoints ?? view.measuredPoints;
  const shown = measured ? measuredPoints.length : points.length;
  const n = (value: number) => value.toLocaleString(language);
  const controls = total > pageSize && <nav aria-label={t('Bedömda förlopp', 'Assessed runs')}
    className="flex flex-wrap items-center gap-2 text-xs" aria-busy={request.isPending}>
    <Button variant="outline" size="sm" className="min-h-11" disabled={request.isPending || offset === 0}
      onClick={() => request.mutate(offset - pageSize)}>{t('Nyare förlopp', 'Newer runs')}</Button>
    <Button variant="outline" size="sm" className="min-h-11" disabled={request.isPending || offset + shown >= total}
      onClick={() => request.mutate(offset + pageSize)}>{t('Äldre förlopp', 'Older runs')}</Button>
    <span role="status" className="tabular-nums">{request.isPending ? t('Laddar förlopp…', 'Loading runs…')
      : t(`Förlopp ${n(offset + 1)}–${n(offset + shown)} av ${n(total)}`,
        `Runs ${n(offset + 1)}–${n(offset + shown)} of ${n(total)}`)}</span>
    {request.isError && <span role="alert">{t('Sidan kunde inte laddas. Försök igen.', 'The page could not be loaded. Try again.')}</span>}
  </nav>;
  return <RoomRunCharts view={{ ...view, points, measuredPoints }} pageControls={controls} />;
}

/** Published room response and revision-scoped measured-run evidence. */
export default function ComfortRoomModel({ homeId, roomId }: { homeId: string; roomId: string }) {
  const { t } = useLanguage();
  const query = useQuery({
    queryKey: ['room-response-evidence', homeId, roomId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_energy_room_response_evidence', { p_home_id: homeId, p_room_key: roomId });
      if (error) throw error;
      return data;
    },
  });
  const view = query.data === undefined ? null : readRoomResponseView(query.data);
  const room = view?.room;
  const rejection = room?.rejection_reason;
  const empty = view && !view.response && view.points.length === 0;
  return <div className="min-w-0 space-y-3 rounded-md border p-4 text-sm">
    <h3 className="font-semibold">{t('Rummets värmemodell', 'Room heating model')}</h3>
    {view && !empty ? <>
      <RoomRunPages key={JSON.stringify([homeId, roomId, view.response?.revision])} homeId={homeId} roomId={roomId} view={view} />
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
