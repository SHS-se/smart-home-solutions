

# Consolidate Duplicated Portal Pages

## Summary
Merge 7 duplicated page pairs into single components that serve both customer and staff views, using layout/auth wrappers to handle the differences.

## Strategy
Create a lightweight wrapper pattern: each route gets a thin wrapper that resolves `customerId`, `isStaffView`, and the correct layout component, then passes them to the shared page component.

---

## 1. HomeProfile (merge into one)

**File**: Keep `src/pages/portal/HomeProfile.tsx` as the shared component.
**Delete**: `src/pages/portal/customer-view/CustomerViewHomeProfile.tsx`

Changes to `HomeProfile.tsx`:
- Accept optional `customerId` and `isStaffView` props
- When `isStaffView`: use `CustomerViewLayout`, show back-link and customer name subtitle
- When customer: use `PortalLayout`, show dismissible info banner
- Home resolution logic already exists in `HomeProfile.tsx` (the more complete version with auto-creation)

**Route wiring**: Staff route wraps `HomeProfile` with `customerId` from `useViewedCustomer()`.

---

## 2. EnergyModeling (merge into one)

**File**: Keep `src/pages/portal/EnergyModeling.tsx` as the shared component.
**Delete**: `src/pages/portal/customer-view/CustomerViewEnergyModeling.tsx`

Changes to `EnergyModeling.tsx`:
- Accept optional `customerId` prop override
- When staff views a customer: use `CustomerViewLayout`, show customer-specific tabs (ROI, Home Setup, etc.)
- When staff views `/portal/energy-modeling` directly (no customer): show staff-only tabs (Device Templates, Calibration) -- this behavior already exists
- When customer views: use `PortalLayout`, show customer tabs -- already exists

---

## 3. Account (merge, keep CustomerViewAccount logic)

**File**: Create new shared `src/pages/portal/Account.tsx` combining both.
**Delete**: `src/pages/portal/customer-view/CustomerViewAccount.tsx`

Key difference: `CustomerViewAccount` updates both `customers` and `contacts` tables (via `contact_id`), while `Account.tsx` only updates `customers`. The merged version will use the more complete CustomerViewAccount logic for save, and add the `billing_email` field for customer self-view. Staff view shows name/email/phone from contact; customer view shows `billing_email` instead.

---

## 4. TicketsList (keep TicketsList.tsx, delete CustomerViewTickets)

**File**: Keep `src/pages/portal/TicketsList.tsx` (already handles both staff and customer via `isStaff` checks).
**Delete**: `src/pages/portal/customer-view/CustomerViewTickets.tsx`

`TicketsList.tsx` already:
- Shows customer column only for staff
- Filters by `customer_id` for non-staff
- Has sortable headers, search icon, subscription gating

Changes: When used in staff customer-view, pass `customerId` to scope the query. Wrap with `CustomerViewLayout` instead of `PortalLayout`.

---

## 5. Billing (keep Billing.tsx, delete CustomerViewBilling)

**File**: Keep `src/pages/portal/Billing.tsx` (much more complete).
**Delete**: `src/pages/portal/customer-view/CustomerViewBilling.tsx`

Changes to `Billing.tsx`:
- Accept optional `customerId` and `isStaffView` props
- When `isStaffView`: use `CustomerViewLayout`, hide subscription management card (staff should not manage customer subscriptions), show invoices only
- When customer: show full page (subscription + invoices) as-is
- Remove the existing "staff accounts don't have billing" guard, replace with staff-customer-view mode

---

## 6. Offers (replace Offers.tsx with CustomerViewOffers logic)

**File**: Rewrite `src/pages/portal/Offers.tsx` with the more complete `CustomerViewOffers` logic.
**Delete**: `src/pages/portal/customer-view/CustomerViewOffers.tsx`

`CustomerViewOffers` is more feature-rich:
- Shows all statuses including draft, cancelled, superseded (staff needs these)
- Has search by quote number or project name
- Shows version badges and "old" indicators
- Uses `getQuoteStatusBadge` shared utility

Changes:
- Accept optional `customerId` and `isStaffView` props
- Customer view: filter out draft/cancelled/superseded (current Offers.tsx behavior) 
- Staff view: show all statuses, use `CustomerViewLayout`
- Navigation: customer goes to `/portal/offers/:id`, staff goes to `/portal/customers/:id/offers/:id`

---

## 7. TicketDetail (replace TicketDetail.tsx with CustomerViewTicketDetail logic)

**File**: Rewrite `src/pages/portal/TicketDetail.tsx` using the more complete `CustomerViewTicketDetail` logic.
**Delete**: `src/pages/portal/customer-view/CustomerViewTicketDetail.tsx`

Key differences to handle:
- **Status default after reply**: Staff defaults to `awaiting_customer`, Customer defaults to `awaiting_response` (opposite of logged-in user role)
- **Author type**: Staff always posts as `staff`, Customer always posts as `customer`
- **Subscription gating**: Customer view checks subscription before allowing replies; staff always can reply
- **Back link**: Staff goes to `/portal/customers/:id/tickets`, Customer goes to `/portal/tickets`
- **Close ticket**: Both can close, but customer view in TicketDetail gates behind subscription

---

## Route Changes in App.tsx

Staff customer-view routes will use thin wrapper components that:
1. Pull `customerId` from URL params via `useViewedCustomer()`
2. Pass `isStaffView={true}` and `customerId` to the shared component
3. Wrap in `CustomerViewWrapper` (for `ViewedCustomerProvider`)

Example pattern:
```text
/portal/billing        -> <Billing />                    (customer mode)
/portal/customers/:id/billing -> <CustomerViewWrapper><BillingStaffView /></CustomerViewWrapper>
```

Where `BillingStaffView` is a ~5-line wrapper:
```typescript
const BillingStaffView = () => {
  const { customerId } = useViewedCustomer();
  return <Billing customerId={customerId} isStaffView />;
};
```

---

## Files Created
- Small wrapper components in `src/pages/portal/customer-view/` (one per merged page, ~5-10 lines each) that just pass props

## Files Deleted
- `CustomerViewHomeProfile.tsx`
- `CustomerViewEnergyModeling.tsx`  
- `CustomerViewAccount.tsx`
- `CustomerViewTickets.tsx`
- `CustomerViewBilling.tsx`
- `CustomerViewOffers.tsx`
- `CustomerViewTicketDetail.tsx`

These get replaced by thin wrappers that import the shared page.

## Risk Mitigation
- Each merged page will check `isStaffView` for layout, auth guards, navigation links, and role-specific features
- The "Status efter svar" default will explicitly use `isStaff` to pick the opposite status
- Subscription gating only applies to customer view (not staff)
- Back-links differ by context (staff goes to customer view, customer goes to portal root)

