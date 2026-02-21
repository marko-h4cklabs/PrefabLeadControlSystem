# Analytics Dashboard Debug Response

When `ANALYTICS_DEBUG=true`, the dashboard response includes a `debug` object:

```json
{
  "debug": {
    "tenantId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "filters": { "range": "30", "source": "all", "channel": "all" },
    "rawLeadCount": 42,
    "filteredLeadCount": 38,
    "sourcesFound": { "inbox": 28, "simulation": 10 },
    "channelsFound": ["email", "messenger", "telegram", "whatsapp"]
  }
}
```

**Interpretation:**
- `rawLeadCount` > 0, `filteredLeadCount` = 0 → date or source/channel filter excluding all rows
- `rawLeadCount` = 0 → tenant scoping issue (wrong company_id)
- Both > 0 → backend returns data; if UI still empty, check frontend mapping

**Server logs** (when ANALYTICS_DEBUG=true):
- userId, tenantId, range, source, channel
- rawLeadCount, filteredLeadCount
- sourcesFound, channelsFound
