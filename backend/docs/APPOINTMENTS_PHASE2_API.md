# Appointments Phase 2 API

All endpoints require JWT auth + `x-company-id` header (tenant-scoped).

## Input Alias Support

All body/query params accept **both camelCase and snake_case**:

| Frontend sends | Backend understands |
|---|---|
| `leadId` | `lead_id` |
| `startAt` | `start_at` |
| `endAt` | `end_at` |
| `appointmentType` or `type` | `appointment_type` |
| `reminderMinutesBefore` or `reminder` | `reminder_minutes_before` |
| `durationMinutes` | computes `end_at` from `start_at + duration` |
| `date` + `startTime` | computes `start_at` |
| `date` + `endTime` | computes `end_at` |

If `end_at` is missing, defaults to `start_at + 30 minutes`.

---

## Endpoints

### POST /api/appointments

Create from calendar form.

```json
{
  "leadId": "uuid",
  "title": "Call - John Doe",
  "appointmentType": "call",
  "startAt": "2026-02-22T10:00:00.000Z",
  "endAt": "2026-02-22T10:30:00.000Z",
  "timezone": "Europe/Zagreb",
  "notes": "Discuss budget",
  "source": "manual",
  "reminderMinutesBefore": 30
}
```

Or with date/time/duration shape:

```json
{
  "leadId": "uuid",
  "date": "2026-02-22",
  "startTime": "10:00",
  "durationMinutes": 30,
  "appointmentType": "call"
}
```

**Response:** `201`

### POST /api/leads/:leadId/appointments

Create from lead detail. `leadId` inferred from URL.

```json
{
  "startAt": "2026-02-22T10:00:00.000Z",
  "endAt": "2026-02-22T10:30:00.000Z",
  "appointmentType": "site_visit"
}
```

**Response:** `201` (same shape as POST /api/appointments)

---

### GET /api/appointments

List with filters.

| Param | Type | Notes |
|---|---|---|
| from | ISO datetime | `start_at >= from` |
| to | ISO datetime | `start_at < to` |
| status | enum | scheduled/completed/cancelled/no_show |
| appointmentType | enum | call/site_visit/meeting/follow_up |
| source | enum | manual/chatbot/google_sync, "all" = no filter |
| leadId | uuid | filter by lead |
| q | string | search title/lead name/channel |
| limit | int | 1-500, default 100 |
| offset | int | default 0 |

**Response:** `200`

```json
{
  "items": [
    {
      "id": "uuid",
      "leadId": "uuid",
      "lead": { "id": "uuid", "name": "John", "channel": "whatsapp", "status": "New" },
      "title": "Call - John",
      "appointmentType": "call",
      "status": "scheduled",
      "startAt": "2026-02-22T10:00:00.000Z",
      "endAt": "2026-02-22T10:30:00.000Z",
      "timezone": "Europe/Zagreb",
      "notes": null,
      "source": "manual",
      "reminderMinutesBefore": 30,
      "createdByUserId": "uuid",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "total": 1,
  "range": { "from": "...", "to": "..." }
}
```

### GET /api/appointments/upcoming

| Param | Default | Max |
|---|---|---|
| limit | 10 | 100 |
| within_days | 30 | 365 |

**Response:** `200` — `{ "items": [...] }`

### GET /api/appointments/:id

**Response:** `200` — single appointment object

---

### PATCH /api/appointments/:id

Edit any fields.

```json
{
  "title": "Updated",
  "startAt": "2026-02-23T14:00:00.000Z",
  "endAt": "2026-02-23T14:30:00.000Z",
  "notes": "New notes"
}
```

### POST /api/appointments/:id/reschedule

Move to new time. Resets status to `scheduled`. Appends notes.

```json
{
  "startAt": "2026-02-24T09:00:00.000Z",
  "endAt": "2026-02-24T09:30:00.000Z",
  "notes": "Client requested morning"
}
```

### POST /api/appointments/:id/status

Change lifecycle status.

```json
{
  "status": "completed",
  "notes": "Call went well"
}
```

Allowed: `scheduled`, `completed`, `cancelled`, `no_show`

### POST /api/appointments/:id/cancel

Convenience cancel. Appends note.

```json
{
  "note": "Client cancelled"
}
```

Returns `409` if already cancelled.

### DELETE /api/appointments/:id

Hard delete. Logs CRM activity before deletion.

**Response:** `200` — `{ "success": true, "id": "uuid" }`

---

## Reminder Notifications

- Background worker polls every 60 seconds
- Creates in-app notification when `start_at - reminder_minutes_before` window is reached
- Deduplicated via `appointment_reminders_sent` table (unique on appointment_id + minutes)
- Notification example: `"Upcoming call in 30 min — Erik M. (WhatsApp)"`
- Notification type: `appointment_reminder`

---

## CRM Activity Events

| Event Type | When |
|---|---|
| `appointment_created` | New appointment created |
| `appointment_updated` | Any field edited via PATCH |
| `appointment_rescheduled` | Rescheduled via POST /:id/reschedule |
| `appointment_completed` | Status changed to completed |
| `appointment_cancelled` | Cancelled via cancel or status endpoint |
| `appointment_no_show` | Status changed to no_show |
| `appointment_deleted` | Hard deleted |

Each activity includes `metadata.message` with human-readable description.

---

## Error Examples

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "lead_id: lead_id must be a valid UUID; start_at: start_at must be valid ISO datetime",
    "fields": {
      "lead_id": ["lead_id must be a valid UUID"],
      "start_at": ["start_at must be valid ISO datetime"]
    }
  }
}
```

```json
{
  "error": { "code": "NOT_FOUND", "message": "Lead not found or does not belong to your company" }
}
```

---

## Migration Required

```bash
psql $DATABASE_URL -f backend/db/migrations/028_appointment_reminders_sent.sql
```

---

## Manual Test Checklist

- [ ] GET /api/appointments → 200, items array
- [ ] GET /api/appointments?q=john → search works
- [ ] GET /api/appointments?status=scheduled&from=2026-02-01 → filtered
- [ ] GET /api/appointments/:id → 200 single item
- [ ] POST /api/appointments with camelCase body → 201
- [ ] POST /api/appointments with date+startTime+durationMinutes → 201
- [ ] POST /api/leads/:leadId/appointments → 201
- [ ] POST with invalid leadId → 400
- [ ] POST with cross-tenant lead → 404
- [ ] PATCH /api/appointments/:id → 200
- [ ] POST /:id/reschedule → 200, status reset to scheduled
- [ ] POST /:id/status { status: "completed" } → 200
- [ ] POST /:id/cancel → 200, 409 if already cancelled
- [ ] DELETE /:id → 200, activity logged
- [ ] Create appointment with reminderMinutesBefore: 5, start_at in 3 min → notification appears within 60s
- [ ] CRM activity entries visible in lead timeline
- [ ] Tenant isolation: cannot access other company's appointments
