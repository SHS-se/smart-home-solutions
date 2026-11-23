import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { readRoomResponseView } from '@/lib/energy-shift/room-response-view';
import { THERMAL_REJECTION_EN, THERMAL_REJECTION_SV } from './plan/types';
import { FittedRoomWarnings, LatestRoomSourceEvidence, LatestRoomRunEvidence } from './RoomModelEvidence';
import RoomRunCharts from './RoomRunCharts';

/** One shared room response: its runs by outdoor temperature and the lines the planner uses. */
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
      <RoomRunCharts key={roomId} view={view} />
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
