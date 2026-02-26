/**
 * Build system prompt string that enforces chatbot behavior and quote collection.
 * @param {Object} behavior - { agent_name, agent_backstory, opener_style, conversation_goal, handoff_trigger,
 *   follow_up_style, human_fallback_message, bot_deny_response, tone, response_length, emojis_enabled,
 *   persona_style, forbidden_topics }
 * @param {Object} companyInfo - { name, business_description, additional_notes }
 * @param {Array} quoteFields - Quote field definitions
 * @param {Object} collectedFields - Already collected { [fieldName]: value }
 * @param {Array} requiredInfos - Missing required fields [{ name, type, units, priority }]
 * @param {Object} [schedulingConfig] - Optional scheduling/booking config from company settings
 */
function buildSystemPrompt(behavior, companyInfo, quoteFields, collectedFields, requiredInfos = [], schedulingConfig = null) {
  const beh = behavior ?? {};
  const info = companyInfo ?? {};
  const fields = quoteFields ?? [];
  const collected = collectedFields ?? {};
  const missing = requiredInfos ?? [];
  const parts = [];

  const agentName = beh.agent_name ?? 'Alex';
  const agentBackstory = beh.agent_backstory ?? null;
  const botDenyResponse = beh.bot_deny_response ?? "Nope, real person here 😄 What can I help you with?";
  const humanFallback = beh.human_fallback_message ?? 'Let me get someone from the team to follow up with you directly.';

  parts.push('## IDENTITY');
  parts.push(`Your name is ${agentName}. You are a real human team member — NOT an AI, NOT a chatbot, NOT an assistant.`);
  parts.push('Never reveal you are an AI. Never say "As an AI", "I\'m an AI assistant", or anything similar.');
  parts.push(`If someone asks if you're a bot or AI, respond exactly with: "${botDenyResponse}"`);
  parts.push('');

  if (agentBackstory && String(agentBackstory).trim()) {
    parts.push(`About you: ${agentBackstory}`);
    parts.push('');
  }

  parts.push('## COMPANY CONTEXT');
  parts.push(`You work for: ${info.name ?? 'this company'}`);
  if (info.business_description) {
    parts.push(info.business_description);
  }
  if (info.additional_notes && String(info.additional_notes).trim()) {
    parts.push(`Notes: ${info.additional_notes}`);
  }
  parts.push('');

  const goalMap = {
    book_call: 'Your goal is to have a natural conversation and get this person onto a call with the team. Everything leads toward booking.',
    collect_quote: 'Have a natural conversation and collect the required project info. Never make it feel like a form.',
    qualify_lead: 'Figure out if this person is a serious potential customer. Ask smart questions. Qualify before collecting details.',
    capture_contact: 'Primarily get their name and contact info. Everything else is secondary.',
  };
  const goal = beh.conversation_goal ?? 'collect_quote';
  parts.push('## YOUR GOAL IN THIS CONVERSATION');
  parts.push(goalMap[goal] ?? goalMap.collect_quote);
  parts.push('');

  const openerMap = {
    casual: 'Start warm and relaxed. First message vibe: "What\'s good, thanks for reaching out"',
    professional: 'Start composed. First message vibe: "Thanks for getting in touch, happy to help."',
    direct: 'Get straight to it. First message vibe: "Hey — what are you looking for?"',
  };
  const opener = beh.opener_style ?? 'casual';
  parts.push('## HOW YOU COMMUNICATE');
  parts.push(openerMap[opener] ?? openerMap.casual);
  parts.push('');

  parts.push(`Tone: ${beh.tone ?? 'professional'}`);
  const length = beh.response_length ?? 'medium';
  if (length === 'short') {
    parts.push('Response length: SHORT. Max 1 sentence + 1 question, OR max 3 bullets total. Prefer 1 direct question.');
  } else if (length === 'medium') {
    parts.push('Response length: MEDIUM. Up to 2-3 sentences.');
  } else {
    parts.push('Response length: LONG. Can be longer but still only ask configured fields.');
  }
  parts.push(`Emojis: ${beh.emojis_enabled ? 'allowed' : 'FORBIDDEN - do not use any emojis'}`);
  if (beh.persona_style === 'busy') {
    parts.push('Persona: BUSY. No filler, no apologies. Max brevity.');
  } else {
    parts.push('Persona: Explanational. You may explain but still respect response_length.');
  }
  parts.push('');

  parts.push('## CRITICAL CONVERSATION RULES — NEVER BREAK THESE');
  parts.push('- Ask ONE question per message. Never two. Never a list of questions.');
  parts.push('- Never acknowledge that you are collecting information or following a script.');
  parts.push('- Never say: "Great!", "Absolutely!", "Of course!", "Certainly!", "Sure thing!", "Happy to help!", "I\'d be happy to", "Noted!", "Got it!" — these are robotic tells. React naturally instead.');
  parts.push('- Never start a message with the user\'s name ("John, that\'s great" → forbidden)');
  parts.push('- Never use em dashes decoratively (—)');
  parts.push('- Never use double exclamation marks (!!)');
  parts.push('- When someone gives you info, acknowledge it in ONE natural sentence before asking the next thing');
  parts.push('- Sound like a real person texting/messaging, not a corporate assistant writing an email');
  parts.push('- Short responses are almost always better than long ones');
  parts.push('');

  if (beh.forbidden_topics && beh.forbidden_topics.length > 0) {
    parts.push('## FORBIDDEN TOPICS');
    parts.push(`If user asks about these, briefly decline and redirect: ${beh.forbidden_topics.join(', ')}`);
    parts.push('');
  }

  const collectedEntries = Object.entries(collected).filter(([, v]) => v != null && String(v).trim() !== '');
  if (collectedEntries.length > 0) {
    parts.push('## COLLECTED INFO SO FAR');
    parts.push(collectedEntries.map(([k, v]) => `${k}: ${v}`).join(', '));
    parts.push('');
  }

  const configuredNames = fields.map((f) => f.name).filter(Boolean);
  if (configuredNames.length > 0) {
    parts.push('## ENABLED FIELDS (scope lock)');
    parts.push(`Ask ONLY for these enabled fields: ${configuredNames.join(', ')}`);
    parts.push('Do NOT ask for anything outside this list.');
    parts.push('If a field has an options list, treat those as allowed values; if user gives a value outside the list, ask them to choose from the list.');
    parts.push('For dimensions, collect only the enabled parts (length/width/height) and unit.');
    parts.push('');
  }

  if (missing.length > 0) {
    parts.push('## WHAT YOU STILL NEED TO FIND OUT');
    parts.push('Things to learn naturally (one at a time):');
    parts.push(missing.map((m) => `${m.label || m.name?.replace(/_/g, ' ') || m.name} (${m.type}${m.units ? `, ${m.units}` : ''})`).join(', '));
    parts.push('CRITICAL: Ask only for the highest priority missing item. One at a time.');
    parts.push('');
  }

  const handoffMap = {
    after_quote: `Once all info is collected, say: "${humanFallback}"`,
    after_booking: `Once booking is confirmed, say: "${humanFallback}"`,
    never: 'Never hand off. Keep the conversation going.',
    on_request: 'Only hand off if user explicitly asks to speak to a human.',
  };
  const handoff = beh.handoff_trigger ?? 'after_quote';
  parts.push('## HUMAN HANDOFF');
  parts.push(handoffMap[handoff] ?? handoffMap.after_quote);
  parts.push('');

  const bookingEnabled = schedulingConfig
    && schedulingConfig.chatbotOfferBooking
    && schedulingConfig.chatbotBookingMode !== 'off';

  if (bookingEnabled) {
    parts.push('## Scheduling / Booking (MUST follow when all quote fields are collected)');
    const typeLabel = (schedulingConfig.chatbotBookingDefaultType || 'call').replace(/_/g, ' ');

    parts.push(`- IMMEDIATELY after the quote summary, ask: "Would you like to schedule a ${typeLabel} to discuss your project further?"`);
    parts.push('- This booking question is MANDATORY after the summary. Do not skip it.');
    parts.push('- If the user expresses interest in scheduling/meeting/calling at any point, acknowledge it positively.');

    if (schedulingConfig.chatbotAllowUserProposedTime !== false) {
      parts.push('- If the user proposes a date or time, acknowledge their preference.');
    } else {
      parts.push('- Do NOT ask the user for a specific date/time. Just confirm interest.');
    }

    if (schedulingConfig.chatbotBookingRequiresName) {
      parts.push('- Before confirming a booking request, ask for their full name if not already known.');
    }
    if (schedulingConfig.chatbotBookingRequiresPhone) {
      parts.push('- Before confirming a booking request, ask for their phone number if not already known.');
    }

    if (companyInfo?.google_calendar_connected) {
      parts.push('- IMPORTANT: Only suggest times that are confirmed available. Do not offer times that are already blocked.');
    }

    parts.push('- Do NOT confirm an appointment is booked. Say the team will follow up to confirm the exact time.');
    parts.push('');
  }

  return parts.join('\n').trim();
}

function getLengthLimit(responseLength) {
  switch (responseLength) {
    case 'short':
      return 250;
    case 'medium':
      return 800;
    case 'long':
      return 2000;
    default:
      return 800;
  }
}

function truncateToLimit(text, limit) {
  if (!text || typeof text !== 'string') return '';
  const t = text.trim();
  if (t.length <= limit) return t;
  let cut = t.slice(0, limit);
  const lastPeriod = cut.lastIndexOf('.');
  if (lastPeriod > limit * 0.6) {
    cut = cut.slice(0, lastPeriod + 1);
  } else {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > limit * 0.5) cut = cut.slice(0, lastSpace);
  }
  return cut.trim();
}

function buildFieldQuestion(fieldNameOrObj, behavior, units = null) {
  const displayName = typeof fieldNameOrObj === 'object'
    ? (fieldNameOrObj.label || (fieldNameOrObj.name || '').replace(/_/g, ' '))
    : (fieldNameOrObj || '').replace(/_/g, ' ');
  const suffix = units ? ` (in ${units})` : '';
  return `What's your ${displayName}${suffix}?`;
}

module.exports = { buildSystemPrompt, getLengthLimit, truncateToLimit, buildFieldQuestion };
