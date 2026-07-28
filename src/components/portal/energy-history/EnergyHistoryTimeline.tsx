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
  onCreate: (values: TimelineNoteValues) => Promise<void>;
  onUpdate: (noteId: string, values: TimelineNoteValues) => Promise<void>;
  onDelete: (noteId: string) => Promise<void>;
}

interface NoteFormState {
  noteDate: string;
  title: string;
  details: string;
}

const emptyForm = (): NoteFormState => ({
  noteDate: new Date().toISOString().slice(0, 10),
  title: '',
  details: '',
});

const EnergyHistoryTimeline: React.FC<EnergyHistoryTimelineProps> = ({
  notes,
  onCreate,
  onUpdate,
  onDelete,
}) => {
  const { t, language } = useLanguage();
  const [form, setForm] = useState<NoteFormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    if (!form.noteDate || !form.title.trim() || !form.details.trim() || isSaving) return;
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
    setForm({ noteDate: note.note_date, title: note.title, details: note.details });
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm());
    setError(null);
  };

  const deleteNote = async (note: EnergyHistoryNoteRecord) => {
    const confirmed = window.confirm(t(
      `Ta bort anteckningen "${note.title}"?`,
      `Delete the note "${note.title}"?`,
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
    <Card className="overflow-hidden border-violet-200/80 bg-gradient-to-br from-background to-violet-500/5 shadow-sm dark:border-violet-900/70">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <StickyNote className="h-4 w-4 text-violet-600" />
            {t('Tidslinje och anteckningar', 'Timeline and notes')}
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            {notes.length} {t('anteckningar', 'notes')}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {t(
            'Markera renoveringar, värmesystembyten eller andra händelser som kan förklara en förändring i förbrukningen.',
            'Record renovations, heating-system changes, or other events that may explain a change in consumption.',
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <form onSubmit={submit} className="rounded-xl border border-border/70 bg-background/80 p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">
              {editingId
                ? t('Redigera anteckning', 'Edit note')
                : t('Lägg till anteckning', 'Add note')}
            </h3>
            {editingId && (
              <Button type="button" size="sm" variant="ghost" onClick={cancelEdit}>
                <X className="mr-1.5 h-4 w-4" />
                {t('Avbryt', 'Cancel')}
              </Button>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
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
              <Label htmlFor="energy-history-note-title">{t('Rubrik', 'Title')}</Label>
              <Input
                id="energy-history-note-title"
                value={form.title}
                maxLength={200}
                placeholder={t('Till exempel tilläggsisolering', 'For example, added insulation')}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                required
              />
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <Label htmlFor="energy-history-note-details">{t('Beskrivning', 'Description')}</Label>
            <Textarea
              id="energy-history-note-details"
              value={form.details}
              maxLength={4000}
              rows={3}
              placeholder={t('Vad ändrades och när blev det klart?', 'What changed and when was it completed?')}
              onChange={(event) => setForm((current) => ({ ...current, details: event.target.value }))}
              required
            />
          </div>
          <div className="mt-4 flex justify-end">
            <Button type="submit" disabled={isSaving || !form.title.trim() || !form.details.trim()}>
              {editingId ? <Save className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
              {editingId ? t('Spara ändringar', 'Save changes') : t('Lägg till', 'Add note')}
            </Button>
          </div>
        </form>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {notes.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center">
            <p className="text-sm font-medium">{t('Tidslinjen är tom', 'The timeline is empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('Dina anteckningar visas här tillsammans med analyserna.', 'Your notes will appear here alongside the analysis.')}
            </p>
          </div>
        ) : (
          <div className="relative space-y-4 pl-6 before:absolute before:bottom-2 before:left-2 before:top-2 before:w-px before:bg-violet-200 dark:before:bg-violet-900">
            {notes.map((note) => (
              <div key={note.id} className="relative rounded-xl border border-border/70 bg-background/80 p-4">
                <span className="absolute -left-[1.55rem] top-5 h-3 w-3 rounded-full border-2 border-background bg-violet-600 ring-1 ring-violet-300 dark:ring-violet-800" />
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {dateFormatter.format(new Date(`${note.note_date}T00:00:00Z`))}
                    </p>
                    <h3 className="mt-1 text-sm font-medium">{note.title}</h3>
                  </div>
                  <div className="flex gap-1">
                    <Button type="button" size="icon" variant="ghost" onClick={() => editNote(note)} aria-label={t('Redigera', 'Edit')}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" onClick={() => void deleteNote(note)} aria-label={t('Ta bort', 'Delete')}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{note.details}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default EnergyHistoryTimeline;
