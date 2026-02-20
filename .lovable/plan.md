
# Automatic Quote Expiry and Reissue Flow

## Summary

This plan implements two interconnected features: (1) a daily cron job that automatically expires quotes past their `expires_at` date, and (2) a reissue flow on the staff quote page that lets staff create a new draft quote from an expired one, marking the old quote as superseded.

No new database columns are needed -- all existing fields (`expires_at`, `supersedes_quote_id`, `superseded_by_quote_id`, `superseded_at`, `is_latest`, `status_reason`) are used.

---

## 1. Edge Function: `expire-quotes` (Daily Cron)

**New file**: `supabase/functions/expire-quotes/index.ts`

- Uses service role key (no auth header needed since triggered by cron)
- Selection criteria:
  - `expires_at IS NOT NULL`
  - `expires_at < now()`
  - `status IN ('sent', 'viewed', 'revision_requested')`
- Action per matched quote:
  - `status = 'expired'`
  - `status_reason = 'auto_expired'`
- Logs count of updated rows
- Idempotent: running multiple times has no effect on already-expired quotes
- Returns JSON with count of expired quotes

**Cron schedule** (via `pg_cron` + `pg_net`):
- Runs daily at 02:00 UTC (03:00 CET)
- Calls the edge function via `net.http_post`
- Will be set up using the insert tool (not migration) since it contains project-specific URLs and keys

**Config**: Add `[functions.expire-quotes]` with `verify_jwt = false` to `supabase/config.toml`

---

## 2. Staff Quote Page: Expiry Display and Reissue Modal

**Modified file**: `src/pages/portal/quotes/QuotePreparation.tsx`

### 2a. Validity section update (sidebar, lines ~976-1001)

Current behavior: shows "Giltig till {date}" for non-editable quotes.

New behavior when `status === 'expired'`:
- Show: **Giltig till {date}** followed by a red **Utgangen** (Expired) badge/button
- The badge is clickable and keyboard-accessible (`role="button"`, `tabIndex={0}`)
- Clicking opens the reissue modal

For all other non-draft statuses: unchanged display.

### 2b. Reissue modal (new dialog in same file)

- State: `showReissueDialog`, `reissueDate`, `isReissuing`
- Title: "Ge ut offert pa nytt" / "Reissue quote"
- Description: explains that a new quote with a new number will be created, and the old one will be marked superseded
- Date picker: defaults to today + 14 days
- Cancel / "Skapa ny offert" / "Create new quote" buttons
- Loading state with spinner, double-submit prevention

### 2c. Reissue backend logic (client-side, reuses existing patterns from `use-quote-versioning.ts`)

On confirm:
1. Load current quote (all fields)
2. Find root quote ID via `parent_quote_id`
3. Compute `newVersion` (max version in family + 1)
4. Mark all quotes in family as `is_latest = false`
5. Insert new quote:
   - Copy: `customer_id`, `bom_id`, `bom_version`, `created_by`, `is_test`
   - Set: `status = 'draft'`, `expires_at = selected_date (end of day)`, `supersedes_quote_id = old_quote.id`, `parent_quote_id = rootId`, `version = newVersion`, `is_latest = true`
   - Do NOT copy: `quote_number` (auto-assigned by trigger), timestamps, invoice fields, acceptance fields, token fields
6. Clone all `quote_lines` from old quote to new quote (same logic as `createNewVersion` in `use-quote-versioning.ts`)
7. Update old quote: `status = 'superseded'`, `superseded_by_quote_id = new_quote.id`, `superseded_at = now()`, `is_latest = false`
8. If BOM exists, call `supersedeActiveQuotesInChain` for safety
9. Insert `quote_events`: "reissued" event on old quote, "created" event on new quote
10. Navigate to new quote: `/portal/quotes/{newQuoteId}`
11. Invalidate query caches

---

## 3. Button Rules (already mostly correct)

- "Send quote via email" (`canSend`): already gated on `draft` or `revision_requested` -- no change needed
- "Create Invoice" (`canCreateInvoice`): already gated on `accepted` -- no change needed
- Expired and superseded quotes are already non-editable via `isEditable` logic

---

## 4. Traceability Banners

**Modified file**: `src/pages/portal/quotes/QuotePreparation.tsx`

- Existing superseded banner already links to `superseded_by_quote_id` -- no change needed
- Add a new banner for quotes that supersede another: "Denna offert ersatter {old_quote_number}" with a link to the old quote. Shown when `supersedes_quote_id` is set and the current quote is NOT superseded itself.

---

## 5. Edge Cases Handled

- Draft quotes with past `expires_at`: cron only targets `sent`, `viewed`, `revision_requested` -- drafts are safe
- Duplicate reissue prevention: the reissue button only appears when `status === 'expired'`; once reissued, the old quote becomes `superseded` and can no longer be reissued
- Already-superseded quotes with `superseded_by_quote_id`: the superseded banner already redirects to the newer quote
- Chains (Q1 -> Q2 -> Q3): `parent_quote_id` always points to root, `supersedes_quote_id` points to the immediate predecessor, `is_latest` is maintained correctly

---

## 6. Customer-Facing Page (OfferDetail.tsx)

- Already shows expiry date and status badge
- Expired status badge already exists in `quote-status-badge.tsx`
- No customer-facing reissue action needed (staff only)
- No changes required

---

## Technical Details: File Changes Summary

| File | Action |
|------|--------|
| `supabase/functions/expire-quotes/index.ts` | **Create**: daily cron edge function |
| `supabase/config.toml` | Auto-updated: add `verify_jwt = false` for expire-quotes |
| `src/pages/portal/quotes/QuotePreparation.tsx` | **Modify**: add expired badge+link in validity section, reissue modal and logic, "supersedes" banner |
| Cron job SQL (via insert tool) | **Create**: `pg_cron` schedule calling the edge function daily |
