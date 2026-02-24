/**
 * Simulates 10 different companies sending webhooks simultaneously.
 * Set WEBHOOK_TOKEN to a valid company webhook_token for real endpoint testing.
 */
const axios = require('axios');

const BASE_URL = process.env.TARGET_URL || 'https://prefableadcontrolsystem-production.up.railway.app';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'test';
const CONCURRENT_COMPANIES = 10;
const MESSAGES_PER_COMPANY = 5;

const testMessages = [
  "Hi I'm interested in your coaching program",
  "How much does it cost?",
  "What results do your clients get?",
  "I have a budget of around $2000",
  "When can we schedule a call?",
];

async function simulateCompanyWebhook(companyIndex, messageIndex) {
  const payload = {
    subscriber: {
      id: `test_user_${companyIndex}_${Date.now()}`,
      name: `Test Lead ${companyIndex}`,
      profile_pic: null,
    },
    message: {
      text: testMessages[messageIndex % testMessages.length],
      type: 'text',
    },
    page_id: process.env.TEST_PAGE_ID || 'test_page',
  };

  const start = Date.now();
  try {
    const response = await axios.post(
      `${BASE_URL}/api/webhook/manychat/${WEBHOOK_TOKEN}`,
      payload,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    const duration = Date.now() - start;
    console.log(
      `✅ Company ${companyIndex} msg ${messageIndex}: ${response.status} in ${duration}ms`
    );
    return { success: true, duration, company: companyIndex };
  } catch (err) {
    const duration = Date.now() - start;
    console.error(
      `❌ Company ${companyIndex} msg ${messageIndex}: ${err.response?.status || err.message} in ${duration}ms`
    );
    return {
      success: false,
      duration,
      company: companyIndex,
      error: err.message,
    };
  }
}

async function runConcurrentTest() {
  console.log(`\n🚀 Starting concurrent webhook test`);
  console.log(
    `   ${CONCURRENT_COMPANIES} companies × ${MESSAGES_PER_COMPANY} messages = ${CONCURRENT_COMPANIES * MESSAGES_PER_COMPANY} total requests\n`
  );

  const startAll = Date.now();

  const promises = [];
  for (let c = 0; c < CONCURRENT_COMPANIES; c++) {
    for (let m = 0; m < MESSAGES_PER_COMPANY; m++) {
      promises.push(simulateCompanyWebhook(c, m));
    }
  }

  const allResults = await Promise.allSettled(promises);
  const totalDuration = Date.now() - startAll;

  const values = allResults
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);
  const successful = values.filter((v) => v.success).length;
  const failed = allResults.length - successful;
  const durations = values.map((v) => v.duration);
  const avgDuration =
    durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const maxDuration = durations.length ? Math.max(...durations) : 0;
  const minDuration = durations.length ? Math.min(...durations) : 0;

  console.log('\n📊 Results:');
  console.log(`   Total requests: ${allResults.length}`);
  console.log(`   Successful: ${successful} ✅`);
  console.log(`   Failed: ${failed} ❌`);
  console.log(`   Total time: ${totalDuration}ms`);
  console.log(`   Avg response: ${Math.round(avgDuration)}ms`);
  console.log(`   Min response: ${minDuration}ms`);
  console.log(`   Max response: ${maxDuration}ms`);
  console.log(
    `   Requests/sec: ${totalDuration > 0 ? (allResults.length / (totalDuration / 1000)).toFixed(1) : 0}`
  );

  if (failed > 0) {
    console.log('\n⚠️  Some requests failed. Check Railway logs.');
    process.exit(1);
  } else {
    console.log('\n✅ All requests succeeded!');
  }
}

runConcurrentTest().catch(console.error);
