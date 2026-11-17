import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

type DoorwayMode = 'usually_open' | 'varies';
type Connection = { rooms: [string, string]; mode: DoorwayMode };
type Room = {
  key: string;
  name: string;
  has_probe: boolean;
  latest: { start: string; temperature_c: number } | null;
};
type Profile = { revision: number; rooms: Room[]; connections: Connection[] };

const selectStyle = 'block min-h-11 w-full rounded-md border bg-background px-3 py-2';

export default function RoomConnections({ homeId, linkedRoom, linked }: {
  homeId: string;
  linkedRoom: string | null;
  linked: boolean;
}) {
  const { t, language } = useLanguage();
  const id = useId();
  const [selected, setSelected] = useState(linkedRoom ?? '');
  const [other, setOther] = useState('');
  const [draft, setDraft] = useState<{ revision: number; connections: Connection[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const { data, isError, refetch, isPending } = useQuery({
    queryKey: ['room-profile', homeId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_energy_room_profile', { p_home_id: homeId });
      if (error) throw error;
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
          typeof data.revision !== 'number' || !Array.isArray(data.rooms) || !Array.isArray(data.connections)) {
        throw new Error('Invalid room profile');
      }
      return data as unknown as Profile;
    },
    retry: false,
    refetchInterval: 60_000,
  });

  const loaded = Boolean(data);
  useEffect(() => {
    if (linked && loaded) document.getElementById('room-connections')?.scrollIntoView({ block: 'start' });
  }, [linked, loaded]);

  if (!linked && !data?.rooms.length && !data?.connections.length) return null;
  const rooms = data?.rooms ?? [];
  const connections = draft?.connections ?? data?.connections ?? [];
  const room = rooms.find(room => room.key === selected) ?? rooms[0];
  const incident = room ? connections.filter(edge => edge.rooms.includes(room.key)) : [];
  const orphaned = connections.filter(edge => edge.rooms.every(key => !rooms.some(item => item.key === key)));
  const available = room ? rooms.filter(candidate => candidate.key !== room.key &&
    !incident.some(edge => edge.rooms.includes(candidate.key))) : [];
  const roomName = (key: string) => rooms.find(room => room.key === key)?.name ?? key;
  const edit = (next: Connection[]) => {
    if (!data) return;
    setSaved(false);
    setError(null);
    setDraft({ revision: draft?.revision ?? data.revision, connections: next });
  };
  const reload = async () => {
    const result = await refetch();
    if (result.isError) return;
    setDraft(null);
    setError(null);
    setSaved(false);
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const { error } = await supabase.rpc('set_energy_room_connections', {
        p_home_id: homeId, p_expected_revision: draft.revision, p_connections: draft.connections,
      });
      if (error) {
        setError(error.code === '40001'
          ? t('Anslutningarna har ändrats. Ladda om de sparade anslutningarna och granska dem igen.',
            'Connections changed. Reload the saved connections and review them again.')
          : error.code === '22023'
            ? t('Kontrollera att rummen fortfarande finns i Home Assistant.', 'Check that both rooms are still available in Home Assistant.')
            : t('Kunde inte spara rumsanslutningarna. Försök igen.', 'Could not save room connections. Try again.'));
        return;
      }
      const refreshed = await refetch();
      if (!refreshed.isError) setDraft(null);
      setSaved(true);
    } catch {
      setError(t('Kunde inte spara rumsanslutningarna. Försök igen.', 'Could not save room connections. Try again.'));
    } finally {
      setSaving(false);
    }
  };
  return <Card id="room-connections" className="scroll-mt-24">
    <CardHeader><CardTitle>{t('Rumsanslutningar', 'Room connections')}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {isPending && <p role="status">{t('Läser rum från Home Assistant…', 'Loading rooms from Home Assistant…')}</p>}
      {isError && !data && <p role="alert">{t('Kunde inte läsa rumsanslutningarna.', 'Could not load room connections.')}{' '}
        <Button variant="outline" onClick={() => void reload()}>{t('Försök igen', 'Try again')}</Button></p>}
      {!!data && !rooms.length && <p>{t('Väntar på rumslistan från SHS-appen.', 'Waiting for the room list from the SHS app.')}</p>}
      {room && <>
        <label htmlFor={id + '-room'} className="block font-medium">{t('Rum', 'Room')}</label>
        <select id={id + '-room'} className={selectStyle} value={room.key}
          onChange={event => { setSelected(event.target.value); setOther(''); }}>
          {rooms.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}
        </select>
        {linkedRoom && !rooms.some(item => item.key === linkedRoom) &&
          <p role="status">{t('Det länkade rummet finns inte i den senaste rumslistan.', 'The linked room is missing from the latest room list.')}</p>}
        <p className="text-sm text-muted-foreground">
          {room.latest ? t('Senaste mätning', 'Latest reading') + ' ' +
            new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(room.latest.temperature_c) + ' °C · ' +
            new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(room.latest.start))
            : room.has_probe ? t('Väntar på temperaturmätningar.', 'Waiting for temperature readings.')
              : t('Ingen temperaturgivare är vald i SHS-appen.', 'No temperature probe is configured in the SHS app.')}
        </p>
      </>}
      {orphaned.length > 0 && <p className="text-sm text-muted-foreground">
        {t('Vissa sparade anslutningar har rum som saknas i Home Assistant.', 'Some saved connections have rooms missing from Home Assistant.')}
      </p>}
      {incident.length + orphaned.length > 0 && <ul className="divide-y">
        {[...incident, ...orphaned].map(edge => <li key={JSON.stringify(edge.rooms)} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <p className="font-medium">{room && edge.rooms.includes(room.key) ? roomName(edge.rooms.find(key => key !== room.key)!) : edge.rooms.map(roomName).join(' ↔ ')}</p>
          <Button variant="ghost" className="min-h-11" disabled={saving}
            onClick={() => edit(connections.filter(connection => connection !== edge))}>
            {t('Ta bort', 'Remove')}
          </Button>
        </li>)}
      </ul>}
      {room && !incident.length && <p>{t('Inga dörröppningar tillagda.', 'No doorways added.')}</p>}
      {available.length > 0 && room && <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="space-y-1">{t('Anslutet rum', 'Connected room')}
          <select className={selectStyle} value={available.some(item => item.key === other) ? other : ''}
            onChange={event => setOther(event.target.value)}>
            <option value="">{t('Välj ett rum', 'Choose a room')}</option>
            {available.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}
          </select>
        </label>
        <Button variant="outline" className="min-h-11" disabled={saving || !available.some(item => item.key === other)}
          onClick={() => { edit([...connections, { rooms: [room.key, other], mode: 'usually_open' }]); setOther(''); }}>
          {t('Lägg till dörröppning', 'Add doorway')}
        </Button>
      </div>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {saved && !error && <p role="status">{t('Rumsanslutningar sparade.', 'Room connections saved.')}</p>}
      {draft && <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" disabled={saving || saved} onClick={() => void save()}>
          {saving ? t('Sparar…', 'Saving…') : t('Spara', 'Save')}
        </Button>
        <Button variant="outline" className="min-h-11" disabled={saving} onClick={() => void reload()}>
          {error || saved ? t('Ladda om sparade anslutningar', 'Reload saved connections') : t('Ångra', 'Discard')}
        </Button>
      </div>}
    </CardContent>
  </Card>;
}
