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

/**
 * @param {string} leadId
 * @param {number} delaySeconds - fixed delay (used when random is off)
 * @param {object} [opts]
 * @param {number} [opts.minSeconds] - minimum random delay
 * @param {number} [opts.maxSeconds] - maximum random delay
 * @param {boolean} [opts.randomEnabled] - whether to use random interval
 */
function waitOrReset(leadId, delaySeconds, opts = {}) {
  const existing = pendingReplies.get(leadId);
  if (existing) {
    existing.abort();
  }

  let actualDelay = delaySeconds;
  if (opts.randomEnabled && opts.minSeconds != null && opts.maxSeconds != null && opts.maxSeconds > opts.minSeconds) {
    actualDelay = opts.minSeconds + Math.random() * (opts.maxSeconds - opts.minSeconds);
    console.log(`[messageDelay] Random delay for lead ${leadId}: ${actualDelay.toFixed(1)}s (range ${opts.minSeconds}-${opts.maxSeconds}s)`);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingReplies.delete(leadId);
      resolve(true);
    }, actualDelay * 1000);

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
