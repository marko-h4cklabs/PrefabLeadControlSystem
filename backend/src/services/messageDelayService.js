/**
 * Smart Delay Service — debounces chatbot replies.
 *
 * When a message comes in and response_delay_seconds > 0:
 *   1. Any pending reply for that lead is cancelled
 *   2. A new timer starts for the configured delay
 *   3. If another message arrives before the timer fires, it resets
 *   4. Only after the timer expires (no new messages) does the reply proceed
 *
 * Usage:
 *   const shouldProceed = await messageDelayService.waitOrReset(leadId, delaySeconds);
 *   if (!shouldProceed) return; // superseded by a newer message
 */

const pendingReplies = new Map();

function waitOrReset(leadId, delaySeconds) {
  const existing = pendingReplies.get(leadId);
  if (existing) {
    existing.abort();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingReplies.delete(leadId);
      resolve(true);
    }, delaySeconds * 1000);

    pendingReplies.set(leadId, {
      abort: () => {
        clearTimeout(timer);
        pendingReplies.delete(leadId);
        resolve(false);
      },
      timestamp: Date.now(),
    });
  });
}

function hasPending(leadId) {
  return pendingReplies.has(leadId);
}

module.exports = { waitOrReset, hasPending };
