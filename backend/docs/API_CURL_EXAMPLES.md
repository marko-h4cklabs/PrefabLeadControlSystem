# API cURL Examples

Base URL: `http://localhost:3000` (or your deployed URL). Updated 2026-02.

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

All CRM endpoints require JWT auth and tenant context (`x-company-id` or JWT company).

**Primary paths (used by frontend):** `/api/leads/:leadId/activity`, `/api/leads/:leadId/notes`, `/api/leads/:leadId/tasks`

**Alternative paths:** `/api/leads/:leadId/crm/activity` etc., `/api/crm/leads/:leadId/...`

### GET /api/leads/:leadId/activity

Returns activity timeline for the lead. Query: `?limit=30&offset=0` (optional).

**Response:** `{ "items": [...], "total": number }`

```bash
curl -H "Authorization: Bearer $TOKEN" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3000/api/leads/LEAD_UUID/activity?limit=30"
```

### GET /api/leads/:leadId/notes

### GET /api/leads/:leadId/tasks

### POST /api/leads/:leadId/notes

### PATCH /api/leads/:leadId/notes/:noteId

### DELETE /api/leads/:leadId/notes/:noteId

### POST /api/leads/:leadId/tasks

### PATCH /api/leads/:leadId/tasks/:taskId

### DELETE /api/leads/:leadId/tasks/:taskId

### GET /api/crm/leads/:leadId/summary (combined)

Returns combined activity, notes, and tasks for the lead CRM panel.

```bash
curl -H "Authorization: Bearer $TOKEN" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3000/api/crm/leads/LEAD_UUID/summary"
```
