# Chat – Manual Test Steps

## Prerequisites

1. Run migrations 010 and 011.
2. Configure quote fields with at least one required field (e.g. Location, type text, priority 10).
3. Set behavior: persona=busy, response_length=short, emojis_enabled=false.

## Test 1: Persona busy + short

- Send any message.
- **Verify:** Assistant reply is max 1–2 short sentences, no greetings, no "Got it"/"Noted".

## Test 2: Required missing – bot asks for next field

- If Location is required and not yet provided, send any message.
- **Verify:** Assistant asks ONLY for Location (e.g. "Location?" or "Location (city/country)?").
- **Verify:** `required_infos` contains Location; `collected_infos` is empty or has previous fields.

## Test 3: User provides multiple fields in one message

- Send: "Location is Zagreb, budget 50000 EUR."
- **Verify:** Extractor captures both; `collected_infos` shows both.
- **Verify:** If more required fields missing, bot asks for next only.

## Test 4: Collected infos visible

- After providing a field, check response.
- **Verify:** `collected_infos` includes the field with correct value and units.

## Test 5: Emojis disabled

- Set emojis_enabled=false.
- **Verify:** No emojis in any assistant response.
