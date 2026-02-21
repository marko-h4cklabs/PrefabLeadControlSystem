# Analytics API – Frontend Integration

Analytics Phase 1 provides read-only dashboard data. All endpoints require `Authorization: Bearer <token>` and are tenant-scoped.

## Base path

`/api/analytics`

## Query parameters (all endpoints)

| Param   | Type   | Default | Description                          |
|---------|--------|---------|--------------------------------------|
| `range` | string | `30`    | `7`, `30`, or `90` (days)            |
| `source`| string | `all`   | `all`, `inbox`, or `simulation`     |
| `channel`| string| `all`   | Channel filter (e.g. `whatsapp`, `messenger`) |

## Endpoints

### GET /api/analytics/dashboard (consolidated)

Returns all analytics data in one response. Prefer this for the Analytics page.

**Example:** `GET /api/analytics/dashboard?range=30&source=all&channel=all`

**Response:**
```json
{
  "range": {
    "startDate": "2025-01-19",
    "endDate": "2025-02-18",
    "source": "all",
    "channel": "all"
  },
  "applied_filters": {
    "range": "30",
    "source": "all",
    "channel": "all"
  },
  "data_as_of": "2025-02-18T14:30:00.000Z",
  "available_channels": ["email", "messenger", "telegram", "whatsapp"],
  "summary": {
    "totalLeads": 42,
    "newLeadsToday": 3,
    "conversationsStarted": 28,
    "quoteDataCompletionRate": 65,
    "avgCollectedFieldsPerLead": 2.5,
    "inboxCount": 30,
    "simulationCount": 12,
    "inboxPct": 71,
    "simulationPct": 29
  },
  "leadsOverTime": [
    { "day": "2025-01-19", "inbox": 2, "simulation": 1, "total": 3 },
    { "day": "2025-01-20", "inbox": 5, "simulation": 0, "total": 5 }
  ],
  "channelBreakdown": [
    { "channel": "messenger", "count": 20 },
    { "channel": "whatsapp", "count": 15 }
  ],
  "statusBreakdown": [
    { "status": "New", "count": 18 },
    { "status": "Contacted", "count": 12 }
  ],
  "fieldCompletion": [
    { "field": "budget", "label": "Budget", "collected": 25, "total": 42, "pct": 60 },
    { "field": "pictures", "label": "Pictures", "collected": 18, "total": 42, "pct": 43 }
  ],
  "topSignals": [
    { "channel": "messenger", "total": 20, "withConversation": 18, "conversionPct": 90 },
    { "channel": "whatsapp", "total": 15, "withConversation": 10, "conversionPct": 67 }
  ]
}
```

### Individual endpoints (optional)

- `GET /api/analytics/summary` – KPI summary only
- `GET /api/analytics/leads-over-time` – daily lead counts
- `GET /api/analytics/channel-breakdown` – leads by channel
- `GET /api/analytics/status-breakdown` – leads by status
- `GET /api/analytics/field-completion` – quote field collection rates
- `GET /api/analytics/top-signals` – channel conversion to conversation

## Frontend implementation checklist

1. **Navigation**
   - Add "Analytics" item between "Chatbot" and "Settings" in the sidebar.
   - Route: `/analytics` (or as per existing routing).

2. **Date range controls**
   - Preset buttons or dropdown: Last 7 days, Last 30 days (default), Last 90 days.
   - Map to `range=7`, `range=30`, `range=90`.

3. **Optional filters**
   - Source: All / Inbox / Simulation → `source=all|inbox|simulation`
   - Channel: All + dynamic options from `available_channels` (sorted, for selected range+source) → `channel=all|<channel>`

4. **KPI cards (top row)**
   - Total Leads, New Leads Today, Conversations Started
   - Quote Data Completion Rate (%), Avg Collected Fields per Lead
   - Inbox vs Simulation (value + percentage)

5. **Charts**
   - Leads Over Time: line/area, X=day, Y=count (optionally stacked by source)
   - Leads by Channel: bar chart, sorted descending
   - Leads by Status: bar or donut
   - Field Completion: horizontal bar (label vs pct or collected/total)

6. **Top Signals panel**
   - Table or list: channel, total, withConversation, conversionPct
   - Sorted by conversionPct or withConversation

7. **States**
   - Loading: skeleton or spinner
   - Empty: "No data in selected range"
   - Error: banner with retry

## Assumptions / fallbacks

- **Quote Data Completion Rate:** % of leads with at least one collected field (from `parsed_fields` or attachments for pictures).
- **Avg Collected Fields per Lead:** Count of distinct collected fields per lead, averaged.
- **New Leads Today:** Count of leads created today (ignores range filter).
- **Field completion:** Uses enabled quote presets from `chatbot_quote_fields`. Pictures count as collected when `parsed_fields.pictures` has value or lead has attachments.
- **Status:** Prefers `company_lead_statuses.name`; fallback to legacy `leads.status`.
- **Empty DB:** All endpoints return empty arrays and zeros; no 500.
