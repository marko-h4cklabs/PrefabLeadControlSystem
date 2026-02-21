# Analytics Empty Data Fix – Summary

## 1. Root cause (most likely)

Multiple issues could cause empty analytics:

1. **Date/timezone** – Node `new Date()` + `toISOString()` mixed local/UTC; date boundaries could exclude rows. **Fix:** Use PostgreSQL `CURRENT_DATE - ($2 || ' days')::interval` for timestamptz-safe boundaries.
2. **Filter normalization** – `source=ALL`, `channel=All Channels`, or empty strings were not normalized to "no filter", causing SQL to filter incorrectly.
3. **Legacy source** – Rows with NULL or empty `source` were excluded when filtering; they must be treated as `inbox`.
4. **Channel filter** – UI label "All Channels" was passed as filter value, matching no rows.
5. **Status breakdown** – Rows with both `status_id` and `status` null could be dropped; now fallback to `'unknown'`.

## 2. Files changed

| File | Changes |
|------|---------|
| `backend/db/repositories/analyticsRepository.js` | PostgreSQL CURRENT_DATE for date range (timestamptz-safe), normalizeSource/normalizeChannel, COALESCE(NULLIF(TRIM(source),''),'inbox'), getRawCounts, status COALESCE(...,'unknown') |
| `backend/src/api/routes/analytics.js` | ANALYTICS_DEBUG env flag, rawCounts, _debug in response |
| `backend/src/api/validators/analyticsSchemas.js` | Preprocess range (accept 7/30/90 as number or string), source (ALL/INBOX/SIMULATION → lowercase), channel ("all channels" → "all"), UTC date math |
| `backend/docs/ANALYTICS_DEBUG.md` | Debug instructions |
| `backend/docs/ANALYTICS_FIX_SUMMARY.md` | This file |

## 3. Dashboard response keys

**Top-level:**
- `range` – { startDate, endDate, source, channel }
- `applied_filters` – { range, source, channel }
- `data_as_of` – ISO timestamp
- `available_channels` – string[]
- `summary` – KPI object
- `leadsOverTime` – { day, inbox, simulation, total }[]
- `channelBreakdown` – { channel, count }[]
- `statusBreakdown` – { status, count }[]
- `fieldCompletion` – { field, label, collected, total, pct }[]
- `topSignals` – { channel, total, withConversation, conversionPct }[]
- `_debug` – { rawCounts, tenantId } (only when ANALYTICS_DEBUG=true)

**Summary keys:**
- `totalLeads`, `newLeadsToday`, `conversationsStarted`
- `quoteDataCompletionRate`, `avgCollectedFieldsPerLead`
- `inboxCount`, `simulationCount`, `inboxPct`, `simulationPct`

## 4. Debug logs

- **Guarded by** `ANALYTICS_DEBUG=true`
- **Logs:** tenantId, parsedFilters, normalizedFilters, rawCounts, summary, array lengths
- **Response:** `_debug` object when enabled

## 5. Manual test checklist

| # | Test | Pass/Fail |
|---|------|-----------|
| 1 | `/api/analytics/dashboard?range=30&source=all&channel=all` returns non-zero when leads exist | _run manually_ |
| 2 | Analytics KPIs show non-zero values | _run manually_ |
| 3 | Leads Over Time chart renders | _run manually_ |
| 4 | Channel Breakdown shows real channels | _run manually_ |
| 5 | Status Breakdown shows real statuses | _run manually_ |
| 6 | source=all|inbox|simulation changes numbers correctly | _run manually_ |
| 7 | Channel dropdown filter works | _run manually_ |
| 8 | Empty state only when no data | _run manually_ |
| 9 | No frontend console errors | _run manually_ |
| 10 | No backend 500s | _run manually_ |

### Expected results when leads exist

- `summary.totalLeads` > 0
- `channelBreakdown` has entries with real channel names
- `leadsOverTime` has at least one point per day with leads
- `statusBreakdown` has entries (status names from company_lead_statuses or legacy)
- `summary.inboxCount` + `summary.simulationCount` = `summary.totalLeads` (when source=all)
