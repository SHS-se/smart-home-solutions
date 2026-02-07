

# BOM Version Grouping & UX Improvements

## Completed

### 1. Database: `bom_group_id` column
- Added `bom_group_id` (uuid, NOT NULL, default gen_random_uuid()) to `boms` table
- Backfilled existing rows: BOMs sharing (customer_id, project_name) get the same group id (earliest BOM's id)
- Indexed for efficient lookups

### 2. BOM List Page (`/portal/boms`)
- Default view shows only the latest revision per `bom_group_id`
- Filter dropdown: "Senaste (standard)" / "Alla versioner"
- Scope-change badge still works on the latest revision row

### 3. BOM Detail Page (BOM Builder)
- Version pill replaced with interactive `BOMVersionSelector` popover
- Lists all revisions in the chain with dates and lock status
- Clicking a revision navigates to that BOM's detail page

### 4. Revision Creation
- New BOM revisions inherit `bom_group_id` from parent BOM
- Ensures all revisions in a chain share the same group identifier
