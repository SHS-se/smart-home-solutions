-- Typed energy-history events.
--
-- Events already existed as a free-text note on a date, drawn on the charts and
-- used for a crude before/after comparison. That is not enough to *explain* the
-- data: a fortnight in Spain and a new heat pump both show up as a step in the
-- series, and only one of them means the building changed.
--
-- The distinction that matters computationally is step versus period:
--
--   * A **step change** (renovation, heat pump, solar, someone moving in) means
--     data before the date describes a different house or household. Comparing
--     across it is not like-for-like, and a rolling twelve-month window that
--     spans one is measuring two different buildings.
--   * A **period** (holiday, guests, broken heat pump) means those particular
--     days are unrepresentative. They should be excluded from anything that
--     fits a model, not silently averaged in.
--
-- `event_type` therefore is not decoration. It selects which of those two
-- treatments applies. See src/lib/energy-events.ts.

ALTER TABLE public.energy_history_notes
  ADD COLUMN event_type text NOT NULL DEFAULT 'other'
    CHECK (event_type IN (
      -- Step changes: everything after the date is a different baseline.
      'renovation',
      'heating_system_change',
      'solar_installed',
      'battery_installed',
      'major_load_added',
      'major_load_removed',
      'occupancy_increase',
      'occupancy_decrease',
      -- Periods: these days are unrepresentative and carry an end date.
      'absence',
      'guests',
      'equipment_fault',
      -- Anything else stays free-text and affects no calculation.
      'other'
    )),
  -- Inclusive last day, for period events. Null means a point/step event.
  ADD COLUMN end_date date,
  -- Forward compatibility with multi-home; energy history is still
  -- customer-scoped (ENERGY_OPTIMISATION_ARCHITECTURE.md §12).
  ADD COLUMN home_id uuid REFERENCES public.homes(id) ON DELETE CASCADE;

ALTER TABLE public.energy_history_notes
  ADD CONSTRAINT energy_history_notes_period_valid
    CHECK (end_date IS NULL OR end_date >= note_date);

-- A period event without an end date would silently behave as a single day,
-- which is the difference between excluding one day and excluding a fortnight.
ALTER TABLE public.energy_history_notes
  ADD CONSTRAINT energy_history_notes_period_has_end
    CHECK (
      event_type NOT IN ('absence', 'guests', 'equipment_fault')
      OR end_date IS NOT NULL
    );

-- Step events describe an instant, not a span.
ALTER TABLE public.energy_history_notes
  ADD CONSTRAINT energy_history_notes_step_has_no_end
    CHECK (
      event_type IN ('absence', 'guests', 'equipment_fault', 'other')
      OR end_date IS NULL
    );

CREATE INDEX idx_energy_history_notes_customer_type
  ON public.energy_history_notes (customer_id, event_type, note_date);

COMMENT ON COLUMN public.energy_history_notes.event_type IS
  'Selects how the event is treated in analysis: step changes invalidate '
  'comparison across the date, periods exclude their days from model fitting. '
  'See src/lib/energy-events.ts.';
COMMENT ON COLUMN public.energy_history_notes.end_date IS
  'Inclusive last day for period events. Null for step and point events.';
