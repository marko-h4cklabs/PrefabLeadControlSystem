# Chatbot Booking API

Live end-to-end booking flow: chatbot offers scheduling after quote completion, shows available slots, and creates appointments.

## Architecture

```
schedulingNormalizer.js  ← single source of truth for all setting alias resolution
     ↓
availabilityService.js   ← real slot generation with conflict detection
     ↓
scheduling.js routes     ← GET /availability + POST /book
chatbot.js               ← booking state machine in /chat flow
chatbotScheduling.js     ← POST /conversations/:id/book-slot
```

## Settings Normalization

All scheduling code uses `services/schedulingNormalizer.js` which accepts any alias:

| Canonical key | Accepted aliases |
|---|---|
| `enabled` | `scheduling_enabled`, `schedulingEnabled` |
| `chatbotOfferBooking` | `chatbot_offer_booking`, `chatbot_booking_enabled`, `chatbot_offers_booking`, `chatbot_booking.enabled` |
| `slotDurationMinutes` | `slot_duration_minutes` |
| `bufferBeforeMinutes` | `buffer_before_minutes` |
| `minNoticeHours` | `min_notice_hours`, `minimum_notice_hours` |
| `maxDaysAhead` | `max_days_ahead` |
| `chatbotBookingRequiresName` | `chatbot_booking_requires_name`, `require_name`, `chatbot_booking.require_name` |
| `chatbotBookingRequiresPhone` | `chatbot_booking_requires_phone`, `require_phone`, `chatbot_booking.require_phone` |
| `chatbotCollectBookingAfterQuote` | `chatbot_collect_booking_after_quote`, `ask_after_quote` |
| `chatbotAllowUserProposedTime` | `chatbot_allow_user_proposed_time`, `allow_custom_time` |
| `chatbotShowSlotsWhenAvailable` | `chatbot_show_slots_when_available`, `show_available_slots` |

Working hours are normalized to: `[{ day, enabled, ranges: [{ start, end }] }]`

## Endpoints

### GET /api/scheduling/availability

Returns available appointment slots for the tenant company.

**Query params:**
| Param | Type | Default | Description |
|---|---|---|---|
| startDate | YYYY-MM-DD | today | Start of scan window |
| endDate | YYYY-MM-DD | today + maxDaysAhead | End of scan window |
| appointmentType | string | - | Reserved for future use |
| limit | number | 10 | Max slots to return (1-50) |

**Response:**
```json
{
  "slots": [
    {
      "id": "2026-02-25_0900",
      "label": "Tue, Feb 25 • 09:00–09:30",
      "startAt": "2026-02-25T08:00:00.000Z",
      "endAt": "2026-02-25T08:30:00.000Z",
      "date": "2026-02-25",
      "startTime": "09:00",
      "endTime": "09:30",
      "timezone": "Europe/Zagreb"
    }
  ],
  "settingsSummary": {
    "enabled": true,
    "timezone": "Europe/Zagreb",
    "slotDurationMinutes": 30
  },
  "debug": {
    "hasWorkingHours": true,
    "reason": null,
    "enabledDays": ["monday", "tuesday", "wednesday", "thursday", "friday"],
    "daysScanned": 14,
    "slotsGenerated": 80,
    "conflictsSkipped": 2,
    "pastSkipped": 5
  }
}
```

**Debug reason values:** `null` (slots found), `scheduling_disabled`, `no_enabled_days`, `no_slots_in_range`, `all_past_or_too_soon`, `all_conflicted`

### POST /api/scheduling/book

Book an appointment slot. Validates availability before creating.

**Body:**
```json
{
  "leadId": "uuid",
  "startAt": "2026-02-25T08:00:00.000Z",
  "appointmentType": "call",
  "title": "Call - John Doe",
  "notes": "Chatbot booking",
  "source": "chatbot"
}
```

**Response (201):**
```json
{ "appointment": { "id": "uuid", "leadId": "uuid", "startAt": "...", "endAt": "...", "status": "scheduled", "source": "chatbot" } }
```

### POST /api/chatbot/scheduling/conversations/:conversationId/book-slot

Book a slot from the chatbot conversation flow.

**Body:**
```json
{
  "slotStartAt": "2026-02-25T08:00:00.000Z",
  "leadId": "uuid",
  "appointmentType": "call"
}
```

**Response (201):**
```json
{
  "assistant_message": "Your call has been confirmed for Tue, Feb 25 at 09:00. We look forward to speaking with you!",
  "conversation_id": "uuid",
  "booking": { "mode": "confirmed", "appointment": { ... } }
}
```

## Chatbot /chat Response Shape

Every `/api/chatbot/chat` response now includes:

```json
{
  "assistant_message": "...",
  "conversation_id": "uuid",
  "highlights": { ... },
  "required_infos": [{ "name": "budget", "type": "number", "units": "EUR" }],
  "collected_infos": [{ "name": "location", "type": "text", "value": "Zagreb" }],
  "booking_debug": { ... },
  "booking": {
    "mode": "offer|slots|awaiting_custom_time|confirmed|declined|not_available",
    "slots": [{ "id", "label", "startAt", "endAt", "timezone" }],
    "appointment": null,
    "requiredBeforeBooking": ["full_name", "phone_number"]
  }
}
```

### Booking modes

| Mode | When | Frontend action |
|---|---|---|
| `offer` | Quote complete, booking question shown | Show Yes/No buttons |
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

## Lead Detail Integration

`GET /api/leads/:id` now includes an `appointments` array:
```json
{
  "id": "uuid",
  "name": "...",
  "appointments": [
    { "id": "uuid", "appointmentType": "call", "status": "scheduled", "startAt": "...", "endAt": "...", "timezone": "Europe/Zagreb", "source": "chatbot", "title": "Call - John Doe" }
  ]
}
```

## Troubleshooting: No Slots

If availability returns empty slots, check `debug.reason`:

1. **`scheduling_disabled`** — `enabled=false` in scheduling settings. Enable scheduling OR just enable `chatbotOfferBooking`.
2. **`no_enabled_days`** — Working hours have no enabled days. Configure at least one day with ranges.
3. **`no_slots_in_range`** — No possible slots exist in the date range (working hours too narrow or range too small).
4. **`all_past_or_too_soon`** — All generated slots are in the past or within the `minNoticeHours` window.
5. **`all_conflicted`** — All slots conflict with existing scheduled appointments.

Also check:
- `workingHours` shape is valid (both flat and nested are accepted)
- `slotDurationMinutes` isn't larger than the working hour ranges
- `minNoticeHours` isn't too high (e.g., 48 hours means nothing before 2 days from now)

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

# Chatbot quote completion (returns booking offer if enabled)
curl -X POST http://localhost:3001/api/chatbot/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -H "x-company-id: COMPANY_ID" \
  -d '{"message":"Zagreb, budget 5000 EUR","conversationId":"CONV_ID","leadId":"LEAD_ID"}'

# Book via chatbot conversation
curl -X POST http://localhost:3001/api/chatbot/scheduling/conversations/CONV_ID/book-slot \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -H "x-company-id: COMPANY_ID" \
  -d '{"slotStartAt":"2026-02-25T08:00:00.000Z","leadId":"LEAD_ID"}'
```

## Manual Test Steps

### Simulation flow:
1. Enable scheduling + chatbot booking offers in Settings
2. Set working hours for at least Mon-Fri
3. Start simulation conversation
4. Complete all required quote fields
5. Chatbot should offer booking (response includes `booking.mode: "offer"`)
6. Reply "yes" → response includes `booking.mode: "slots"` with available times
7. Reply "1" to pick first slot → response shows selected slot
8. Use book-slot endpoint or reply "confirm" → appointment created
9. Check lead detail → `appointments` array includes the new chatbot booking

### Inbox flow:
1. Same settings as above
2. After lead completes quote via real channel
3. Booking offer appears in chat response
4. Same slot selection + booking flow

### Edge cases:
- No working hours configured → `debug.reason: "no_enabled_days"`
- All slots taken → `debug.reason: "all_conflicted"`
- Require name/phone → chatbot asks for missing info before offering slots
- User says "no" to booking → `booking.mode: "declined"`, no repeated offers
