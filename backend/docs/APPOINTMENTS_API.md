# Appointments API

All endpoints require JWT auth + `x-company-id` header (tenant-scoped).

Base path: `/api/appointments`

---

## POST /api/appointments

Create an appointment linked to a lead.

**Body:**

```json
{
  "lead_id": "uuid",
  "title": "Call - John Doe",
  "appointment_type": "call",
  "start_at": "2026-02-21T10:00:00.000Z",
  "end_at": "2026-02-21T10:30:00.000Z",
  "timezone": "Europe/Zagreb",
  "notes": "Discuss project scope",
  "source": "manual",
  "reminder_minutes_before": 60
}
```

- `lead_id` — required, must belong to your company
- `title` — optional, auto-derived from type + lead name if missing
- `appointment_type` — `call` | `site_visit` | `meeting` | `follow_up` (default: `call`)
- `status` — `scheduled` | `completed` | `cancelled` | `no_show` (default: `scheduled`)
- `source` — `manual` | `chatbot` | `google_sync` (default: `manual`)
- `reminder_minutes_before` — 0–10080, nullable

**Response:** `201`

```json
{
  "id": "uuid",
  "lead_id": "uuid",
  "lead": {
    "id": "uuid",
    "name": "John Doe",
    "channel": "whatsapp",
    "status": "New"
  },
  "title": "Call - John Doe",
  "appointment_type": "call",
  "status": "scheduled",
  "start_at": "2026-02-21T10:00:00.000Z",
  "end_at": "2026-02-21T10:30:00.000Z",
  "timezone": "Europe/Zagreb",
  "notes": "Discuss project scope",
  "source": "manual",
  "reminder_minutes_before": 60,
  "created_by_user_id": "uuid",
  "created_at": "...",
  "updated_at": "..."
}
```

---

## GET /api/appointments

List appointments with optional filters.

**Query params:**

| Param | Type | Default | Notes |
|---|---|---|---|
| from | ISO datetime | — | start_at >= from |
| to | ISO datetime | — | start_at < to |
| status | string | — | filter by status |
| appointment_type | string | — | filter by type |
| source | string | — | `all` bypasses filter |
| lead_id | uuid | — | filter by lead |
| limit | int | 100 | max 500 |
| offset | int | 0 | |

**Response:** `200`

```json
{
  "items": [ /* appointment objects with lead */ ],
  "total": 12,
  "range": { "from": "...", "to": "..." }
}
```

---

## GET /api/appointments/upcoming

**Query params:**

| Param | Type | Default |
|---|---|---|
| limit | int | 10 (max 100) |
| within_days | int | 30 (max 365) |

Returns scheduled appointments starting from now.

**Response:** `200`

```json
{
  "items": [ /* appointment objects with lead */ ]
}
```

---

## GET /api/appointments/:id

Single appointment detail (tenant-scoped).

**Response:** `200` — appointment object with lead.

---

## PATCH /api/appointments/:id

Update appointment fields.

**Body (all optional):**

```json
{
  "title": "Updated title",
  "appointment_type": "meeting",
  "status": "completed",
  "start_at": "2026-02-22T14:00:00.000Z",
  "end_at": "2026-02-22T14:30:00.000Z",
  "timezone": "Europe/Zagreb",
  "notes": "Updated notes",
  "reminder_minutes_before": 30
}
```

Validates `end_at > start_at` when either time is changed.

**Response:** `200` — updated appointment object with lead.

---

## POST /api/appointments/:id/cancel

Convenience endpoint to cancel an appointment.

**Body (optional):**

```json
{
  "note": "Customer requested reschedule"
}
```

Cancellation note is appended to existing notes. Returns `409` if already cancelled.

**Response:** `200` — cancelled appointment object with lead.

---

## Side Effects

- **CRM Activity Log**: `appointment_created`, `appointment_updated`, `appointment_cancelled` entries added to `lead_activities`.
- **Notifications**: In-app notification created for create/cancel/reschedule events.

---

## Frontend Integration Notes

1. Use `GET /api/appointments/upcoming` for sidebar/dashboard widgets.
2. Use `GET /api/appointments?lead_id=...` to show appointments in Lead Detail CRM tab.
3. Use `POST /api/appointments` from Inbox/CRM with the lead's ID.
4. The `lead` object is always included in responses — no need for a separate lead fetch.
5. All times are returned as ISO 8601 UTC strings.

---

## Manual Test Checklist

- [ ] Create appointment linked to existing lead → 201, lead enriched in response
- [ ] Create without title → title auto-derived from type + lead name
- [ ] Create with end_at <= start_at → 400
- [ ] Create with invalid lead_id → 404
- [ ] Create with cross-tenant lead_id → 404
- [ ] List with no filters → returns tenant appointments
- [ ] List with date range → filtered correctly
- [ ] List with status filter → only matching status
- [ ] List with lead_id filter → only that lead's appointments
- [ ] Upcoming → returns future scheduled appointments only
- [ ] Get by ID → returns single appointment
- [ ] Get cross-tenant ID → 404
- [ ] Patch to reschedule → updated times, notification created
- [ ] Patch status to completed → updated
- [ ] Cancel via POST /:id/cancel → status=cancelled, note appended
- [ ] Cancel already cancelled → 409
- [ ] Notification created for create/cancel/reschedule
- [ ] Activity log entry created for create/update/cancel
