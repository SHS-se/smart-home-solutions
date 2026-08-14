import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Clock3,
  Copy,
  Loader2,
  Save,
  ThermometerSun,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import {
  COMFORT_MODES,
  comfortIntervals,
  isZoneComfortSchedule,
  quarterLabel,
  type ComfortDayType,
  type ComfortMode,
  type ZoneComfortSchedule,
} from '../../../../supabase/functions/_shared/comfort-schedule';

interface ComfortZone {
  id: string;
  name: string;
  controlledDevices: string[];
}

interface StoredComfortSchedule extends ZoneComfortSchedule {
  id: string;
  room_key: string;
  room_name: string;
  source: 'node_red_seed' | 'portal';
  updated_at: string;
}

const cloneSchedule = (schedule: ZoneComfortSchedule): ZoneComfortSchedule => ({
  weekday_modes: [...schedule.weekday_modes],
  weekend_modes: [...schedule.weekend_modes],
  off_temperature_c: schedule.off_temperature_c,
  low_temperature_c: schedule.low_temperature_c,
  high_temperature_c: schedule.high_temperature_c,
});

const sameSchedule = (
  left: ZoneComfortSchedule | undefined,
  right: ZoneComfortSchedule | undefined,
): boolean => {
  if (!left && !right) return true;
  return Boolean(
    left && right && JSON.stringify(cloneSchedule(left)) === JSON.stringify(cloneSchedule(right)),
  );
};

const modeClasses: Record<ComfortMode, string> = {
  off: 'bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700',
  'low-temp': 'bg-sky-300 hover:bg-sky-400 dark:bg-sky-800 dark:hover:bg-sky-700',
  'high-temp': 'bg-amber-400 hover:bg-amber-500 dark:bg-amber-500 dark:hover:bg-amber-400',
};

const ComfortSchedulesTab: React.FC<{
  customerId: string;
  homeId: string | null;
}> = ({ customerId, homeId }) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [zones, setZones] = useState<ComfortZone[]>([]);
  const [stored, setStored] = useState<Record<string, StoredComfortSchedule>>({});
  const [drafts, setDrafts] = useState<Record<string, ZoneComfortSchedule>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [brush, setBrush] = useState<ComfortMode>('high-temp');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const painting = useRef(false);

  const modeLabel: Record<ComfortMode, string> = {
    off: t('Av / frostskydd', 'Off / frost protection'),
    'low-temp': t('Sänkt temperatur', 'Setback'),
    'high-temp': t('Komfort', 'Comfort'),
  };

  const load = useCallback(async () => {
    if (!customerId || !homeId) {
      setZones([]);
      setStored({});
      setDrafts({});
      setSelectedId(null);
      return;
    }
    setLoading(true);
    setError(null);
    const [deviceResult, scheduleResult] = await Promise.all([
      supabase
        .from('energy_optimisation_devices')
        .select('mapping_summary')
        .eq('customer_id', customerId)
        .eq('home_id', homeId)
        .eq('category', 'heating')
        .eq('planning_role_override', 'controllable')
        .eq('control_type_override', 'setpoint')
        .eq('mapping_status', 'ready')
        .eq('mapped_control_type', 'setpoint')
        .is('retired_at', null)
        .order('name'),
      supabase
        .from('energy_optimisation_comfort_schedules')
        .select('id, room_key, room_name, weekday_modes, weekend_modes, off_temperature_c, low_temperature_c, high_temperature_c, source, updated_at')
        .eq('customer_id', customerId)
        .eq('home_id', homeId),
    ]);
    if (deviceResult.error || scheduleResult.error) {
      setError((deviceResult.error ?? scheduleResult.error)?.message ?? t(
        'Komfortschemat kunde inte läsas.',
        'The comfort schedule could not be loaded.',
      ));
      setLoading(false);
      return;
    }

    const grouped = new Map<string, ComfortZone>();
    for (const device of deviceResult.data ?? []) {
      const summary = device.mapping_summary && typeof device.mapping_summary === 'object' && !Array.isArray(device.mapping_summary)
        ? device.mapping_summary as Record<string, unknown>
        : {};
      const roomKey = typeof summary.room_key === 'string' ? summary.room_key : '';
      const roomName = typeof summary.room_name === 'string' ? summary.room_name : '';
      const controlled = Array.isArray(summary.controlled_devices)
        ? summary.controlled_devices.filter((value): value is string => typeof value === 'string')
        : [];
      if (!roomKey || !roomName || controlled.length === 0) continue;
      const room = grouped.get(roomKey) ?? {
        id: roomKey,
        name: roomName,
        controlledDevices: [],
      };
      room.controlledDevices = [...new Set([...room.controlledDevices, ...controlled])].sort();
      grouped.set(roomKey, room);
    }
    const nextZones = [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name));
    const rowsByRoom = new Map(
      (scheduleResult.data ?? []).map(row => [row.room_key, row]),
    );
    const nextStored: Record<string, StoredComfortSchedule> = {};
    const nextDrafts: Record<string, ZoneComfortSchedule> = {};
    const missing: string[] = [];
    for (const zone of nextZones) {
      const row = rowsByRoom.get(zone.id);
      const candidate = row && {
        weekday_modes: row.weekday_modes,
        weekend_modes: row.weekend_modes,
        off_temperature_c: Number(row.off_temperature_c),
        low_temperature_c: Number(row.low_temperature_c),
        high_temperature_c: Number(row.high_temperature_c),
      };
      if (!row || !isZoneComfortSchedule(candidate)) {
        missing.push(zone.name);
        continue;
      }
      const schedule: StoredComfortSchedule = {
        id: row.id,
        room_key: row.room_key,
        room_name: row.room_name,
        source: row.source as StoredComfortSchedule['source'],
        updated_at: row.updated_at,
        ...candidate,
      };
      nextStored[zone.id] = schedule;
      nextDrafts[zone.id] = cloneSchedule(schedule);
    }
    setZones(nextZones);
    setStored(nextStored);
    setDrafts(nextDrafts);
    setSelectedId(current => (
      current && nextDrafts[current] ? current : nextZones.find(zone => nextDrafts[zone.id])?.id ?? null
    ));
    if (missing.length > 0) {
      setError(t(
        `Komfortschema saknas för ${missing.join(', ')}. Spara om styrtypen Börvärde på fliken Enheter.`,
        `A comfort schedule is missing for ${missing.join(', ')}. Re-save Setpoint control on the Devices tab.`,
      ));
    }
    setLoading(false);
  }, [customerId, homeId, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const stopPainting = () => { painting.current = false; };
    window.addEventListener('pointerup', stopPainting);
    window.addEventListener('pointercancel', stopPainting);
    return () => {
      window.removeEventListener('pointerup', stopPainting);
      window.removeEventListener('pointercancel', stopPainting);
    };
  }, []);

  const selectedZone = zones.find(zone => zone.id === selectedId) ?? null;
  const draft = selectedId ? drafts[selectedId] : undefined;
  const saved = selectedId ? stored[selectedId] : undefined;
  const dirty = !sameSchedule(draft, saved);
  const dirtyCount = zones.filter(zone => !sameSchedule(drafts[zone.id], stored[zone.id])).length;
  const temperaturesValid = Boolean(
    draft &&
    [draft.off_temperature_c, draft.low_temperature_c, draft.high_temperature_c]
      .every(value => Number.isFinite(value) && value >= 5 && value <= 30) &&
    draft.off_temperature_c <= draft.low_temperature_c &&
    draft.low_temperature_c <= draft.high_temperature_c,
  );

  const updateDraft = (updater: (current: ZoneComfortSchedule) => ZoneComfortSchedule) => {
    if (!selectedId) return;
    setDrafts(current => ({
      ...current,
      [selectedId]: updater(current[selectedId]),
    }));
  };

  const paint = (dayType: ComfortDayType, quarter: number) => updateDraft(current => {
    const field = `${dayType}_modes` as const;
    if (current[field][quarter] === brush) return current;
    const modes = [...current[field]];
    modes[quarter] = brush;
    return { ...current, [field]: modes };
  });

  const copyDay = (from: ComfortDayType, to: ComfortDayType) => updateDraft(current => ({
    ...current,
    [`${to}_modes`]: [...current[`${from}_modes`]],
  }));

  const save = async () => {
    if (!selectedId || !draft || !temperaturesValid) return;
    setSaving(true);
    const { data, error: saveError } = await supabase.rpc(
      'set_energy_room_comfort_schedule',
      {
        p_home_id: homeId,
        p_room_key: selectedId,
        p_weekday_modes: draft.weekday_modes,
        p_weekend_modes: draft.weekend_modes,
        p_off_temperature_c: draft.off_temperature_c,
        p_low_temperature_c: draft.low_temperature_c,
        p_high_temperature_c: draft.high_temperature_c,
      },
    );
    if (saveError) {
      toast({
        title: t('Kunde inte spara komfortschemat', 'Could not save the comfort schedule'),
        description: saveError.message,
        variant: 'destructive',
      });
    } else {
      const row = data as unknown as StoredComfortSchedule;
      setStored(current => ({
        ...current,
        [selectedId]: {
          ...current[selectedId],
          ...cloneSchedule(draft),
          source: 'portal',
          updated_at: row?.updated_at ?? new Date().toISOString(),
        },
      }));
      toast({
        title: t('Komfortschemat sparades', 'Comfort schedule saved'),
        description: t(
          'Nästa energiplan använder den nya rutinen.',
          'The next energy plan will use the new routine.',
        ),
      });
    }
    setSaving(false);
  };

  if (!homeId) {
    return <p className="py-12 text-sm text-muted-foreground">{t(
      'Välj ett hem för att redigera komfortschemat.',
      'Select a home to edit its comfort schedule.',
    )}</p>;
  }
  if (loading) {
    return <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('Laddar komfortschema…', 'Loading comfort schedule…')}</div>;
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t('Komfortschemat behöver åtgärdas', 'The comfort schedule needs attention')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Clock3 className="h-5 w-5" />
                {t('När ska rummen vara varma?', 'When should rooms be warm?')}
              </CardTitle>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                {t(
                  'Måla den vanliga veckorytmen för varje rum. Komfort är en deadline: rummet ska ha nått temperaturen när den första gula kvarten börjar. Planeraren får förvärma under sänkt temperatur och fördelar uppvärmningen mellan rummen för att undvika onödiga effekttoppar.',
                  'Paint the usual weekly rhythm for each room. Comfort is a deadline: the room should have reached the temperature when the first yellow quarter begins. The planner may preheat during Setback and spreads heating across rooms to avoid unnecessary power peaks.',
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {dirtyCount > 0 && <Badge variant="outline">{dirtyCount} {t('osparade', 'unsaved')}</Badge>}
              <Badge variant="secondary">{zones.length} {t('rum', 'rooms')}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {zones.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <ThermometerSun className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-medium">{t('Inga komfortzoner ännu', 'No comfort zones yet')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(
                  'Välj Styrbar · Börvärde för en eller flera värmeenheter på fliken Enheter och mappa dem sedan till ett Home Assistant-rum. Då skapas ett gemensamt rumsschema automatiskt.',
                  'Choose Controllable · Setpoint for one or more heating devices on the Devices tab, then map them to a Home Assistant room. One shared room schedule will be created automatically.',
                )}
              </p>
            </div>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
              <div className="space-y-1">
                <p className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('Rum', 'Rooms')}</p>
                <div className="flex gap-1 overflow-x-auto pb-2 lg:block lg:space-y-1 lg:overflow-visible">
                  {zones.map(zone => (
                    <Button
                      key={zone.id}
                      type="button"
                      variant={selectedId === zone.id ? 'secondary' : 'ghost'}
                      className="h-auto min-w-max justify-start px-3 py-2 lg:w-full"
                      onClick={() => setSelectedId(zone.id)}
                    >
                      <span className="truncate">{zone.name}</span>
                      {!sameSchedule(drafts[zone.id], stored[zone.id])
                        ? <span className="ml-auto h-2 w-2 rounded-full bg-amber-500" title={t('Osparade ändringar', 'Unsaved changes')} />
                        : <Check className="ml-auto h-3.5 w-3.5 text-emerald-600" />}
                    </Button>
                  ))}
                </div>
              </div>

              {selectedZone && draft && saved && (
                <div className="min-w-0 space-y-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-xl font-medium">{selectedZone.name}</h2>
                      <p className="text-xs text-muted-foreground">
                        {saved.source === 'node_red_seed'
                          ? t('Startvärden från det befintliga Node-RED-schemat', 'Initial values from the existing Node-RED schedule')
                          : `${t('Senast ändrad', 'Last changed')} ${new Date(saved.updated_at).toLocaleString()}`}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="mr-1 text-xs text-muted-foreground">{t('Planerade styrenheter:', 'Planned controls:')}</span>
                        {selectedZone.controlledDevices.map(device => (
                          <Badge key={device} variant="secondary" className="font-normal">{device}</Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {dirty && <Badge variant="outline">{t('Osparat', 'Unsaved')}</Badge>}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!dirty || saving}
                        onClick={() => updateDraft(() => cloneSchedule(saved))}
                      >
                        {t('Ångra', 'Discard')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!dirty || !temperaturesValid || saving}
                        onClick={() => void save()}
                      >
                        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                        {t('Spara', 'Save')}
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    {([
                      ['off_temperature_c', 'off'] as const,
                      ['low_temperature_c', 'low-temp'] as const,
                      ['high_temperature_c', 'high-temp'] as const,
                    ]).map(([field, mode]) => (
                      <div key={field} className="rounded-lg border p-3">
                        <Label htmlFor={`${selectedId}-${field}`} className="flex items-center gap-2 text-xs">
                          <span className={cn('h-3 w-3 rounded-sm', modeClasses[mode])} />
                          {modeLabel[mode]}
                        </Label>
                        <div className="mt-2 flex items-center gap-2">
                          <Input
                            id={`${selectedId}-${field}`}
                            type="number"
                            min={5}
                            max={30}
                            step={0.5}
                            value={draft[field]}
                            className="h-9 tabular-nums"
                            onChange={event => {
                              const value = Number(event.target.value);
                              if (Number.isFinite(value)) updateDraft(current => ({ ...current, [field]: value }));
                            }}
                          />
                          <span className="text-sm text-muted-foreground">°C</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  {!temperaturesValid && (
                    <p className="text-xs text-destructive">{t(
                      'Temperaturerna måste ligga mellan 5 och 30 °C i ordningen Av ≤ Sänkt ≤ Komfort.',
                      'Temperatures must be between 5 and 30 °C in the order Off ≤ Setback ≤ Comfort.',
                    )}</p>
                  )}

                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="mb-2 text-xs font-medium">{t('Pensel', 'Brush')}</p>
                    <div className="flex flex-wrap gap-2" role="group" aria-label={t('Välj temperaturläge', 'Choose temperature mode')}>
                      {COMFORT_MODES.map(mode => (
                        <Button
                          key={mode}
                          type="button"
                          size="sm"
                          variant={brush === mode ? 'default' : 'outline'}
                          aria-pressed={brush === mode}
                          onClick={() => setBrush(mode)}
                        >
                          <span className={cn('mr-2 h-3 w-3 rounded-sm', modeClasses[mode])} />
                          {modeLabel[mode]}
                        </Button>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{t(
                      'Klicka eller dra över tidsbandet. En gul ruta sätter ett komfortmål när kvarten börjar; måla flera i rad för att hålla rummet varmt.',
                      'Click or drag across a time band. One yellow cell sets a comfort target when its quarter begins; paint several in a row to keep the room warm.',
                    )}</p>
                  </div>

                  {(['weekday', 'weekend'] as ComfortDayType[]).map(dayType => {
                    const modes = draft[`${dayType}_modes`];
                    const periods = comfortIntervals(modes)
                      .filter(interval => interval.mode === 'high-temp')
                      .map(interval => `${quarterLabel(interval.start_quarter)}–${quarterLabel(interval.end_quarter)}`);
                    return (
                      <div key={dayType} className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="font-medium">{dayType === 'weekday' ? t('Vardagar', 'Weekdays') : t('Helg', 'Weekend')}</p>
                            <p className="text-xs text-muted-foreground">
                              {periods.length > 0 ? periods.join(', ') : t('Inget komfortmål', 'No comfort target')}
                            </p>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => copyDay(dayType === 'weekday' ? 'weekend' : 'weekday', dayType)}
                          >
                            <Copy className="mr-2 h-3.5 w-3.5" />
                            {dayType === 'weekday' ? t('Kopiera från helg', 'Copy weekend') : t('Kopiera från vardag', 'Copy weekdays')}
                          </Button>
                        </div>
                        <div className="overflow-x-auto pb-1">
                          <div className="min-w-[720px]">
                            <div className="mb-1 grid grid-cols-8 text-[10px] tabular-nums text-muted-foreground" aria-hidden="true">
                              {[0, 3, 6, 9, 12, 15, 18, 21].map(hour => <span key={hour}>{String(hour).padStart(2, '0')}:00</span>)}
                            </div>
                            <div
                              className="grid overflow-hidden rounded-md border"
                              style={{ gridTemplateColumns: 'repeat(96, minmax(7px, 1fr))', touchAction: 'none' }}
                              role="grid"
                              aria-label={`${dayType === 'weekday' ? t('Vardagar', 'Weekdays') : t('Helg', 'Weekend')} · ${selectedZone.name}`}
                              onPointerLeave={() => { painting.current = false; }}
                            >
                              <TooltipProvider delayDuration={0} skipDelayDuration={0}>
                                {modes.map((mode, quarter) => (
                                  <Tooltip key={quarter}>
                                    <TooltipTrigger asChild>
                                      <button
                                        type="button"
                                        role="gridcell"
                                        aria-label={`${quarterLabel(quarter)}–${quarterLabel(quarter + 1)}: ${modeLabel[mode]}`}
                                        className={cn(
                                          'h-10 border-r border-background/50 outline-none focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring',
                                          quarter % 4 === 3 && 'border-r-foreground/20',
                                          modeClasses[mode],
                                        )}
                                        onClick={() => paint(dayType, quarter)}
                                        onPointerDown={event => {
                                          event.preventDefault();
                                          painting.current = true;
                                          paint(dayType, quarter);
                                        }}
                                        onPointerEnter={() => {
                                          if (painting.current) paint(dayType, quarter);
                                        }}
                                      />
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom" className="tabular-nums">
                                      {quarterLabel(quarter)}–{quarterLabel(quarter + 1)} · {modeLabel[mode]}
                                    </TooltipContent>
                                  </Tooltip>
                                ))}
                              </TooltipProvider>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ComfortSchedulesTab;
