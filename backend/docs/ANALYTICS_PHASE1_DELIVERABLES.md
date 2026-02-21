# Analytics Phase 1 – Deliverables

## 1. Backend API + Route Registration

**Routes registered in** `backend/src/index.js`:
```
app.use('/api/analytics', authMiddleware, tenantMiddleware, apiLimiter, analyticsRouter);
```

**Endpoints created:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analytics/dashboard` | Consolidated dashboard (summary + all charts) |
| GET | `/api/analytics/summary` | KPI summary only |
| GET | `/api/analytics/leads-over-time` | Daily lead counts |
| GET | `/api/analytics/channel-breakdown` | Leads by channel |
| GET | `/api/analytics/status-breakdown` | Leads by status |
| GET | `/api/analytics/field-completion` | Quote field collection rates |
| GET | `/api/analytics/top-signals` | Channel conversion to conversation |

**Query params (all):** `range` (7|30|90), `source` (all|inbox|simulation), `channel` (all or specific).

**Dashboard response additions (fix for zero-data):**
- `available_channels`: array of channel strings for dropdown (range+source, no channel filter)
- `applied_filters`: { range, source, channel }
- `data_as_of`: ISO timestamp
- Legacy: COALESCE(source,'inbox') for null source; channel filter case-insensitive

## 2. Frontend Integration

The frontend (Lovable) is in a separate repo. See `ANALYTICS_API.md` for:
- Response shapes
- Filter mapping
- KPI cards, charts, and Top Signals panel spec
- Loading, empty, error states

**Navigation:** Add "Analytics" between "Chatbot" and "Settings". Route: `/analytics`.

## 3. Assumptions / Fallbacks

| Metric | Logic |
|--------|-------|
| Quote Data Completion Rate | % of leads with ≥1 collected field (parsed_fields or attachments for pictures) |
| Avg Collected Fields per Lead | Mean of distinct collected fields per lead |
| New Leads Today | Count of leads created today (ignores date range filter) |
| Field completion | Uses enabled presets from `chatbot_quote_fields`; pictures = parsed_fields.pictures or attachments |
| Status | Prefers `company_lead_statuses.name`, fallback `leads.status` |
| Empty DB | Returns zeros and empty arrays; no 500 |

## 4. Manual Test Checklist

1. **Auth**
   - [ ] Login, obtain token
   - [ ] `GET /api/analytics/dashboard?range=30` with `Authorization: Bearer <token>` → 200

2. **Filters**
   - [ ] `?range=7` → 7-day window
   - [ ] `?source=inbox` → inbox leads only
   - [ ] `?channel=whatsapp` → WhatsApp leads only

3. **Empty state**
   - [ ] Company with no leads → summary zeros, empty arrays for charts

4. **Existing pages**
   - [ ] Inbox, Simulation, Chatbot, Settings, Lead Detail CRM open normally
   - [ ] No new 404s

5. **Frontend (when built)**
   - [ ] Analytics nav item visible between Chatbot and Settings
   - [ ] Channel dropdown uses `available_channels` (not channelBreakdown)
   - [ ] Date range + filters work
   - [ ] KPI cards, charts, Top Signals render
   - [ ] Loading, empty, error states

6. **Non-zero data (when leads exist)**
   - [ ] Dashboard returns non-zero totals for range=90 when leads exist
   - [ ] source=all|inbox|simulation filters correctly
   - [ ] channel=all returns all; channel=telegram (or existing) filters correctly
   - [ ] available_channels includes existing channels even when channel filter selected
