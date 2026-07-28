import React, { useState } from 'react';
import { Plus, StickyNote } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import type { TimelineNoteValues } from '@/lib/energy-temperature-storage';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface EnergyHistoryEventFormProps {
  loadError?: unknown;
  onCreate: (values: TimelineNoteValues) => Promise<void>;
}

function localDateInputValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const EnergyHistoryEventForm: React.FC<EnergyHistoryEventFormProps> = ({
  loadError,
  onCreate,
}) => {
  const { t } = useLanguage();
  const [noteDate, setNoteDate] = useState(localDateInputValue);
  const [eventText, setEventText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadErrorMessage = loadError
    ? loadError instanceof Error ? loadError.message : String(loadError)
    : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!noteDate || !eventText.trim() || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      await onCreate({ noteDate, eventText });
      setNoteDate(localDateInputValue());
      setEventText('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card
      className="overflow-hidden border-teal-200/80 bg-gradient-to-br from-background to-teal-500/5 shadow-sm dark:border-teal-900/70"
      data-testid="energy-history-events"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <StickyNote className="h-4 w-4 text-teal-700 dark:text-teal-300" />
          {t('Lägg till händelse', 'Add event')}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t(
            'Registrerade händelser markeras direkt i diagrammen med turkosa streckade linjer och diamanter.',
            'Recorded events are marked directly on the charts with teal dashed lines and diamonds.',
          )}
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="rounded-xl border border-border/70 bg-background/80 p-4">
          <div className="grid items-start gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
            <div className="space-y-2">
              <Label htmlFor="energy-history-note-date">{t('Datum', 'Date')}</Label>
              <Input
                id="energy-history-note-date"
                type="date"
                value={noteDate}
                onChange={(event) => setNoteDate(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="energy-history-note-event">{t('Händelse', 'Event')}</Label>
              <Textarea
                id="energy-history-note-event"
                value={eventText}
                maxLength={4000}
                rows={2}
                placeholder={t(
                  'Till exempel: Tilläggsisolerade vinden och bytte ytterdörr',
                  'For example: Added attic insulation and replaced the front door',
                )}
                onChange={(event) => setEventText(event.target.value)}
                required
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button type="submit" disabled={isSaving || !eventText.trim()}>
              <Plus className="mr-2 h-4 w-4" />
              {t('Lägg till händelse', 'Add event')}
            </Button>
          </div>
        </form>

        {(error || loadErrorMessage) && (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{error ?? loadErrorMessage}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};

export default EnergyHistoryEventForm;
