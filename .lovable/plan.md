
# Plan: Simplify Database Schema for B2C Model

## Overview
Merge the `customer_users` table into `customers` by adding a `user_id` column directly to the `customers` table. This removes the unnecessary join table and simplifies the data model for your B2C business where one authenticated user equals one customer.

## Phase 1: Database Schema Changes

### 1.1 Add user_id column to customers table
```sql
ALTER TABLE public.customers
ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL UNIQUE;
```

The UNIQUE constraint ensures one-to-one mapping between users and customers.

### 1.2 Migrate existing data
```sql
UPDATE public.customers c
SET user_id = cu.user_id
FROM public.customer_users cu
WHERE cu.customer_id = c.id;
```

### 1.3 Update get_customer_id_for_user() function
```sql
CREATE OR REPLACE FUNCTION public.get_customer_id_for_user(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id FROM public.customers WHERE user_id = _user_id LIMIT 1
$$;
```

This is the key change - all RLS policies already use this function, so they will automatically work with the new structure.

### 1.4 Update RLS policies on customers table
Add policy for users to view/update their own record by user_id:
```sql
-- Update SELECT policy
DROP POLICY IF EXISTS "Customers can view their own customer record" ON public.customers;
CREATE POLICY "Customers can view their own customer record"
ON public.customers FOR SELECT
USING ((user_id = auth.uid()) OR is_staff(auth.uid()));

-- Update UPDATE policy  
DROP POLICY IF EXISTS "Customers can update their own customer record" ON public.customers;
CREATE POLICY "Customers can update their own customer record"
ON public.customers FOR UPDATE
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());
```

### 1.5 Drop customer_users table
```sql
DROP TABLE IF EXISTS public.customer_users;
```

## Phase 2: Frontend Code Updates

### 2.1 Update AuthContext.tsx
Simplify the customer data fetching:

**Before:**
```typescript
const { data: customerUserData } = await supabase
  .from('customer_users')
  .select(`customer_id, role, customers (...)`)
  .eq('user_id', userId)
```

**After:**
```typescript
const { data: customerData } = await supabase
  .from('customers')
  .select('id, org_name, billing_email, phone, address, site_address')
  .eq('user_id', userId)
  .maybeSingle();
```

Also remove `customerRole` from context since it's no longer needed.

### 2.2 Update Contacts.tsx (Convert to Customer)
When converting a contact to a customer, we now need a way to link the user. Two options:

**Option A (Recommended):** Create customer record without user_id initially. Staff then invites the customer to create an account, which links their user_id.

**Option B:** Add an "Invite Customer" flow that creates the auth user and sends magic link.

For now, Option A is simpler - the customer record is created, and when the customer signs up with matching email, we can link them.

### 2.3 Update Login flow
Add logic to link newly authenticated users to existing customer records by matching email:
```typescript
// After successful login, check if customer exists with matching email
const { data: existingCustomer } = await supabase
  .from('customers')
  .select('id')
  .eq('billing_email', user.email)
  .is('user_id', null)
  .maybeSingle();

if (existingCustomer) {
  // Link user to existing customer record
  await supabase
    .from('customers')
    .update({ user_id: user.id })
    .eq('id', existingCustomer.id);
}
```

## Phase 3: Optional Cleanup (Rename Fields)

If desired, rename B2B-oriented fields to B2C-friendly names:
- `org_name` could become `name` or `display_name`
- Keep `billing_email` as-is (still relevant for invoicing)

This is optional and can be done later to minimize changes.

## Files to Modify

| File | Changes |
|------|---------|
| `supabase/migrations/` | New migration with all SQL changes |
| `src/contexts/AuthContext.tsx` | Simplify customer fetch, remove customerRole |
| `src/pages/portal/Login.tsx` | Add auto-linking logic for existing customers |
| `src/pages/portal/Contacts.tsx` | Remove customer_users insert (no longer needed) |
| `src/integrations/supabase/types.ts` | Auto-regenerated after migration |

## Rollback Plan
If issues arise, the migration can be reversed by:
1. Recreating the `customer_users` table
2. Repopulating it from `customers.user_id`
3. Reverting the `get_customer_id_for_user()` function

## Technical Notes

- All existing RLS policies on `tickets`, `invoices`, `ticket_comments`, and `ticket_attachments` will continue to work because they use the `get_customer_id_for_user()` function
- Edge functions don't need changes since they work with `customer_id` directly
- The storage bucket RLS also uses the helper function, so no changes needed
