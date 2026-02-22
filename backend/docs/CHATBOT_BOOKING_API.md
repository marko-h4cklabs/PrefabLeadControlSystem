# Chatbot Booking API

Live end-to-end booking flow: chatbot offers scheduling after quote completion, shows available slots, and creates appointments.

## Endpoints

### GET /api/scheduling/availability

Returns available appointment slots for the tenant company.

**Query params:**
| Param | Type | Default | Description |
|---|---|---|---|
| startDate | string (YYYY-MM-DD) | today | Start of scan window |
| endDate | string (YYYY-MM-DD) | today + maxDaysAhead | End of scan window |
| appointmentType | string | - | Reserved for future use |
| limit | number | 10 | Max slots to return (1-50) |

**Response:**
```json
{
  "slots": [
    {
      "id": "slot-0",
      "label": "Mon Feb 23, 09:00–09:30 (Europe/Zagreb)",
      "startAt": "2026-02-23T08:00:00.000Z",
      "endAt": "2026-02-23T08:30:00.000Z",
      "date": "2026-02-23",
      "startTime": "09:00",
      "endTime": "09:30",
      "timezone": "Europe/Zagreb"
    }
  ],
  "settingsSummary": {
    "timezone": "Europe/Zagreb",
    "slotDurationMinutes": 30
  },
  "debug": {
    "reason": null,
    "enabledDays": ["monday","tuesday","wednesday","thursday","friday"],
    "daysScanned": 14,
    "slotsGenerated": 80,
    "conflictsSkipped": 2,
    "pastSkipped": 5
  }
}
```

### POST /api/scheduling/book

Book an appointment slot. Validates availability before creating.

**Body:**
```json
{
  "leadId": "uuid",
  "startAt": "2026-02-23T08:00:00.000Z",
  "appointmentType": "call",
  "title": "Call - John Doe",
  "notes": "Chatbot booking",
  "source": "chatbot"
}
```

**Response (201):**
```json
{
  "appointment": { "id": "uuid", "leadId": "uuid", "startAt": "...", "endAt": "...", ... }
}
```

### POST /api/chatbot/scheduling/conversations/:conversationId/book-slot

Book a slot from the chatbot conversation flow. Creates appointment and updates conversation state.

**Body:**
```json
{
  "slotStartAt": "2026-02-23T08:00:00.000Z",
  "leadId": "uuid",
  "appointmentType": "call"
}
```

**Response (201):**
```json
{
  "assistant_message": "Your call has been confirmed for Mon Feb 23 at 09:00. We look forward to speaking with you!",
  "conversation_id": "uuid",
  "booking": {
    "mode": "confirmed",
    "slots": [],
    "appointment": { ... }
  }
}
```

## Chatbot /chat Response: booking object

When booking flow is active, every `/api/chatbot/chat` response includes a `booking` object:

```json
{
  "assistant_message": "...",
  "conversation_id": "uuid",
  "highlights": { ... },
  "booking_debug": { ... },
  "booking": {
    "mode": "offer | slots | awaiting_custom_time | confirmed | declined | not_available",
    "slots": [{ "id", "label", "startAt", "endAt", "timezone" }],
    "appointment": null,
    "requiredBeforeBooking": ["full_name", "phone_number"]
  }
}
```

### Booking modes

| Mode | When | Frontend action |
|---|---|---|
| `offer` | Quote complete, chatbot offering booking | Show Yes/No buttons |
| `slots` | User accepted, slots available | Show slot picker |
| `awaiting_custom_time` | No slots, custom time allowed | Show text input |
| `confirmed` | Appointment created | Show confirmation |
| `declined` | User declined | Continue chat |
| `not_available` | Slots unavailable, no custom time | Show fallback message |

## Booking State Machine

```
null → OFFERED (quote complete, booking active)
OFFERED → SLOTS_SHOWN (user says yes, slots available)
OFFERED → CUSTOM_TIME (user says yes, no slots, custom time allowed)
OFFERED → ACCEPTED (user says yes, no slots, team followup)
OFFERED → DECLINED (user says no)
PREREQ_NAME → PREREQ_PHONE → OFFERED (prerequisite collection)
SLOTS_SHOWN → CONFIRMED (slot booked via endpoint or chat)
CUSTOM_TIME → ACCEPTED (custom time captured)
```

## curl Examples

```bash
# Get available slots
curl -X GET "http://localhost:3001/api/scheduling/availability?limit=5" \
  -H "Authorization: Bearer TOKEN" \
  -H "x-company-id: COMPANY_ID"

# Book a slot (manual)
curl -X POST http://localhost:3001/api/scheduling/book \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -H "x-company-id: COMPANY_ID" \
  -d '{"leadId":"LEAD_ID","startAt":"2026-02-25T08:00:00.000Z","source":"manual"}'

# Book via chatbot conversation
curl -X POST http://localhost:3001/api/chatbot/scheduling/conversations/CONV_ID/book-slot \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -H "x-company-id: COMPANY_ID" \
  -d '{"slotStartAt":"2026-02-25T08:00:00.000Z","leadId":"LEAD_ID"}'

# Chat with booking flow
curl -X POST http://localhost:3001/api/chatbot/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -H "x-company-id: COMPANY_ID" \
  -d '{"message":"Zagreb, budget 5000 EUR","leadId":"LEAD_ID"}'
```

## Manual Test Steps

1. **Settings**: Enable scheduling + chatbot booking offers in PUT /api/settings/scheduling
2. **Quote presets**: Enable at least location + budget as required
3. **Chat**: Send "Zagreb, budget 5000 EUR" (or collect fields one by one)
4. **Booking offer**: Response should include `booking.mode: "offer"` + `booking_offer: true`
5. **Accept**: Send "yes" — response should include `booking.mode: "slots"` with available times
6. **Select slot**: Send "1" (first slot) or use book-slot endpoint
7. **Confirm**: Appointment created, response has `booking.mode: "confirmed"`
8. **Decline flow**: After offer, send "no" — response has `booking.mode: "declined"`
9. **No slots**: If working hours are disabled, response has `booking.mode: "not_available"` or `"awaiting_custom_time"`
10. **Require name/phone**: Enable toggles, verify chatbot asks before offering
