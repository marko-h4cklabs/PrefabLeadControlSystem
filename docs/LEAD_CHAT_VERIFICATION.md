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

**Example response:**
```json
{
  "id": "uuid",
  "channel": "messenger",
  "name": "Erik Mekelenić",
  "status_id": "uuid",
  "status_name": "New",
  "created_at": "2025-02-18T...",
  "updated_at": "2025-02-18T..."
}
```

**Legacy:** `{"external_id":"test-123","channel":"messenger"}` still works.

---

## B) Statuses Endpoint

```bash
curl -s -X GET "$BASE/api/leads/statuses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: $COMPANY_ID"
```

**Example response:**
```json
{
  "statuses": [
    {"id": "uuid", "name": "New", "slug": "new", "is_default": true, "sort_order": 10},
    {"id": "uuid", "name": "Qualified", "slug": "qualified", "is_default": false, "sort_order": 20}
  ]
}
```

## C) Fetch Lead Detail

```bash
export LEAD_ID="lead-uuid-from-step-A"

curl -s -X GET "$BASE/api/leads/$LEAD_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: $COMPANY_ID"
```

**Example response:**
```json
{
  "id": "uuid",
  "channel": "messenger",
  "name": "Erik Mekelenić",
  "status_id": "uuid",
  "status_name": "New",
  "created_at": "2025-02-18T...",
  "updated_at": "2025-02-18T...",
  "collected_infos": [
    {"name": "location", "type": "text", "value": "Croatia, Zagreb", "units": null},
    {"name": "budget", "type": "number", "value": 3000, "units": "EUR"}
  ]
}
```

---

## D) Lead List (with filtering)

```bash
# Default: filter by "New" status
curl -s -X GET "$BASE/api/leads?limit=10&offset=0" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: $COMPANY_ID"

# Filter by status UUID
curl -s -X GET "$BASE/api/leads?status_id=STATUS_UUID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: $COMPANY_ID"

# All statuses (no filter)
curl -s -X GET "$BASE/api/leads?status_id=all" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: $COMPANY_ID"
```

**Example response:**
```json
{
  "leads": [
    {
      "id": "uuid",
      "channel": "messenger",
      "name": "Erik Mekelenić",
      "status_id": "uuid",
      "status_name": "New",
      "created_at": "2025-02-18T...",
      "updated_at": "2025-02-18T...",
      "collected_info": "location: Croatia, Zagreb · budget: 3000 EUR"
    }
  ],
  "total": 1
}
```

## E) Send Chat Message (AI Reply) – Sidebar Contract

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

**Example response:**
```json
{
  "assistant_message": "Hi! I'd be happy to help...",
  "conversation_id": "uuid",
  "looking_for": [{"name":"budget","type":"number","units":"USD","priority":100,"required":true}],
  "collected": [],
  "messages": [...]
}
```

- `looking_for` – required fields still missing (from conversation snapshot)
- `collected` – fields with values (name, type, value, units)
- Quote requirements are snapshotted at conversation creation; old leads keep old snapshot
