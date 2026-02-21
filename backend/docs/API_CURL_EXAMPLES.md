# API cURL Examples

Base URL: `http://localhost:3000` (or your deployed URL)

All authenticated endpoints require: `Authorization: Bearer <token>`

---

## Quote Requirements (Presets)

Both `/quote-fields` and `/quote-presets` expose the same behavior. Use whichever your frontend expects.

### GET /api/chatbot/quote-fields (or /api/chatbot/quote-presets)

Returns all preset quote fields with `is_enabled`, `config`, and `priority` (ask-order).

**Response:** `{ presets: [...], fields: [...] }` — each preset has:
- `name`, `label`, `description`, `type`, `units`, `priority`, `required`, `is_enabled`, `config` (includes `group`: basic|detailed)

```bash
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/chatbot/quote-fields"
```

---

### PUT /api/chatbot/quote-fields (or /api/chatbot/quote-presets)

Save preset settings. Accepts multiple payload shapes for backward compatibility.

**Accepted payload shapes:**
1. `{ "presets": [...] }` (canonical)
2. `{ "fields": [...] }`
3. `[...]` (raw array)

**Preset object:** `{ "name": string, "is_enabled"?: boolean, "priority"?: number, "config"?: object }`

**Allowed preset names:** budget, location, time_window, email_address, phone_number, full_name, additional_notes, pictures, object_type, doors, windows, colors, dimensions, roof, ground_condition, utility_connections, completion_level

```bash
# Canonical shape: { presets: [...] }
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "presets": [
      { "name": "budget", "is_enabled": true, "config": { "units": ["EUR","USD"], "defaultUnit": "EUR" } },
      { "name": "full_name", "is_enabled": true, "config": {} },
      { "name": "email_address", "is_enabled": true, "config": {} }
    ]
  }' \
  "http://localhost:3000/api/chatbot/quote-fields"

# Alternative: { fields: [...] }
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "fields": [
      { "name": "budget", "is_enabled": true, "config": { "units": ["EUR","USD"], "defaultUnit": "EUR" } }
    ]
  }' \
  "http://localhost:3000/api/chatbot/quote-fields"

# Select-multi with options
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "presets": [
      { "name": "doors", "is_enabled": true, "config": { "options": ["Single", "Double", "Sliding"] } }
    ]
  }' \
  "http://localhost:3000/api/chatbot/quote-fields"

# Dimensions with enabled parts
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "presets": [
      { "name": "dimensions", "is_enabled": true, "config": { "enabledParts": ["length","width","height"], "unit": "m" } }
    ]
  }' \
  "http://localhost:3000/api/chatbot/quote-fields"

# UI-like payload (partial configs normalized server-side)
# - budget: UI may send only defaultUnit; units default to [EUR,USD]
# - dimensions: UI may send enabledParts subset; unit defaults to "m"
# - text presets: config may be {} or omitted
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "presets": [
      { "name": "budget", "is_enabled": true, "config": { "defaultUnit": "EUR" } },
      { "name": "email_address", "is_enabled": true, "config": {} },
      { "name": "full_name", "is_enabled": true },
      { "name": "dimensions", "is_enabled": true, "config": { "enabledParts": ["length","width"], "unit": "m" } }
    ]
  }' \
  "http://localhost:3000/api/chatbot/quote-presets"
```

**Errors:**
- `400` — presets array required (when payload missing or empty)
- `400` — Unknown preset names (when name not in allowed list)

---

## CRM (Lead Detail)

All CRM endpoints require JWT auth and tenant context (`x-company-id` or JWT company). Base path: `/api/crm/leads/:leadId`

### GET /api/crm/leads/:leadId/summary

Returns combined activity, notes, and tasks for the lead CRM panel.

**Response:**
```json
{
  "activity": { "items": [...], "total": number },
  "notes": { "items": [...], "total": number },
  "tasks": { "items": [...], "total": number }
}
```

```bash
curl -H "Authorization: Bearer $TOKEN" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3000/api/crm/leads/LEAD_UUID/summary"
```

### POST /api/crm/leads/:leadId/notes

Create a note. Body: `{ "body": "..." }` (1–5000 chars).

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"body": "Called lead, they want to schedule a site visit next week."}' \
  "http://localhost:3000/api/crm/leads/LEAD_UUID/notes"
```

### POST /api/crm/leads/:leadId/tasks

Create a task. Body: `{ "title": "...", "description": "...", "due_at": "ISO string", "assigned_user_id": "uuid" }` (all optional except title).

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"title": "Follow up call", "due_at": "2025-02-25T14:00:00.000Z"}' \
  "http://localhost:3000/api/crm/leads/LEAD_UUID/tasks"
```

### PATCH /api/crm/leads/:leadId/tasks/:taskId

Update task status to done. Body: `{ "status": "done" }`.

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}' \
  "http://localhost:3000/api/crm/leads/LEAD_UUID/tasks/TASK_UUID"
```
