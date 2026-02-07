

# Reset Live Database for Deployment

## Current State (Live)
- **invoices**: 11 rows
- **invoice_line_items**: 24 rows
- **invoice_events**: 55 rows
- **quotes**: 14 rows
- **quote_lines**: 55 rows
- **billing_events**: 9 rows
- **quote_emails**: 0 rows

## What You Need To Do

Since I cannot modify Live data directly, you need to run the following SQL in **Cloud View > Run SQL** with the **Live** environment selected.

The statements must be run in this order due to dependencies (child tables first):

```sql
-- 1. Clear child/event tables first
DELETE FROM invoice_events;
DELETE FROM invoice_line_items;
DELETE FROM billing_events;
DELETE FROM quote_emails;
DELETE FROM quote_lines;

-- 2. Clear parent tables
DELETE FROM invoices;
DELETE FROM quotes;
```

## After Publishing (new schema)

Once you publish (which will create the `document_sequences`, `quote_events`, and `quote_messages` tables in Live), you should also run:

```sql
-- Reset the quote sequence counter so numbering starts fresh
UPDATE document_sequences SET next_value = 1 WHERE key = 'quote';

-- Clear any data in newly-created tables (if needed)
DELETE FROM quote_events;
DELETE FROM quote_messages;
```

## Summary
- Step 1: Run the first SQL block in Cloud View (Live) to clear existing billing data
- Step 2: Publish the project to sync schema changes to Live
- Step 3: Run the second SQL block in Cloud View (Live) to reset sequences and clear new tables

