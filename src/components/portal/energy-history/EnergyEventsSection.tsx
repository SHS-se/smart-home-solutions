import React, { useMemo, useState } from 'react';
import { CalendarClock, Loader2, Plus, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  ENERGY_EVENT_TYPES,
  treatmentOf,
  type EnergyEventType,
} from '@/lib/energy-events';
import type {
  EnergyHistoryNoteRecord,
  TimelineNoteValues,
} from '@/lib/energy-temperature-storage';

type Translate = (sv: string, en: string) => string;

/**
 * Labels and, more importantly, the one-line explanation of what recording each
 * type actually does to the numbers. A customer will only bother recording a
 * holiday if it is clear why it helps.
 */
function typeCopy(type: EnergyEventType, t: Translate): { label: string; effect: string } {
  switch (type) {
    case 'renovation':
      return {
        label: t('Renovering', 'Renovation'),
        effect: t(
          'Isolering, fönster, dörrar eller tak. Huset före detta datum är en annan byggnad, och energiklassen räknar om sig.',
          'Insulation, windows, doors or roof. The house before this date is a different building, and the energy class re-reckons.',
        ),
      };
    case 'heating_system_change':
      return {
        label: t('Byte av värmesystem', 'Heating system change'),
        effect: t(
          'Ny värmepump eller panna. Ändrar hur mycket köpt energi samma värme kostar.',
          'A new heat pump or boiler. Changes how much bought energy the same warmth costs.',
        ),
      };
    case 'solar_installed':
      return {
        label: t('Solceller installerade', 'Solar installed'),
        effect: t(
          'Efter detta datum är nätuttag inte längre samma sak som husets förbrukning.',
          'After this date grid import is no longer the same thing as the home’s consumption.',
        ),
      };
    case 'battery_installed':
      return {
        label: t('Batteri installerat', 'Battery installed'),
        effect: t(
          'Flyttar förbrukning i tiden. Dygnsmönstret före och efter går inte att jämföra rakt av.',
          'Shifts consumption in time. The daily pattern before and after is not directly comparable.',
        ),
      };
    case 'major_load_added':
      return {
        label: t('Stor förbrukare tillkom', 'Major load added'),
        effect: t(
          'Elbil, pool, bastu, badtunna eller serverskåp. En stadigvarande ökning som inte beror på huset.',
          'An EV, pool, sauna, hot tub or server cabinet. A lasting increase that is not about the building.',
        ),
      };
    case 'major_load_removed':
      return {
        label: t('Stor förbrukare togs bort', 'Major load removed'),
        effect: t(
          'Motsatsen. En minskning som inte är en förbättring av huset.',
          'The opposite. A decrease that is not an improvement to the building.',
        ),
      };
    case 'occupancy_increase':
      return {
        label: t('Fler bor i huset', 'Someone moved in'),
        effect: t(
          'Mer varmvatten, tvätt och hushållsel. Höjer basförbrukningen permanent.',
          'More hot water, laundry and household electricity. Raises the baseline permanently.',
        ),
      };
    case 'occupancy_decrease':
      return {
        label: t('Färre bor i huset', 'Someone moved out'),
        effect: t(
          'Sänker basförbrukningen permanent, utan att huset blivit bättre.',
          'Lowers the baseline permanently, without the building having improved.',
        ),
      };
    case 'absence':
      return {
        label: t('Bortrest', 'Away from home'),
        effect: t(
          'Semester eller tomt hus. Dagarna räknas bort ur underlaget i stället för att dra ner snittet.',
          'A holiday or an empty house. Those days are excluded from the evidence instead of dragging the average down.',
        ),
      };
    case 'guests':
      return {
        label: t('Gäster', 'Guests'),
        effect: t(
          'Fler i huset under en period. Dagarna räknas bort ur underlaget.',
          'More people for a while. Those days are excluded from the evidence.',
        ),
      };
    case 'equipment_fault':
      return {
        label: t('Utrustningsfel', 'Equipment fault'),
        effect: t(
          'Trasig värmepump, låst ventil eller mätarfel. Dagarna räknas bort ur underlaget.',
          'A broken heat pump, a stuck valve or a meter fault. Those days are excluded from the evidence.',
        ),
      };
    default:
      return {
        label: t('Övrigt', 'Other'),
        effect: t(
          'Antecknas och ritas på diagrammen, men påverkar ingen beräkning.',
          'Recorded and drawn on the charts, but affects no calculation.',
        ),
      };
  }
}

function localDateInputValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface EnergyEventsSectionProps {
  notes: EnergyHistoryNoteRecord[];
  isLoading?: boolean;
  loadError?: unknown;
  onCreate: (values: TimelineNoteValues) => Promise<void>;
  onDelete?: (noteId: string) => Promise<void>;
}

const EnergyEventsSection: React.FC<EnergyEventsSectionProps> = ({
  notes,
  isLoading = false,
  loadError,
  onCreate,
  onDelete,
}) => {
  const { t } = useLanguage();
  const [eventType, setEventType] = useState<EnergyEventType>('absence');
  const [noteDate, setNoteDate] = useState(localDateInputValue);
  const [endDate, setEndDate] = useState(localDateInputValue);
  const [eventText, setEventText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const treatment = treatmentOf(eventType);
  const copy = typeCopy(eventType, t);

  const sorted = useMemo(
    () => [...notes].sort((left, right) => right.note_date.localeCompare(left.note_date)),
    [notes],
  );

  const submit = async (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    if (!noteDate || !eventText.trim() || isSaving) return;
    if (treatment === 'period' && endDate < noteDate) {
      setError(t('Slutdatum kan inte vara före startdatum.', 'The end date cannot be before the start date.'));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onCreate({
        noteDate,
        eventText,
        eventType,
        endDate: treatment === 'period' ? endDate : null,
      });
      setEventText('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSaving(false);
    }
  };

  const loadErrorMessage = loadError
    ? loadError instanceof Error ? loadError.message : String(loadError)
    : null;

  return (
    <div className="space-y-5" data-testid="energy-events-section">
      <Alert>
        <AlertTitle>{t('Varför händelser spelar roll', 'Why events matter')}</AlertTitle>
        <AlertDescription className="text-xs leading-relaxed">
          {t(
            'Det mesta som ser konstigt ut i energidatan har en vardaglig förklaring som bara du känner till: ni var bortresta, värmepumpen strulade, någon flyttade in. Utan den förklaringen tolkas en semestervecka som att huset plötsligt blev effektivt, och en renovering som mätfel. Händelser du registrerar här används i beräkningarna — de är inte bara etiketter på diagrammen.',
            'Most of what looks odd in energy data has a mundane explanation only you know: you were away, the heat pump was playing up, someone moved in. Without it, a week’s holiday reads as the house suddenly becoming efficient, and a renovation reads as measurement error. Events recorded here are used in the calculations — they are not just labels on the charts.',
          )}
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4 text-teal-700 dark:text-teal-300" />
            {t('Registrera en händelse', 'Record an event')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto_auto]">
              <div>
                <Label className="text-sm" htmlFor="energy-event-type">
                  {t('Typ av händelse', 'Event type')}
                </Label>
                <Select
                  value={eventType}
                  onValueChange={value => setEventType(value as EnergyEventType)}
                >
                  <SelectTrigger id="energy-event-type" data-testid="energy-event-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENERGY_EVENT_TYPES.map(type => (
                      <SelectItem key={type} value={type}>{typeCopy(type, t).label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-sm" htmlFor="energy-event-start">
                  {treatment === 'period' ? t('Från', 'From') : t('Datum', 'Date')}
                </Label>
                <Input
                  id="energy-event-start"
                  type="date"
                  value={noteDate}
                  onChange={e => setNoteDate(e.target.value)}
                  required
                />
              </div>
              {treatment === 'period' && (
                <div>
                  <Label className="text-sm" htmlFor="energy-event-end">
                    {t('Till och med', 'Until (inclusive)')}
                  </Label>
                  <Input
                    id="energy-event-end"
                    type="date"
                    value={endDate}
                    min={noteDate}
                    onChange={e => setEndDate(e.target.value)}
                    required
                    data-testid="energy-event-end-date"
                  />
                </div>
              )}
            </div>

            <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {copy.effect}
            </p>

            <div>
              <Label className="text-sm" htmlFor="energy-event-text">
                {t('Beskrivning', 'Description')}
              </Label>
              <Textarea
                id="energy-event-text"
                value={eventText}
                onChange={e => setEventText(e.target.value)}
                rows={2}
                placeholder={t(
                  't.ex. Tilläggsisolerade vinden och bytte ytterdörr',
                  'For example: Added attic insulation and replaced the front door',
                )}
                required
              />
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription className="text-xs">{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={isSaving || !eventText.trim()}>
                {isSaving
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <Plus className="mr-2 h-4 w-4" />}
                {t('Spara händelse', 'Save event')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {t('Registrerade händelser', 'Recorded events')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadErrorMessage && (
            <Alert variant="destructive" className="mb-3">
              <AlertDescription className="text-xs">{loadErrorMessage}</AlertDescription>
            </Alert>
          )}
          {isLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('Laddar händelser…', 'Loading events…')}
            </div>
          ) : sorted.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              {t(
                'Inga händelser registrerade ännu. Börja med den senaste semestern eller renoveringen — det är oftast de som förklarar de konstigaste staplarna.',
                'No events recorded yet. Start with the most recent holiday or renovation — those usually explain the strangest bars.',
              )}
            </p>
          ) : (
            <ul className="divide-y">
              {sorted.map((note) => {
                const type = (note.event_type ?? 'other') as EnergyEventType;
                const info = typeCopy(type, t);
                const period = treatmentOf(type) === 'period' && note.end_date;
                return (
                  <li key={note.id} className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{info.label}</Badge>
                        <span className="text-sm font-medium tabular-nums">
                          {note.note_date}{period ? ` → ${note.end_date}` : ''}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{note.event_text}</p>
                    </div>
                    {onDelete && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t('Ta bort', 'Delete')}
                        onClick={() => void onDelete(note.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default EnergyEventsSection;
