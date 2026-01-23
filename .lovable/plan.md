
# Capture Sales Email Conversations for Contacts

## Overview
Implement the same bidirectional email sync pattern used for support tickets, but for sales/contact inquiries. All replies (from both staff and leads) flow through `sales+token@mail.smarthomesolutions.se`, ensuring complete conversation history is captured in the database.

---

## How It Will Work

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CONTACT FORM SUBMISSION                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  Lead fills out contact form                                                │
│         ↓                                                                   │
│  send-contact-email function:                                               │
│    • Stores contact + initial message in DB                                 │
│    • Sends email to sales@smarthomesolutions.se                             │
│    • Reply-To: sales+<token>@mail.smarthomesolutions.se                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                            STAFF REPLIES                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  Staff clicks Reply in email client                                         │
│         ↓                                                                   │
│  Email goes to sales+<token>@mail.smarthomesolutions.se                     │
│         ↓                                                                   │
│  sales-inbound-webhook:                                                     │
│    • Verifies signature, extracts token                                     │
│    • Stores staff reply in contact_messages                                 │
│    • Sends notification to lead's email                                     │
│    • Reply-To: sales+<token>@mail.smarthomesolutions.se                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                            LEAD REPLIES                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  Lead clicks Reply in their email client                                    │
│         ↓                                                                   │
│  Email goes to sales+<token>@mail.smarthomesolutions.se                     │
│         ↓                                                                   │
│  sales-inbound-webhook:                                                     │
│    • Verifies signature, extracts token                                     │
│    • Stores lead reply in contact_messages                                  │
│    • Sends notification to sales@smarthomesolutions.se                      │
│    • Reply-To: sales+<token>@mail.smarthomesolutions.se                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Steps

### Step 1: Database Schema Changes

**Add `email_token` to contacts table:**
```sql
ALTER TABLE public.contacts
ADD COLUMN email_token text NOT NULL DEFAULT encode(extensions.gen_random_bytes(16), 'hex');

CREATE UNIQUE INDEX contacts_email_token_idx ON public.contacts(email_token);
```

**Create `contact_messages` table:**

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| contact_id | uuid | Foreign key to contacts |
| body | text | Message content |
| author_type | text | 'lead' or 'staff' |
| author_email | text | Sender's email address |
| source | text | 'form', 'email', or 'portal' |
| created_at | timestamp | When message was sent |

RLS policies restrict access to staff users only.

### Step 2: Update send-contact-email Function

Modify to:
- Query the newly created contact record to get its `email_token`
- Use tokenized Reply-To: `sales+<token>@mail.smarthomesolutions.se`
- Store the initial form submission as first entry in `contact_messages` with `source: 'form'`
- Include contact name in subject for threading: `Contact inquiry: <Name>`

### Step 3: Create sales-inbound-webhook Edge Function

New function (modeled after `inbound-email-webhook`) that:
- Handles OPTIONS for CORS
- Verifies Resend webhook signatures using RESEND_SIGNING_SECRET
- Extracts token from `sales+<token>@...` recipient address
- Fetches full email content from Resend API
- Looks up contact by email_token
- Determines author_type based on sender email:
  - If sender matches contact's email → `author_type: 'lead'`
  - Otherwise → `author_type: 'staff'`
- Stores message in `contact_messages`
- Sends notification to the "other party":
  - If lead replied → notify staff (sales@smarthomesolutions.se)
  - If staff replied → notify lead
- Uses same Reply-To token for continued threading

### Step 4: Update ContactDetail Page

Enhance to display conversation history:
- Fetch all messages from `contact_messages` ordered by created_at
- Display in a threaded view similar to ticket comments
- Show author (lead/staff), timestamp, and source indicator
- Style messages differently based on author_type (like ticket comments)
- The original form message appears as the first entry

### Step 5: Add Portal Reply Capability

Allow staff to reply from the ContactDetail page:
- Add a reply form (textarea + send button)
- On submit:
  - Store message in `contact_messages` with `source: 'portal'`
  - Send email to lead via Resend
  - Reply-To: `sales+<token>@mail.smarthomesolutions.se`
- This provides an alternative to email replies

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| Database migration | Create | Add email_token to contacts, create contact_messages table |
| `supabase/functions/send-contact-email/index.ts` | Modify | Add tokenized Reply-To, store initial message |
| `supabase/functions/sales-inbound-webhook/index.ts` | Create | Handle inbound sales emails, store + forward |
| `src/pages/portal/ContactDetail.tsx` | Modify | Display message thread, add reply form |
| `src/integrations/supabase/types.ts` | Auto-update | Will regenerate after migration |

---

## Resend Configuration Required

You'll need to configure Resend to forward emails sent to `sales+*@mail.smarthomesolutions.se` to the new webhook:

1. In Resend dashboard → Webhooks
2. Add new webhook endpoint: `https://ouxqcdtspedbwpceemfc.supabase.co/functions/v1/sales-inbound-webhook`
3. Enable the `email.received` event

The same RESEND_SIGNING_SECRET used for support emails will work for verifying these webhooks.

---

## Technical Details

### Email Subject Threading
- Initial inquiry: `Contact inquiry: <Name>`
- All replies maintain this subject (email clients auto-thread)

### Author Type Detection
```typescript
// In sales-inbound-webhook
const isFromLead = senderEmail.toLowerCase() === contact.email.toLowerCase();
const authorType = isFromLead ? 'lead' : 'staff';
const notifyEmail = isFromLead 
  ? (Deno.env.get("CONTACT_TO") || "sales@smarthomesolutions.se")
  : contact.email;
```

### Security
- Webhook signature verification (same as support webhook)
- RLS policies on contact_messages (staff only)
- HTML escaping for email content (prevent XSS)
