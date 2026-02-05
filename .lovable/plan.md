
# Plan: Manual Save Button for BOM Builder

## Overview
Replace the automatic save/debounce functionality with explicit manual saving. Users will click a "Save" button to persist changes, and the "Create quote from BOM" button will only be enabled when there are no unsaved changes.

## Current State
- `QuantityInput` commits on blur/Enter, triggering immediate mutations
- A `pendingMutationsRef` tracks changes for flush-before-navigate patterns
- `flushPendingMutations` is called before creating a quote

## Proposed Changes

### 1. Add State Tracking for Unsaved Changes
- Add `localItems` state to hold the working copy of items with edits
- Add `hasUnsavedChanges` computed value comparing local items to server items
- Remove the `pendingMutationsRef` and `queueItemUpdate` pattern

### 2. Modify QuantityInput Usage
- Instead of committing on blur, update only the local state
- No database mutations occur until user clicks "Save"

### 3. Add Save Button
- Position below the "Create quote from BOM" button
- Disabled (greyed out) when `hasUnsavedChanges === false`
- On click: batch-update all changed items to the database

### 4. Modify "Create quote from BOM" Button
- Disabled when `hasUnsavedChanges === true`
- Only enabled when all changes have been saved

### 5. Visual Feedback
- Consider showing unsaved indicator on rows that have changed (optional enhancement)

## Technical Details

**New State:**
```typescript
const [localQuantities, setLocalQuantities] = useState<Record<string, number>>({});
```

**Derived State:**
```typescript
const hasUnsavedChanges = useMemo(() => {
  return items.some(item => 
    localQuantities[item.id] !== undefined && 
    localQuantities[item.id] !== item.quantity
  );
}, [items, localQuantities]);
```

**Save Handler:**
```typescript
const handleSaveChanges = async () => {
  const updates = Object.entries(localQuantities)
    .filter(([itemId, qty]) => {
      const item = items.find(i => i.id === itemId);
      return item && item.quantity !== qty;
    });
  
  await Promise.all(
    updates.map(([itemId, quantity]) =>
      supabase.from('bom_items').update({ quantity }).eq('id', itemId)
    )
  );
  
  setLocalQuantities({});
  queryClient.invalidateQueries({ queryKey: ['bom_items', id] });
};
```

**Button Placement (in summary sidebar):**
1. "Save Changes" button (disabled when no changes)
2. "Create quote from BOM" button (disabled when there ARE changes)

## Files to Modify
- `src/pages/portal/boms/BOMBuilder.tsx` - Main changes

## Summary
- Remove auto-save/debounce on quantity changes
- Track changes in local state only
- Add "Save" button that's enabled only when changes exist
- "Create quote from BOM" is only enabled when no pending changes
