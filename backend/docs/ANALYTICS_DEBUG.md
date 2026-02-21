# Analytics Debugging

## Backend debug (ANALYTICS_DEBUG)

Set `ANALYTICS_DEBUG=true` in the environment to enable verbose logging for `/api/analytics/dashboard`:

- **tenantId** – company ID used (same as leads routes)
- **parsedFilters** – range, source, channel from query
- **normalizedFilters** – startDate, endDate, source, channel after schema
- **rawCounts** – total leads for tenant, total after filters
- **summary** – totalLeads, newLeadsToday, conversationsStarted, inboxCount, simulationCount
- **lengths** – array lengths for leadsOverTime, channelBreakdown, statusBreakdown, fieldCompletion, topSignals, availableChannels

When enabled, the response also includes `_debug: { rawCounts, tenantId }` for inspection.

## Frontend debug (temporary)

To verify whether the issue is backend (empty response) or frontend (wrong mapping), add this **before** rendering the Analytics page:

```javascript
// Temporary: log exact dashboard response
const res = await fetch('/api/analytics/dashboard?range=30&source=all&channel=all', {
  headers: { Authorization: `Bearer ${token}` },
});
const data = await res.json();
console.log('[analytics] dashboard response', JSON.stringify(data, null, 2));
```

Check:
- If `data.summary.totalLeads` is 0 but Inbox has leads → backend/tenant/date filter issue
- If `data.summary.totalLeads` > 0 but UI shows zeros → frontend mapping issue
