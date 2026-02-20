# Chatbot API – cURL Examples

Replace `BASE_URL` with your API base (e.g. `https://your-railway-app.railway.app`) and `TOKEN` with a valid JWT.

**Migrations required:** Run in order:
```bash
psql $DATABASE_URL -f backend/db/migrations/010_chat_conversation_state.sql
psql $DATABASE_URL -f backend/db/migrations/011_chat_conversation_fields_and_messages.sql
psql $DATABASE_URL -f backend/db/migrations/012_lead_statuses.sql
psql $DATABASE_URL -f backend/db/migrations/013_seed_default_company_lead_statuses.sql
psql $DATABASE_URL -f backend/db/migrations/014_lead_name_and_conversation_snapshot.sql
psql $DATABASE_URL -f backend/db/migrations/015_backfill_company_lead_statuses.sql
```

## Company Info

```bash
# GET company info
curl -s -X GET "$BASE_URL/api/chatbot/company-info" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"

# PUT company info
curl -s -X PUT "$BASE_URL/api/chatbot/company-info" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"business_description":"We build prefab homes.","additional_notes":"Focus on eco materials."}'
```

## Behavior

```bash
# GET behavior
curl -s -X GET "$BASE_URL/api/chatbot/behavior" \
  -H "Authorization: Bearer $TOKEN"

# PUT behavior
curl -s -X PUT "$BASE_URL/api/chatbot/behavior" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tone":"friendly","response_length":"medium","emojis_enabled":true,"persona_style":"busy","forbidden_topics":[]}'
```

## Quote Fields

```bash
# GET quote fields
curl -s -X GET "$BASE_URL/api/chatbot/quote-fields" \
  -H "Authorization: Bearer $TOKEN"

# PUT quote fields
curl -s -X PUT "$BASE_URL/api/chatbot/quote-fields" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fields":[{"name":"Budget","type":"number","units":"USD","priority":100,"required":true},{"name":"Timeline","type":"text","priority":90,"required":true}]}'
```

## Chat (live conversation with quote collection)

```bash
# POST chat message (creates/gets active conversation if conversationId omitted)
curl -s -X POST "$BASE_URL/api/chatbot/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hi, I need a quote for a prefab home."}'

# Response:
# {
#   "assistant_message": "...",
#   "conversation_id": "uuid",
#   "required_infos": [{"name":"location","type":"text","units":null,"priority":10}],
#   "collected_infos": [{"name":"budget","type":"number","value":12000,"units":"EUR"}]
# }

# Continue (pass conversationId for continuity)
curl -s -X POST "$BASE_URL/api/chatbot/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Location is Denver.","conversationId":"<uuid>"}'
```

**Frontend panel:** Use `required_infos` for "Required infos (missing)" and `collected_infos` for "Collected infos". Update after each message.

## System Context

```bash
# GET system context (for chatbot LLM)
curl -s -X GET "$BASE_URL/api/chatbot/system-context" \
  -H "Authorization: Bearer $TOKEN"
```

## Lead Statuses

```bash
# List all statuses for the authenticated company (sorted by position)
curl -s -X GET "$BASE_URL/api/leads/statuses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: YOUR_COMPANY_ID"

# List leads with optional filter by status_id (UUID)
curl -s -X GET "$BASE_URL/api/leads?limit=10&offset=0" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: YOUR_COMPANY_ID"

curl -s -X GET "$BASE_URL/api/leads?limit=10&offset=0&status_id=STATUS_UUID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: YOUR_COMPANY_ID"

# Update a lead's status
curl -s -X PATCH "$BASE_URL/api/leads/LEAD_ID/status" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-company-id: YOUR_COMPANY_ID" \
  -d '{"status_id":"STATUS_UUID"}'

# Update a lead's name
curl -s -X PATCH "$BASE_URL/api/leads/LEAD_ID/name" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-company-id: YOUR_COMPANY_ID" \
  -d '{"name":"John Smith"}'

# Get lead detail with collected_infos and required_infos_missing
curl -s -X GET "$BASE_URL/api/leads/LEAD_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: YOUR_COMPANY_ID"
```
