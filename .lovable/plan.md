

# Derived "Scope Change Requested" Indicator on BOMs List

## Overview

Add a warning badge next to the version pill on the BOMs list page that appears when a customer has requested a revision on a quote linked to that specific BOM version. This is purely derived from quote data -- no status column is added to the `boms` table.

## Approach: Client-Side Supplementary Query

Rather than creating a database view (which would require changing the entire BOM fetch query and losing the existing customer join pattern), we'll use a lightweight supplementary query that fetches all `(bom_id, bom_version, quote_id)` tuples where the quote status is `revision_requested`. This keeps the main BOM query untouched and is simple to implement.

The supplementary query runs once alongside the BOM list fetch and returns a small result set (only matching rows). We then build a lookup map in the component.

## Changes

### 1. Supplementary Query (in BOMsList.tsx)

Add a second `useQuery` that fetches the scope-change data:

```typescript
const { data: scopeChangeMap = new Map() } = useQuery({
  queryKey: ['bom-scope-change-flags'],
  queryFn: async () => {
    const { data, error } = await supabase
      .from('quotes')
      .select('bom_id, bom_version, id')
      .eq('status', 'revision_requested')
      .not('bom_id', 'is', null);
    if (error) throw error;
    // Build a map: "bomId:version" -> quote id
    const map = new Map<string, string>();
    for (const row of data) {
      const key = `${row.bom_id}:${row.bom_version}`;
      if (!map.has(key)) map.set(key, row.id);
    }
    return map;
  },
  enabled: isStaff,
});
```

### 2. Badge Rendering (in the Version TableCell)

Update the Version column cell to show the scope-change badge when the condition is met. The badge will:

- Use the same amber warning style as the "Revision requested" quote badge (`bg-amber-500/20 text-amber-700`)
- Be clickable, navigating to the relevant quote
- Have a tooltip explaining the action needed
- Display text: "Omfattningsandring begard" (Swedish) / "Scope change requested" (English)

```text
Before:
  [v1]

After (when flag is true):
  [v1] [Omfattningsandring begard]
```

### 3. UI Details

- Import `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider` from existing UI components
- The badge click handler calls `e.stopPropagation()` (to prevent the row click) and navigates to `/portal/quotes/{quoteId}`
- Tooltip text: "Kunden har begart andringar. Skapa en ny BOM-revision for att uppdatera omfattningen."

### 4. BOM Interface Update

No changes needed to the `BOM` interface -- the scope-change data comes from a separate Map lookup, not from the BOM object itself.

## File Modified

- `src/pages/portal/boms/BOMsList.tsx` -- add supplementary query, tooltip imports, and badge rendering in the version column

## No Database Migration Needed

This approach uses only an additional `SELECT` query against the existing `quotes` table. No views, functions, or schema changes are required.

