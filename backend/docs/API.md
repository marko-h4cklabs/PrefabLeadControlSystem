# API Reference

Base URL: `http://localhost:3000` (or your deployed URL)

All authenticated endpoints require: `Authorization: Bearer <token>`

---

## A) Inbox / Leads

### GET /api/leads

List leads with optional status filter.

**Query params:**
- `limit` (optional, default 50): 1–100
- `offset` (optional, default 0)
- `source` (optional, default inbox): `inbox` | `simulation` — separates real vs test leads
- `status_id` (optional): UUID to filter by status, or `__ALL__` / `all` for all statuses
- `query` (optional): Keyword search — matches `name`, `external_id`, `channel`, or status name (max 80 chars)

**Examples:**

```bash
# Inbox leads (default)
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/leads?source=inbox"

# Simulation leads
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/leads?source=simulation"

# All leads (no status filter)
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/leads"

# Filter by status UUID + source
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/leads?status_id=550e8400-e29b-41d4-a716-446655440000&source=inbox"

# All statuses for source (explicit)
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/leads?status_id=__ALL__&source=simulation"

# Keyword search + source
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/leads?query=marko&source=inbox&limit=20&offset=0"
```

**Response:** `{ leads: [...], total: number }` — each lead includes `status_id`, `status_name`, `collected_info`.

---

### GET /api/leads/statuses

Returns company lead statuses sorted by position.

**Response:** `{ statuses: [{ id, name, position }, ...] }`

```bash
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/leads/statuses"
```

---

### POST /api/leads

Create a lead. **Body:** `{ "channel", "name"?, "external_id"?, "source"? }` — `source` optional, `inbox`|`simulation`, default `inbox`.

```bash
# Create inbox lead (default)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"whatsapp","name":"John"}' "http://localhost:3000/api/leads"

# Create simulation lead
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"whatsapp","name":"Test","source":"simulation"}' "http://localhost:3000/api/leads"

# Name normalization: underscores become spaces (e.g. test_keona -> "test keona" in DB)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"email","name":"test_keona"}' "http://localhost:3000/api/leads"
```

---

### PATCH /api/leads/:id/status

Update lead status.

**Body:** `{ "status_id": "<uuid>" }`

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status_id":"550e8400-e29b-41d4-a716-446655440000"}' \
  "http://localhost:3000/api/leads/LEAD_ID"
```

---

## B) Conversation

### POST /api/companies/:companyId/leads/:leadId/messages

Store a user message only. Does **not** trigger AI reply.

**Body:** `{ "role": "user", "content": "Hello" }`

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"role":"user","content":"Hello"}' \
  "http://localhost:3000/api/companies/COMPANY_ID/leads/LEAD_ID/messages"
```

**Response:** `{ ok: true, lead_id, conversation_id, messages }`

---

### POST /api/companies/:companyId/leads/:leadId/ai-reply

Generate AI reply, persist assistant message and extracted fields.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/companies/COMPANY_ID/leads/LEAD_ID/ai-reply"
```

**Response:** `{ assistant_message, conversation_id, lead_id, looking_for, collected, messages }`

---

## C) Account / Me

### GET /api/me

Returns current user info.

```bash
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/me"
```

**Response:** `{ id, email, company_id }`

---

### PUT /api/me/email

Update email.

**Body:** `{ "email": "new@example.com" }`

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"new@example.com"}' \
  "http://localhost:3000/api/me/email"
```

**Response:** `{ ok: true, email: "new@example.com" }`

---

### PUT /api/me/password

Change password. Requires current password.

**Body:** `{ "current_password": "...", "new_password": "..." }`

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"current_password":"oldpass","new_password":"newpass123"}' \
  "http://localhost:3000/api/me/password"
```

**Response:** `{ ok: true }`

---

## Error responses

- `400`: Validation error — `{ error: { code: "VALIDATION_ERROR", message: "..." } }`
- `401`: Unauthorized — `{ error: { code: "UNAUTHORIZED", message: "..." } }`
- `404`: Not found
- `409`: Conflict (e.g. email already in use)
