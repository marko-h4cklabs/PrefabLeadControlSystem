# API cURL Examples

Base URL: `http://localhost:3000` (or your deployed URL)

All authenticated endpoints require: `Authorization: Bearer <token>`

---

## Quote Requirements (Presets)

Both `/quote-fields` and `/quote-presets` expose the same behavior. Use whichever your frontend expects.

### GET /api/chatbot/quote-fields (or /api/chatbot/quote-presets)

Returns the 11 preset quote fields with `is_enabled` and `config`.

**Response:** `{ presets: [...], fields: [...] }` — each preset has:
- `name`, `label`, `description`, `type`, `is_enabled`, `config`, `priority`, `required`

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

**Preset object:** `{ "name": string, "is_enabled"?: boolean, "config"?: object }`

**Allowed preset names:** budget, location, email_address, phone_number, full_name, additional_notes, doors, windows, colors, dimensions, roof

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
