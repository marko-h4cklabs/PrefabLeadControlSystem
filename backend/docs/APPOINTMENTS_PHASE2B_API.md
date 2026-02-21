# Appointments Phase 2B API — Scheduling, Availability, Reminders

## New Endpoints

### Scheduling Settings

#### GET /api/settings/scheduling
Returns the company's scheduling configuration. If none exists, returns defaults.

**Response:**
```json
{
  "companyId": "uuid",
  "enabled": false,
  "timezone": "Europe/Zagreb",
  "workingHours": {
    "monday": [{"start":"09:00","end":"17:00"}],
    "tuesday": [{"start":"09:00","end":"17:00"}],
    "wednesday": [{"start":"09:00","end":"17:00"}],
    "thursday": [{"start":"09:00","end":"17:00"}],
    "friday": [{"start":"09:00","end":"17:00"}]
  },
  "slotDurationMinutes": 30,
  "bufferBeforeMinutes": 0,
  "bufferAfterMinutes": 0,
  "minNoticeHours": 2,
  "maxDaysAhead": 30,
  "allowedAppointmentTypes": ["call"],
  "allowManualBookingFromLead": true,
  "chatbotOfferBooking": false,
  "reminderDefaults": {"email":true,"inApp":true,"minutesBefore":60}
}
```

#### PUT /api/settings/scheduling
Update scheduling settings. Requires owner/admin role.

**Request:**
```json
{
  "enabled": true,
  "timezone": "Europe/Zagreb",
  "workingHours": {
    "monday": [{"start":"08:00","end":"16:00"}],
    "tuesday": [{"start":"08:00","end":"16:00"}]
  },
  "slotDurationMinutes": 60,
  "bufferBeforeMinutes": 15,
  "bufferAfterMinutes": 10,
  "minNoticeHours": 4,
  "maxDaysAhead": 60,
  "allowedAppointmentTypes": ["call","meeting","site_visit"],
  "chatbotOfferBooking": true,
  "reminderDefaults": {"email":true,"inApp":true,"minutesBefore":30}
}
```
Accepts both camelCase and snake_case keys.

---

### Availability Slots

#### GET /api/appointments/availability
Compute available time slots based on company working hours and existing appointments.

**Query params:**
| Param | Type | Default |
|---|---|---|
| from | YYYY-MM-DD | today |
| to | YYYY-MM-DD | from + 7 days |
| type / appointmentType | string | none |

**Response:**
```json
{
  "timezone": "Europe/Zagreb",
  "slotDurationMinutes": 30,
  "days": [
    {
      "date": "2026-02-25",
      "slots": [
        {"startAt":"2026-02-25T09:00:00+01:00","endAt":"2026-02-25T09:30:00+01:00"},
        {"startAt":"2026-02-25T09:30:00+01:00","endAt":"2026-02-25T10:00:00+01:00"}
      ]
    }
  ]
}
```

Rules:
- Excludes past slots and those within minNoticeHours
- Excludes slots overlapping scheduled appointments (with buffer)
- Max 31-day range per request
- Capped by maxDaysAhead from settings

---

### Lead Appointments

#### GET /api/leads/:leadId/appointments
List appointments for a specific lead (tenant-scoped).

**Query params:** Same as GET /api/appointments (from, to, status, type, limit, offset)

**Response:**
```json
{
  "items": [...],
  "total": 3,
  "range": {"from": null, "to": null}
}
```

#### POST /api/leads/:leadId/appointments
Create appointment with leadId from route. Same body as POST /api/appointments.

---

### Manual Reminder Trigger

#### POST /api/appointments/reminders/run
Manually trigger the reminder check cycle. Returns count of reminders processed.

**Response:**
```json
{"success": true, "remindersProcessed": 2}
```

---

## Response Shape (all appointment endpoints)

All appointment responses include both camelCase and snake_case keys:
```json
{
  "id": "uuid",
  "company_id": "uuid",
  "companyId": "uuid",
  "lead_id": "uuid",
  "leadId": "uuid",
  "lead": {"id":"uuid","name":"John","channel":"whatsapp","status":"New"},
  "title": "Call - John",
  "appointment_type": "call",
  "appointmentType": "call",
  "status": "scheduled",
  "start_at": "2026-02-25T09:00:00.000Z",
  "startAt": "2026-02-25T09:00:00.000Z",
  "end_at": "2026-02-25T09:30:00.000Z",
  "endAt": "2026-02-25T09:30:00.000Z",
  "timezone": "Europe/Zagreb",
  "notes": null,
  "source": "manual",
  "reminder_minutes_before": 60,
  "reminderMinutesBefore": 60,
  "created_at": "...",
  "createdAt": "...",
  "updated_at": "...",
  "updatedAt": "..."
}
```

---

## Migration

**File:** `029_company_scheduling_settings.sql`

```bash
psql $DATABASE_URL -f backend/db/migrations/029_company_scheduling_settings.sql
```

---

## Manual Test Checklist

1. GET /api/settings/scheduling → returns defaults (no 500)
2. PUT /api/settings/scheduling with working hours → saves and returns updated
3. PUT with invalid slotDurationMinutes=0 → 400
4. GET /api/appointments/availability → returns slot days
5. GET /api/appointments/availability?from=2026-02-25&to=2026-02-28 → filtered
6. GET /api/leads/:leadId/appointments → lists lead's appointments
7. POST /api/leads/:leadId/appointments → creates appointment
8. POST /api/appointments/reminders/run → returns count
9. Existing GET/POST/PATCH/DELETE /api/appointments still work
10. Response includes both camelCase and snake_case keys
