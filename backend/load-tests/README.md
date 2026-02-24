# Load Tests

Load testing setup using [Artillery](https://www.artillery.io/) and custom Node scripts. Simulates 10+ concurrent clients hitting the system simultaneously.

## Quick start

**Concurrent webhook test** (simulates 10 companies × 5 messages):

```bash
node load-tests/concurrent-webhook-test.js
```

With a real webhook token (from a company’s `webhook_token`):

```bash
WEBHOOK_TOKEN=your_company_webhook_token node load-tests/concurrent-webhook-test.js
```

**Database stress test** (50 concurrent lead + notification count queries):

```bash
DATABASE_URL=your_db_url node load-tests/db-stress-test.js
```

Or from repo root with `.env` in `backend/`:

```bash
cd backend && node load-tests/db-stress-test.js
```

**Full Artillery load test** (warm up, ramp, sustained load, spike, cool down):

```bash
TEST_TOKEN=your_jwt WEBHOOK_TOKEN=your_webhook_token TEST_PAGE_ID=optional_page_id bash load-tests/run-load-test.sh
```

Or via npm (from `backend/`):

```bash
npm run load-test              # concurrent webhook test
npm run load-test:db           # DB stress test
npm run load-test:artillery    # full Artillery run
```

## What to watch

- **Response times** should stay under 3000ms at 20 concurrent users.
- **Error rate** should stay under 1%.
- **Railway memory** should stay under 512MB.
- **DB pool** `waitingCount` should stay at 0.

## Bottlenecks to watch for

- **DB pool exhaustion** (`pool.waitingCount > 0`)
- **Claude/OpenAI rate limits** (429 errors in logs)
- **Memory leaks** (memory grows over time)
- **BullMQ queue backup** (warming jobs piling up)

## Environment variables

| Variable         | Used by              | Description                                      |
|------------------|----------------------|--------------------------------------------------|
| `TARGET_URL`     | All                  | Base URL (default: Railway production URL)       |
| `TEST_TOKEN`     | Artillery, API flow  | JWT for authenticated API scenarios              |
| `WEBHOOK_TOKEN`  | Webhook scenarios    | Company `webhook_token` for `/api/webhook/manychat/:token` |
| `TEST_PAGE_ID`   | Webhook payloads     | Optional ManyChat `page_id` in payload           |
| `DATABASE_URL`   | db-stress-test.js    | PostgreSQL connection string                    |

## Output

- **Artillery**: `load-tests/results/report-YYYYMMDD-HHMMSS.json` and generated HTML report.
- **Concurrent webhook**: Console summary (success/fail counts, latencies).
- **DB stress**: Console summary and pool stats.
