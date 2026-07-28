ALTER TABLE public.energy_history_notes
  ADD COLUMN event_text text;

UPDATE public.energy_history_notes
SET event_text = CASE
  WHEN details = title THEN title
  ELSE title || E'\n' || details
END;

ALTER TABLE public.energy_history_notes
  ALTER COLUMN event_text SET NOT NULL,
  ADD CONSTRAINT energy_history_notes_event_text_check CHECK (
    event_text = btrim(event_text)
    AND char_length(event_text) BETWEEN 1 AND 4000
  ),
  DROP COLUMN title,
  DROP COLUMN details;
