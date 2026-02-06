

# BOM Locking and Revision Workflow

## Overview

This plan implements a robust BOM versioning workflow where BOM versions become read-only (locked) once a quote derived from them has been sent, viewed, or accepted. Staff can always create a new BOM revision to make scope changes, with a required reason for audit purposes.

## Database Changes

### 1. Add revision audit columns to `boms` table

Add four new nullable columns to track why and by whom a revision was created:

- `revision_reason_type` (text, nullable) -- dropdown value
- `revision_reason_note` (text, nullable) -- optional free-text
- `revision_created_by` (uuid, nullable) -- staff user who created the revision
- `revision_created_at` (timestamptz, nullable) -- when the revision was created

### 2. Create `bom_events` table

A new audit log table for BOM-level events:

- `id` (uuid, PK, default gen_random_uuid())
- `bom_id` (uuid, FK to boms.id, NOT NULL)
- `event_type` (text, NOT NULL) -- e.g. 'revision_created'
- `actor_email` (text, nullable)
- `actor_type` (text, nullable) -- e.g. 'staff'
- `metadata` (jsonb, nullable) -- stores reason_type, reason_note, from_version, to_version
- `created_at` (timestamptz, default now())

RLS: staff-only access (matching the pattern used by `quote_events`).

## UI and Logic Changes (BOMBuilder.tsx)

### 3. Locked state detection

Add a new query to check if the current BOM version is locked. A BOM is locked when any quote exists with:

```
quote.bom_id = bom.id
AND quote.bom_version = bom.version
AND quote.status IN ('sent', 'viewed', 'accepted')
```

This query runs alongside the existing BOM data fetch.

### 4. Locked BOM banner

When the BOM is locked, display an alert banner at the top:

> "Denna BOM-version ar last eftersom en offert har skickats. Skapa en ny BOM-revision for att gora andringar."

### 5. Disable editing when locked

When locked:
- The "Add SKU", "Add from template" buttons become disabled
- The customer selector and project name editing become disabled
- Quantity inputs become read-only
- Delete (trash) buttons on items are hidden/disabled
- "Save changes" button is disabled

### 6. "Save changes" button behavior

- Enabled only when BOM is **unlocked** AND there are unsaved quantity changes
- Disabled when BOM is locked (no changes possible)

### 7. "Create new BOM revision" button behavior

- **Disabled** when BOM is NOT locked, with tooltip: "Skapa BOM-revision forst efter att en offert har skickats till kunden."
- **Enabled** when BOM IS locked
- On click: opens a modal dialog (not the current simple AlertDialog) with:
  - Required dropdown for reason type with these options:
    - Kundonskernal (telefon)
    - Kundonskernal (e-post)
    - Kundonskernal (portal)
    - Intern korrigering
    - Projektering / teknisk andring
    - Annat
  - Optional free-text note field
  - "Create revision" button (disabled until reason is selected)

### 8. Create revision logic

When creating a new BOM revision:

1. Insert a new `boms` row with:
   - Same `project_name` and `customer_id`
   - `version` = current version + 1
   - `revision_reason_type` = selected reason
   - `revision_reason_note` = optional note
   - `revision_created_by` = current user id
   - `revision_created_at` = now()

2. Copy all `bom_items` from the locked BOM to the new BOM

3. Insert a `bom_events` row with:
   - `event_type` = 'revision_created'
   - `metadata` = { reason_type, reason_note, from_version, to_version, source_bom_id }

4. Navigate to the new BOM revision

### 9. New revision banner

After navigating to a newly created revision (detected by `revision_reason_type` being non-null), show an info banner:

> "Ny BOM-revision skapad. Uppdatera omfattningen och skapa sedan en ny offertrevision."

### 10. Existing dialog replacement

The current simple `AlertDialog` for "Create new BOM revision?" is replaced by a full `Dialog` containing the reason form. The old dialog is removed.

## Technical Details

### Migration SQL

```sql
-- Add revision audit columns to boms
ALTER TABLE public.boms ADD COLUMN IF NOT EXISTS revision_reason_type text;
ALTER TABLE public.boms ADD COLUMN IF NOT EXISTS revision_reason_note text;
ALTER TABLE public.boms ADD COLUMN IF NOT EXISTS revision_created_by uuid;
ALTER TABLE public.boms ADD COLUMN IF NOT EXISTS revision_created_at timestamptz;

-- Create bom_events table
CREATE TABLE IF NOT EXISTS public.bom_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id uuid NOT NULL REFERENCES public.boms(id),
  event_type text NOT NULL,
  actor_email text,
  actor_type text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS for bom_events (staff only)
ALTER TABLE public.bom_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can read bom_events"
  ON public.bom_events FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can insert bom_events"
  ON public.bom_events FOR INSERT
  TO authenticated
  WITH CHECK (public.is_staff(auth.uid()));
```

### Locked state query

```typescript
const { data: isLocked } = useQuery({
  queryKey: ['bom_locked', id, bom?.version],
  queryFn: async () => {
    const { count } = await supabase
      .from('quotes')
      .select('id', { count: 'exact', head: true })
      .eq('bom_id', id!)
      .eq('bom_version', bom!.version)
      .in('status', ['sent', 'viewed', 'accepted']);
    return (count ?? 0) > 0;
  },
  enabled: !!id && !!bom,
});
```

### Files modified

- `src/pages/portal/boms/BOMBuilder.tsx` -- all UI and logic changes (locked state, banners, modal, disabled controls)
- New migration file for schema changes

### No other files affected

The changes are fully contained in the BOM Builder page and the database schema. No edge functions or other pages need modification.

