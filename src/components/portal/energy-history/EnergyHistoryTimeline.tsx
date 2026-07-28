import React, { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Save, StickyNote, Trash2, X } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import type { EnergyHistoryNoteRecord, TimelineNoteValues } from '@/lib/energy-temperature-storage';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface EnergyHistoryTimelineProps {
  notes: EnergyHistoryNoteRecord[];
  loadError?: unknown;
  currentUserId: string | null;
  isStaff: boolean;
  onCreate: (values: TimelineNoteValues) => Promise<void>;
  onUpdate: (noteId: string, values: TimelineNoteValues) => Promise<void>;
  onDelete: (noteId: string) => Promise<void>;
}

interface NoteFormState {
  noteDate: string;
  eventText: string;
}

function localDateInputValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const emptyForm = (): NoteFormState => ({
  noteDate: localDateInputValue(),
  eventText: '',
});

const EnergyHistoryTimeline: React.FC<EnergyHistoryTimelineProps> = ({
  notes,
  loadError,
  currentUserId,
  isStaff,
  onCreate,
  onUpdate,
  onDelete,
}) => {
  const { t, language } = useLanguage();
  const [form, setForm] = useState<NoteFormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadErrorMessage = loadError
    ? loadError instanceof Error ? loadError.message : String(loadError)
    : null;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    language === 'sv' ? 'sv-SE' : 'en-GB',
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' },
  ), [language]);

  useEffect(() => {
    if (editingId && !notes.some((note) => note.id === editingId)) {
      setEditingId(null);
      setForm(emptyForm());
    }
  }, [editingId, notes]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.noteDate || !form.eventText.trim() || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      if (editingId) {
        await onUpdate(editingId, form);
      } else {
        await onCreate(form);
      }
      setEditingId(null);
      setForm(emptyForm());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSaving(false);
    }
  };

  const editNote = (note: EnergyHistoryNoteRecord) => {
    setEditingId(note.id);
    setForm({ noteDate: note.note_date, eventText: note.event_text });
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm());
    setError(null);
  };

  const deleteNote = async (note: EnergyHistoryNoteRecord) => {
    const confirmed = window.confirm(t(
      'Ta bort den här händelsen?',
      'Delete this event?',
    ));
    if (!confirmed) return;
    setError(null);
    try {
      await onDelete(note.id);
      if (editingId === note.id) cancelEdit();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <Card
      className="overflow-hidden border-teal-200/80 bg-gradient-to-br from-background to-teal-500/5 shadow-sm dark:border-teal-900/70"
      data-testid="energy-history-events"
    >
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <StickyNote className="h-4 w-4 text-teal-700 dark:text-teal-300" />
            {t('Händelsetidslinje', 'Event timeline')}
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            {notes.length} {t('händelser', 'events')}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {t(
            'Markera renoveringar, värmesystembyten eller andra händelser som kan förklara förändringar i förbrukningen.',
            'Record renovations, heating-system changes, or other events that may explain changes in consumption.',
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <form onSubmit={submit} className="rounded-xl border border-border/70 bg-background/80 p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">
              {editingId
                ? t('Redigera händelse', 'Edit event')
                : t('Lägg till händelse', 'Add event')}
            </h3>
            {editingId && (
              <Button type="button" size="sm" variant="ghost" onClick={cancelEdit}>
                <X className="mr-1.5 h-4 w-4" />
                {t('Avbryt', 'Cancel')}
              </Button>
            )}
          </div>
          <div className="grid items-start gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
            <div className="space-y-2">
              <Label htmlFor="energy-history-note-date">{t('Datum', 'Date')}</Label>
              <Input
                id="energy-history-note-date"
                type="date"
                value={form.noteDate}
                onChange={(event) => setForm((current) => ({ ...current, noteDate: event.target.value }))}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="energy-history-note-event">{t('Händelse', 'Event')}</Label>
              <Textarea
                id="energy-history-note-event"
                value={form.eventText}
                maxLength={4000}
                rows={2}
                placeholder={t(
                  'Till exempel: Tilläggsisolerade vinden och bytte ytterdörr',
                  'For example: Added attic insulation and replaced the front door',
                )}
                onChange={(event) => setForm((current) => ({ ...current, eventText: event.target.value }))}
                required
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button type="submit" disabled={isSaving || !form.eventText.trim()}>
              {editingId ? <Save className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
              {editingId ? t('Spara ändringar', 'Save changes') : t('Lägg till händelse', 'Add event')}
            </Button>
          </div>
        </form>

        {(error || loadErrorMessage) && (
          <Alert variant="destructive">
            <AlertDescription>{error ?? loadErrorMessage}</AlertDescription>
          </Alert>
        )}

        {notes.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center">
            <p className="text-sm font-medium">{t('Tidslinjen är tom', 'The timeline is empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('Dina händelser visas här och markeras i diagrammen.', 'Your events will appear here and be marked on the charts.')}
            </p>
          </div>
        ) : (
          <div className="relative space-y-4 pl-6 before:absolute before:bottom-2 before:left-2 before:top-2 before:w-px before:bg-teal-200 dark:before:bg-teal-900">
            {notes.map((note) => (
              <div key={note.id} className="relative rounded-xl border border-border/70 bg-background/80 p-4">
                <span className="absolute -left-[1.55rem] top-5 h-3 w-3 rounded-full border-2 border-background bg-teal-700 ring-1 ring-teal-300 dark:ring-teal-800" />
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {dateFormatter.format(new Date(`${note.note_date}T00:00:00Z`))}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm font-medium leading-relaxed">{note.event_text}</p>
                  </div>
                  {(isStaff || note.created_by === currentUserId) && (
                    <div className="flex gap-1">
                      <Button type="button" size="icon" variant="ghost" onClick={() => editNote(note)} aria-label={t('Redigera', 'Edit')}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button type="button" size="icon" variant="ghost" onClick={() => void deleteNote(note)} aria-label={t('Ta bort', 'Delete')}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default EnergyHistoryTimeline;
