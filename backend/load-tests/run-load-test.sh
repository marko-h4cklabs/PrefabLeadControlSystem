#!/bin/bash
set -e
cd "$(dirname "$0")/.."
mkdir -p load-tests/results

echo "Starting load test..."
echo "Target: ${TARGET_URL:-https://api.eightpath.dev}"

export TEST_TOKEN="${TEST_TOKEN:-your_test_jwt_token_here}"
export TEST_PAGE_ID="${TEST_PAGE_ID:-your_manychat_page_id_here}"
export WEBHOOK_TOKEN="${WEBHOOK_TOKEN:-your_webhook_token_here}"

REPORT_JSON="load-tests/results/report-$(date +%Y%m%d-%H%M%S).json"
npx artillery run \
  --output "$REPORT_JSON" \
  load-tests/artillery.config.yml

echo "Load test complete. Generating HTML report..."
if [ -f "$REPORT_JSON" ]; then
  npx artillery report "$REPORT_JSON"
  echo "Report generated at load-tests/results/"
else
  echo "No report file found at $REPORT_JSON"
fi
