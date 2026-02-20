# Lead + Chat API Verification

## A) Create Lead with Human Name and Channel

Create a lead with a human name (Unicode, diacritics) and channel "Messenger" (normalized to lowercase):

```bash
export BASE="http://localhost:3000"
export TOKEN="your-jwt"
export COMPANY_ID="your-company-uuid"

# Create lead with name "Erik Mekelenić" and channel "Messenger"
curl -s -X POST "$BASE/api/companies/$COMPANY_ID/leads" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-company-id: $COMPANY_ID" \
  -d '{"name":"Erik Mekelenić","channel":"Messenger"}'
```

**Alternative (legacy):** `{"external_id":"test-123","channel":"messenger"}` still works.

Response includes `id`, `channel`, `name`, `external_id`, `status_id`, `status_name`, `created_at`, `updated_at`.

---

## B) Fetch Lead Detail

```bash
export LEAD_ID="lead-uuid-from-step-A"

curl -s -X GET "$BASE/api/leads/$LEAD_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: $COMPANY_ID"
```

**Expected response shape:**
```json
{
  "lead": {
    "id": "...",
    "company_id": "...",
    "channel": "messenger",
    "name": "Erik Mekelenić",
    "external_id": "Erik Mekelenić",
    "status_id": "...",
    "status_name": "New",
    "created_at": "2025-02-18T...",
    "updated_at": "2025-02-18T..."
  },
  "collected_infos": [],
  "required_infos_missing": []
}
```

---

## C) Send Chat Message (AI Reply) – Sidebar Contract

```bash
# First, add a user message
curl -s -X POST "$BASE/api/companies/$COMPANY_ID/leads/$LEAD_ID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-company-id: $COMPANY_ID" \
  -d '{"role":"user","content":"Hi, I need a quote."}'

# Trigger AI reply (Lovable conversation endpoint)
curl -s -X POST "$BASE/api/companies/$COMPANY_ID/leads/$LEAD_ID/ai-reply" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-company-id: $COMPANY_ID"
```

**Expected response includes:**
```json
{
  "assistant_message": "...",
  "conversation_id": "uuid",
  "active_settings": {
    "tone": "professional",
    "response_length": "medium",
    "persona_style": "busy",
    "emojis_enabled": false,
    "forbidden_topics": []
  },
  "required_infos": [{"name":"budget","type":"number","units":"USD","priority":100}],
  "missing_required_infos": [{"name":"budget","type":"number","units":"USD","priority":100}],
  "collected_infos": [],
  "required": [...],
  "collected": []
}
```

- `active_settings` – from chatbot behavior
- `required_infos` – all required fields from quote snapshot
- `missing_required_infos` – required but not yet collected
- `collected_infos` – collected fields with values
- `required` / `collected` – aliases for backward compatibility
