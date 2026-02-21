# Scheduling Requests API — Phase 3A

Chatbot scheduling intent capture + owner workflow (manual-first).

## New Endpoints

### Scheduling Requests CRUD

#### POST /api/scheduling-requests
Create a scheduling request (from chatbot or manual).

**Body** (accepts camelCase and snake_case):
```json
{
  "leadId": "uuid",
  "conversationId": "uuid (optional)",
  "requestType": "call",
  "preferredDate": "2026-02-25",
  "preferredTime": "14:00",
  "preferredTimeWindow": {"from":"14:00","to":"17:00"},
  "preferredTimezone": "Europe/Zagreb",
  "source": "chatbot",
  "availabilityMode": "manual",
  "notes": "Call me after work",
  "metadata": {}
}
```

**Response:** 201 with created scheduling request + lead summary.

#### GET /api/scheduling-requests
List scheduling requests (newest first).

**Query params:**
| Param | Type | Default |
|---|---|---|
| status | open/converted/closed/cancelled | all |
| leadId | uuid | all |
| requestType | call/site_visit/meeting/follow_up | all |
| limit | 1-200 | 50 |
| offset | >= 0 | 0 |

**Response:** `{ items: [...], total: N }`

#### GET /api/scheduling-requests/:id
Single scheduling request detail.

#### PATCH /api/scheduling-requests/:id
Update status, preferred fields, notes, metadata, selected slot.

#### POST /api/scheduling-requests/:id/convert-to-appointment
Convert request into an actual appointment.

**Body** (optional — provide if request has no slot times):
```json
{
  "startAt": "2026-02-25T14:00:00.000Z",
  "endAt": "2026-02-25T14:30:00.000Z",
  "title": "Call - John",
  "appointmentType": "call",
  "timezone": "Europe/Zagreb",
  "reminderMinutesBefore": 60
}
```

If the request already has `selectedSlotStartAt/EndAt`, those are used and no body is required.

**Response:** 201 with `{ request, appointment }`

---

### Lead-Scoped

#### GET /api/leads/:leadId/scheduling-requests
List scheduling requests for a specific lead (newest first).

---

### Chatbot Scheduling

#### GET /api/chatbot/scheduling/config
Returns effective chatbot booking settings for the company.

**Response:**
```json
{
  "enabled": false,
  "chatbotOfferBooking": false,
  "chatbotBookingMode": "manual_request",
  "chatbotBookingPromptStyle": "neutral",
  "chatbotCollectBookingAfterQuote": true,
  "chatbotBookingRequiresName": false,
  "chatbotBookingRequiresPhone": false,
  "chatbotBookingDefaultType": "call",
  "chatbotAllowUserProposedTime": true,
  "chatbotShowSlotsWhenAvailable": true,
  "allowedAppointmentTypes": ["call"],
  "timezone": "Europe/Zagreb",
  "slotDurationMinutes": 30
}
```

#### POST /api/chatbot/scheduling/intake
Receive extracted scheduling intent from chatbot/simulation.

**Body:**
```json
{
  "leadId": "uuid",
  "conversationId": "uuid (optional)",
  "intent": {
    "wantsBooking": true,
    "requestType": "call",
    "preferredDate": "2026-02-25",
    "preferredTime": "14:00",
    "preferredTimeWindow": {"from":"14:00","to":"17:00"},
    "timezone": "Europe/Zagreb",
    "notes": "Call me after work"
  }
}
```

**Response (booking mode = manual_request):**
```json
{
  "action": "request_created",
  "schedulingRequestId": "uuid",
  "request": { ... },
  "nextMessageHint": "Thank you! We've noted your preference for 2026-02-25 14:00. Our team will confirm shortly."
}
```

**Response (booking mode = off):**
```json
{
  "action": "disabled",
  "message": "Chatbot scheduling is disabled for this company."
}
```

---

### Scheduling Settings (extended)

GET/PUT `/api/settings/scheduling` now includes chatbot booking fields:

| Field | Type | Default |
|---|---|---|
| chatbotBookingMode | off/manual_request/direct_booking | manual_request |
| chatbotBookingPromptStyle | string | neutral |
| chatbotCollectBookingAfterQuote | boolean | true |
| chatbotBookingRequiresName | boolean | false |
| chatbotBookingRequiresPhone | boolean | false |
| chatbotBookingDefaultType | enum | call |
| chatbotAllowUserProposedTime | boolean | true |
| chatbotShowSlotsWhenAvailable | boolean | true |

---

## Migration

**File:** `030_scheduling_requests_and_chatbot_settings.sql`

```bash
psql $DATABASE_URL -f backend/db/migrations/030_scheduling_requests_and_chatbot_settings.sql
```

---

## CRM Activity Events

| Event | When |
|---|---|
| scheduling_request_created | Request created (chatbot or manual) |
| scheduling_request_converted | Request converted to appointment |
| appointment_created | Appointment created from conversion |

## In-App Notifications

| Event | Title |
|---|---|
| Request created | "New scheduling request" / "New scheduling request from chatbot" |
| Request converted | "Appointment booked from request" |

---

## Manual Test Checklist

1. POST /api/scheduling-requests with valid lead → 201
2. POST with invalid lead → 404
3. POST with missing lead_id → 400 with field error
4. GET /api/scheduling-requests → list with items
5. GET /api/scheduling-requests?status=open → filtered
6. GET /api/leads/:leadId/scheduling-requests → lead-scoped list
7. PATCH /api/scheduling-requests/:id → update status/notes
8. POST /api/scheduling-requests/:id/convert-to-appointment with times → 201, returns both request + appointment
9. Convert same request again → 409 conflict
10. Check CRM activity: scheduling_request_created entry appears
11. Check CRM activity: scheduling_request_converted entry appears
12. Check notifications bell: scheduling request notification appears
13. GET /api/chatbot/scheduling/config → returns config
14. POST /api/chatbot/scheduling/intake with intent → request_created
15. POST /api/chatbot/scheduling/intake with booking mode=off → disabled
16. GET /api/settings/scheduling → includes chatbot booking fields
17. PUT /api/settings/scheduling with chatbotBookingMode → saves
