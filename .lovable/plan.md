
# Change From Address from "noreply" to "replyonly"

## Overview
Update the sender email address in all outbound emails from `noreply@mail.smarthomesolutions.se` to `replyonly@mail.smarthomesolutions.se`. This unconventional but clever naming signals that:
- Replies to emails **do work** (via tokenized Reply-To addresses)
- Directly initiating emails to this address won't get a response

---

## Files to Update

| File | Current | New |
|------|---------|-----|
| `supabase/functions/send-contact-email/index.ts` | `noreply@mail...` | `replyonly@mail...` |
| `supabase/functions/send-sales-reply/index.ts` | `noreply@mail...` | `replyonly@mail...` |
| `supabase/functions/sales-inbound-webhook/index.ts` | `noreply@mail...` | `replyonly@mail...` |
| `supabase/functions/ticket-notification/index.ts` | `noreply@mail...` | `replyonly@mail...` |
| `supabase/functions/invite-customer/index.ts` | `noreply@mail...` | `replyonly@mail...` |

---

## Change Details

Each file will have the from address updated:

**Before:**
```typescript
from: "Smart Home Solutions <noreply@mail.smarthomesolutions.se>",
```

**After:**
```typescript
from: "Smart Home Solutions <replyonly@mail.smarthomesolutions.se>",
```

---

## Technical Notes

- No Resend configuration changes needed - any address on the verified `mail.smarthomesolutions.se` subdomain works
- The Reply-To addresses (`sales+token@...` and `support+token@...`) remain unchanged
- All edge functions will be automatically redeployed after the changes
