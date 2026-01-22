

# Plan: Contact Form Database Storage & Contacts Management

## Overview
Store contact form submissions in the database and create a staff-only "Contacts" page to manage leads who haven't been converted to customers yet. Staff can convert contacts into customers with a single click.

---

## Database Changes

### 1. Create `contacts` Table
A new table to store all contact form submissions:

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `name` | text | Contact's name (required) |
| `email` | text | Contact's email (required) |
| `phone` | text | Phone number (optional) |
| `message` | text | Their initial message |
| `created_at` | timestamptz | When form was submitted |
| `converted_to_customer_id` | uuid | Links to `customers.id` when converted (null = still a contact) |
| `converted_at` | timestamptz | When they were converted |

### 2. Row-Level Security (RLS)
- **Staff-only access**: Only staff can SELECT, INSERT, UPDATE, and DELETE contacts
- Public form submissions go through an edge function using service role

---

## Edge Function Changes

### Update `send-contact-email`
Modify the existing function to:
1. Create a Supabase client using the service role key
2. Insert the contact data into the `contacts` table
3. Continue sending the email as before
4. Return success even if email fails (contact is still saved)

---

## Frontend Changes

### 1. New `Contacts` Page (`src/pages/portal/Contacts.tsx`)
Staff-only page similar to the Customers page:
- Title: "Kontakter" / "Contacts"
- Search field to filter by name, email, or phone
- Table columns: Namn (Name), E-post (Email), Telefon (Phone), Meddelande (Message), Datum (Date), Atgarder (Actions)
- Each row has a "Gör till kund" / "Convert to customer" button
- Only shows contacts where `converted_to_customer_id IS NULL`

### 2. Convert to Customer Flow
When clicking "Convert to customer":
1. Create a new record in the `customers` table using the contact's info:
   - `org_name` = contact's name (staff can edit later)
   - `billing_email` = contact's email
   - `phone` = contact's phone
2. Update the contact record with `converted_to_customer_id` and `converted_at`
3. Show success toast with link to view the new customer
4. Contact disappears from the Contacts list (filter excludes converted)

### 3. Add Navigation Item
Update `PortalLayout.tsx` to add "Kontakter" / "Contacts" to the staff navigation menu (with a `Contact2` or `UserPlus` icon from Lucide).

### 4. Add Route
Add `/portal/contacts` route to `App.tsx`.

---

## Technical Details

### Database Migration SQL

```sql
-- Create contacts table for form submissions
CREATE TABLE public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  converted_to_customer_id uuid REFERENCES public.customers(id),
  converted_at timestamptz
);

-- Enable RLS
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

-- Staff can do everything
CREATE POLICY "Staff can manage contacts"
  ON public.contacts FOR ALL
  USING (is_staff(auth.uid()))
  WITH CHECK (is_staff(auth.uid()));
```

### Edge Function Update
The function will use the Supabase service role to insert contacts (since form submissions are anonymous/public).

### UI Component Structure
```text
Contacts.tsx
├── PortalLayout wrapper
├── Title + Search input
└── Card with Table
    ├── TableHeader (Name, Email, Phone, Message, Date, Actions)
    └── TableBody
        └── Each contact row with "Convert" button
```

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `supabase/functions/send-contact-email/index.ts` | Modify - add database insert |
| `src/pages/portal/Contacts.tsx` | Create - new contacts list page |
| `src/components/portal/PortalLayout.tsx` | Modify - add nav item |
| `src/App.tsx` | Modify - add route |
| Database migration | Create - new contacts table |

---

## Security Considerations
- Contacts table is staff-only (RLS policies)
- Edge function uses service role for anonymous form submissions
- Input validation already exists in the contact form (Zod schema)
- HTML escaping already in place for email content

