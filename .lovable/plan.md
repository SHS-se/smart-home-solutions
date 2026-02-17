# Show Subscription Status for Staff + Add Invoice Search/Filter

## Overview

Two changes to the Billing page:

1. Show the subscription status card when staff views a customer's billing page (read-only, no manage/checkout buttons)
2. Add a search and filter bar above the invoices table, matching the Quotes page pattern

---

## 1. Subscription Status for Staff View

### Problem

The `check-subscription` edge function currently uses the **logged-in user's email** to look up Stripe. When staff views a customer's billing page, it checks the staff's own subscription -- not the customer's.

### Solution

- Modify the `check-subscription` edge function to accept an optional `customer_id` in the request body
- When provided, verify the caller is staff (via a `contacts` table lookup with `is_staff = true`), then look up the customer's `billing_email` or `email` from the `customers` table to query Stripe
- On the frontend, when `isStaffView` is true, call `check-subscription` with the customer's ID
- Show the subscription card but **without** the "Manage subscription", "Resume subscription", or "Subscribe now" buttons
- The card will be read-only: just the status badge (Active / Cancels / No subscription), renewal date, and price

### Edge Function Changes (`supabase/functions/check-subscription/index.ts`)

- Accept optional `customer_id` from request body
- If `customer_id` is provided:
  - Verify caller is staff by checking `contacts.is_staff`
  - Look up customer email from `customers` table
  - Use that email for the Stripe lookup instead of the auth user's email
- If not provided: existing behavior (use auth user's email)

### Frontend Changes (`src/pages/portal/Billing.tsx`)

- Remove the `if (isStaffView) { setSubscriptionLoading(false); return; }` early exit in `checkSubscription()`
- When `isStaffView`, pass `{ customer_id: resolvedCustomerId }` to the edge function call
- Change the subscription card from `{!isStaffView && (...)}` to always render
- Inside the card, hide the checkout/manage buttons when `isStaffView`
- Adjust the card description text for staff ("Kundens prenumerationsstatus" / "Customer's subscription status")

---

## 2. Invoice Search and Filter Bar

### Pattern

Match the existing Quotes page: a search input + a dropdown filter, placed between the card header and the table.

### Filter Options

- **Visa alla** / Show all (standard): no status filter (only staff should see invoices in all states incl `draft`and `void.`Customers should only see `open`, `paid`, `overdue`)
- `open`
- `paid`
- `overdue`
- `void`(staff only)
- `draft`(staff only)
  &nbsp;

### Search

- Search by invoice number (text match)
- Client-side filtering on the already-fetched invoices array

### Frontend Changes (`src/pages/portal/Billing.tsx`)

- Add `searchQuery` and `viewFilter` state variables
- Add a `filteredInvoices` memo that applies status filter + search before sorting
- Update `sortedInvoices` to sort `filteredInvoices` instead of raw `invoices`
- Add the search input + select dropdown UI between the CardHeader and the table, matching the Quotes page layout (Search icon, `pl-9`, `max-w-md`, select with `w-[200px]`)

---

## Technical Details

### Files Modified

- `supabase/functions/check-subscription/index.ts` -- add optional `customer_id` param with staff verification
- `src/pages/portal/Billing.tsx` -- subscription card visibility, search/filter UI and logic

### No New Files Created