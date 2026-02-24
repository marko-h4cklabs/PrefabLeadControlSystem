/**
 * Detects common sales objections from the lead's message and returns a hint for the AI.
 */
const OBJECTION_PATTERNS = {
  price_too_high: {
    patterns: [
      'too expensive',
      'too much',
      'cant afford',
      "can't afford",
      'out of budget',
      'too pricey',
      'price is high',
    ],
    response_hint:
      'Acknowledge their concern, reframe around ROI and value, ask what budget they had in mind',
  },
  not_interested: {
    patterns: ['not interested', 'no thanks', 'not for me', 'pass', 'not now'],
    response_hint:
      'Acknowledge gracefully, ask one curious question to understand why, do not push hard',
  },
  need_to_think: {
    patterns: [
      'need to think',
      'let me think',
      'ill think about it',
      'maybe later',
      'not sure yet',
    ],
    response_hint:
      'Validate their need to think, ask what specific question or concern is holding them back',
  },
  already_have_solution: {
    patterns: ['already have', 'using someone else', 'current provider', 'happy with'],
    response_hint:
      'Show genuine curiosity about their current setup, find a gap or improvement angle without bashing competitors',
  },
  no_time: {
    patterns: ['no time', 'too busy', 'very busy', 'not a good time'],
    response_hint:
      'Respect their time, offer a shorter format or a specific quick time commitment',
  },
  send_info: {
    patterns: [
      'send me info',
      'send more info',
      'send me details',
      'email me',
      'send it over',
    ],
    response_hint:
      'Offer to send info AND ask one qualifying question to personalize what you send',
  },
};

function detectObjection(message) {
  if (!message || typeof message !== 'string') return null;
  const lower = message.toLowerCase();
  for (const [type, data] of Object.entries(OBJECTION_PATTERNS)) {
    if (data.patterns.some((p) => lower.includes(p))) {
      return { type, hint: data.response_hint };
    }
  }
  return null;
}

module.exports = { detectObjection, OBJECTION_PATTERNS };
