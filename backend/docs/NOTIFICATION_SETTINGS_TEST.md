# Notification Settings – Test Checklist

## Migration

```bash
psql $DATABASE_URL -f backend/db/migrations/025_notification_settings.sql
```

## Env vars

- `EMAIL_PROVIDER` (optional, e.g. `resend`)
- `RESEND_API_KEY` – required for email sending
- `EMAIL_FROM` – sender address (e.g. `notifications@yourdomain.com`)

## Validation / Behavior

| Check | Expected |
|-------|----------|
| App starts without email env | ✓ No crash; logs warning if provider set but key missing |
| GET /api/settings/notifications (no row) | Returns defaults: `email_enabled: false`, `notify_new_inquiry_inbox: true`, `notify_new_inquiry_simulation: false` |
| PUT /api/settings/notifications | Saves and returns normalized object |
| Lead in simulation, `notify_new_inquiry_simulation=false` | No email sent |
| Lead in simulation, `notify_new_inquiry_simulation=true`, `email_enabled=true` | Email sent (if recipients) |
| Lead in inbox, `notify_new_inquiry_inbox=false` | No email sent |
| Lead in inbox, `notify_new_inquiry_inbox=true`, `email_enabled=true` | Email sent (if recipients) |
| In-app notifications | Unchanged; still created for inbox leads |
| Email failure | Does not block lead creation |

## cURL

```bash
# GET
curl -s -X GET "$BASE_URL/api/settings/notifications" \
  -H "Authorization: Bearer $TOKEN" -H "x-company-id: $COMPANY_ID"

# PUT
curl -s -X PUT "$BASE_URL/api/settings/notifications" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "x-company-id: $COMPANY_ID" \
  -d '{"email_enabled":true,"email_recipients":["you@example.com"],"notify_new_inquiry_inbox":true,"notify_new_inquiry_simulation":false}'
```
