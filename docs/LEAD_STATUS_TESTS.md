# Lead Status Tests

## Prerequisites

- Run migration: `psql $DATABASE_URL -f backend/db/migrations/012_lead_statuses.sql`
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

curl -s -X POST "$BASE/api/leads" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-company-id: YOUR_COMPANY_ID" \
  -d '{"channel":"email","external_id":"test-123"}'
```

Response should include `status_obj: { id: "...", name: "New" }` or lead has status_id pointing to New.

### 4. GET /api/leads/statuses

```bash
curl -s -X GET "$BASE/api/leads/statuses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: YOUR_COMPANY_ID"
```

Expected: `{ "statuses": [ { "id": "...", "name": "New", "sort_order": 10, "is_default": true }, ... ] }`

### 5. PUT /api/leads/:id/status to change to Qualified

```bash
# Get lead ID from step 3, get Qualified status ID from step 4
export LEAD_ID="lead-uuid"
export QUALIFIED_STATUS_ID="status-uuid"

curl -s -X PUT "$BASE/api/leads/$LEAD_ID/status" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-company-id: YOUR_COMPANY_ID" \
  -d '{"status_id":"'$QUALIFIED_STATUS_ID'"}'
```

Expected: `{ "id": "...", "status_obj": { "id": "...", "name": "Qualified" }, ... }`

### 6. Verify lead list shows updated status

```bash
curl -s -X GET "$BASE/api/leads?limit=10" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-company-id: YOUR_COMPANY_ID"
```

Expected: Each lead in `leads` array has `status_obj: { id, name }` with current status.

## cURL Examples Summary

| Endpoint | Method | Body |
|----------|--------|------|
| List statuses | `GET /api/leads/statuses` | - |
| Update lead status | `PUT /api/leads/:id/status` | `{ "status_id": "uuid" }` |
| List leads (filter by status) | `GET /api/leads?status_id=uuid` | - |
