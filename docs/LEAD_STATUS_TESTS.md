# Lead Status Tests

## Prerequisites

- Run migrations in order:
  - `psql $DATABASE_URL -f backend/db/migrations/012_lead_statuses.sql`
  - `psql $DATABASE_URL -f backend/db/migrations/013_seed_default_company_lead_statuses.sql`
  - `psql $DATABASE_URL -f backend/db/migrations/014_lead_name_and_conversation_snapshot.sql`
  - `psql $DATABASE_URL -f backend/db/migrations/015_backfill_company_lead_statuses.sql`
- Or apply via Railway: connect to Postgres and run the migration SQL

## Manual Verification Steps

### 1. Run migration

```bash
psql $DATABASE_URL -f backend/db/migrations/012_lead_statuses.sql
```

### 2. Verify seeded statuses per company

```sql
SELECT c.name, cls.name, cls.is_default, cls.sort_order
FROM companies c
JOIN company_lead_statuses cls ON cls.company_id = c.id
ORDER BY c.name, cls.sort_order;
```

Expected: Each company has New (is_default=true), Qualified, Disqualified, Pending review.

### 3. Create a new lead → status is "New"

```bash
# Get auth token and company context first
export TOKEN="your-jwt"
export BASE="http://localhost:3000"

# With human name + channel (accepts "Erik Mekelenić", "Messenger", etc.)
curl -s -X POST "$BASE/api/companies/YOUR_COMPANY_ID/leads" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-company-id: YOUR_COMPANY_ID" \
  -d '{"name":"Erik Mekelenić","channel":"Messenger"}'

# Legacy: external_id still works
curl -s -X POST "$BASE/api/leads" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-company-id: YOUR_COMPANY_ID" \
  -d '{"channel":"email","external_id":"test-123"}'
```

Response includes `id`, `channel`, `name`, `external_id`, `status_id`, `status_name`, `created_at`, `updated_at`.

### 4. GET /api/leads/statuses

```bash
curl -s -X GET "$BASE/api/leads/statuses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: YOUR_COMPANY_ID"
```

Expected: `{ "statuses": [ { "id": "...", "name": "New", "position": 10 }, ... ] }`

### 5. PATCH /api/leads/:id/status to change to Qualified

```bash
# Get lead ID from step 3, get Qualified status ID from step 4
export LEAD_ID="lead-uuid"
export QUALIFIED_STATUS_ID="status-uuid"

curl -s -X PATCH "$BASE/api/leads/$LEAD_ID/status" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-company-id: YOUR_COMPANY_ID" \
  -d '{"status_id":"'$QUALIFIED_STATUS_ID'"}'
```

Expected: Updated lead with `status_id`, `status_name`, etc.

### 5b. PATCH /api/leads/:id/name

```bash
curl -s -X PATCH "$BASE/api/leads/$LEAD_ID/name" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-company-id: YOUR_COMPANY_ID" \
  -d '{"name":"John Smith"}'
```

### 5c. GET /api/leads/:id (lead detail with collected info)

```bash
curl -s -X GET "$BASE/api/leads/$LEAD_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: YOUR_COMPANY_ID"
```

Expected: `{ "lead": { "channel", "name", "status", "created_at", "updated_at" }, "collected_infos": [...], "required_infos_missing": [...] }`

### 6. Verify lead list shows updated status and filter by statusId

```bash
# List all leads (includes status_id, status_name per lead)
curl -s -X GET "$BASE/api/leads?limit=10&offset=0" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: YOUR_COMPANY_ID"

# Filter leads by status UUID
curl -s -X GET "$BASE/api/leads?limit=10&offset=0&status_id=$QUALIFIED_STATUS_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: YOUR_COMPANY_ID"
```

Expected: Each lead has `status_id`, `status_name` (and optionally `status_obj`). Filter returns only leads with that status.

## cURL Examples Summary

| Endpoint | Method | Query / Body |
|----------|--------|--------------|
| List statuses | `GET /api/leads/statuses` | - |
| List leads | `GET /api/leads` | `?limit=&offset=&status_id=<uuid>` |
| Filter by status | `GET /api/leads?status_id=<uuid>` | - |
| Lead detail | `GET /api/leads/:id` | - |
| Update lead status | `PATCH /api/leads/:id/status` | `{ "status_id": "<uuid>" }` |
| Update lead name | `PATCH /api/leads/:id/name` | `{ "name": "First Last" }` |
