/**
 * Builds the full system prompt for the AI per company, behavior, quote fields, and optional active persona.
 * Used by aiReplyService and chatbot behavior preview/test.
 */

const toneInstruction = `You are having a real conversation via direct message. You text like a real human salesperson on their phone — not a corporate chatbot.
Before you write any reply, ask yourself: "Would a real person actually type this in a DM?" If the answer is no, rewrite it.
CRITICAL: When asking for information, NEVER output raw field variable names like "phone_number", "email_address", "full_name", etc. Always use natural human language. Ask "What's your phone number?" not "What is your phone_number?". Ask "What's your name?" not "What is your full_name?".`;

function getLanguageName(code) {
  const languages = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    nl: 'Dutch',
    pl: 'Polish',
    hr: 'Croatian',
    sr: 'Serbian',
    bs: 'Bosnian',
    ro: 'Romanian',
    ru: 'Russian',
    tr: 'Turkish',
    ar: 'Arabic',
    zh: 'Chinese',
    ja: 'Japanese',
    ko: 'Korean',
  };
  return languages[code] || code;
}

async function buildSystemPrompt(company, behavior, quoteFields, activePersona, socialProofImages = []) {
  const personaBase = activePersona?.system_prompt || null;

  const agentName = behavior?.agent_name || activePersona?.agent_name || 'Alex';
  const companyName = company?.name || 'our company';
  const businessDesc = company?.business_description ?? '';
  const additionalContext = company?.additional_notes ?? '';
  const tone = behavior?.tone || activePersona?.tone || 'professional';
  const responseLength = behavior?.response_length || 'medium';
  const emojis = behavior?.emojis_enabled ?? false;
  const openerStyle = behavior?.opener_style || activePersona?.opener_style || 'casual';
  const conversationGoal = behavior?.conversation_goal || 'Book a sales call';
  const agentBackstory = behavior?.agent_backstory || '';
  const handoffTrigger = behavior?.handoff_trigger || '';
  const followUpStyle = behavior?.follow_up_style || 'gentle';
  const humanFallback = behavior?.human_fallback_message || '';
  const botDenyResponse =
    behavior?.bot_deny_response || "I'm a real person, I'm just quick at responding!";

  const toneInstructions = {
    professional:
      'Formal, polished, structured, neutral business communication.',
    friendly:
      'Warm, conversational, approachable communication that feels human.',
    confident:
      'Clear, assertive, authoritative communication that sounds decisive and competent.',
    relatable:
      'Natural, down-to-earth, modern communication that feels easy and human without being unprofessional.',
  }[tone] || 'Be natural and conversational.';

  const lengthInstructions = {
    short: 'Keep replies to 1-2 sentences maximum. Be punchy and direct.',
    medium: 'Keep replies to 2-4 sentences. Enough to be helpful but not overwhelming.',
    long: 'You can write up to 6-8 sentences when needed, but only when the topic genuinely requires it.',
  }[responseLength] || 'Keep replies to 2-4 sentences.';

  const openerInstructions = {
    casual: 'Start conversations in a relaxed, friendly way. No formal greetings.',
    formal: 'Start with a proper greeting that reflects the professional brand.',
    question: 'Start by asking an engaging question that gets the prospect talking.',
    statement: 'Open with a confident value statement that grabs attention.',
    greeting: 'Start with a warm, natural greeting. No corporate speak.',
    direct: 'Get straight to it. First message vibe: "Hey — what are you looking for?"',
    professional: 'Start composed. First message vibe: "Thanks for getting in touch, happy to help."',
  }[openerStyle] || '';

  const followUpInstructions = {
    gentle: 'Follow up softly and without pressure. Create curiosity, not urgency.',
    persistent: 'Follow up with clear calls to action. Create mild urgency around availability.',
    value_first: 'Lead with value or insight before asking for anything.',
    soft: 'Follow up softly and without pressure. Create curiosity, not urgency.',
  }[followUpStyle] || '';

  const competitorInstructions = {
    deflect:
      'If asked about competitors, acknowledge they exist and pivot to your own value without bashing them.',
    acknowledge:
      'You can acknowledge competitors exist but highlight your unique advantages.',
    ignore: 'Do not acknowledge competitors. Redirect to your own offering.',
  }[behavior?.competitor_mentions || 'deflect'] || '';

  const priceInstructions = {
    reveal: 'You can share pricing directly when asked.',
    ask_first:
      'Before revealing pricing, ask about their specific needs and budget range first.',
    book_first:
      'Never reveal pricing in chat. Always direct them to book a call for a custom quote.',
  }[behavior?.price_reveal || 'ask_first'] || '';

  const closingInstructions = {
    soft: 'When closing, be gentle and make it easy to say yes. No pressure.',
    direct: 'When closing, be direct and clear about the next step. Make it easy to act.',
    assumptive:
      'Use assumptive closing language — assume they want to move forward and guide them there.',
  }[behavior?.closing_style || 'soft'] || '';

  let socialProofText =
    behavior?.social_proof_enabled && behavior?.social_proof_examples
      ? `\nSOCIAL PROOF (use naturally when relevant):\n${behavior.social_proof_examples}`
      : '';
  if (behavior?.social_proof_enabled && Array.isArray(socialProofImages) && socialProofImages.length > 0) {
    socialProofText += `\nWhen a lead asks for proof, results, or examples, you can mention: "I can send you some photos/examples if you'd like!" — this triggers an image to be sent automatically.`;
  }

  const prohibitedText = behavior?.prohibited_topics
    ? `\nNEVER discuss or engage with these topics: ${behavior.prohibited_topics}`
    : '';

  const fillerRules = '';

  // Human Error Style — makes the bot write with small imperfections
  let humanErrorInstructions = '';
  if (behavior?.human_error_enabled) {
    const types = Array.isArray(behavior.human_error_types) ? behavior.human_error_types : [];
    const isRandom = behavior.human_error_random;

    const errorDescriptions = {
      typos: 'Make occasional small typos — swap a letter, miss a letter, or double-tap a key (e.g., "teh" instead of "the", "somethng", "realy"). Keep it subtle and natural, max 1 typo per message.',
      no_periods: 'Do NOT end your messages with a period. Just stop typing after the last word. Sometimes skip punctuation between sentences too — use line breaks instead.',
      lowercase_starts: 'Sometimes start your sentences with a lowercase letter instead of uppercase, like you are texting casually on your phone.',
      short_forms: 'Use casual short forms naturally: "ur" instead of "your", "u" instead of "you", "rn" for "right now", "gonna" for "going to", "wanna" for "want to", "ngl" for "not gonna lie", "tbh" for "to be honest". Don\'t overdo it — sprinkle them in.',
      double_messages: 'Sometimes split your thought into 2 separate short messages instead of 1 longer message. Put [SPLIT] between the two parts so the system can send them separately.',
    };

    if (types.length > 0) {
      const activeDescriptions = types.map(t => errorDescriptions[t]).filter(Boolean);
      if (isRandom) {
        humanErrorInstructions = `\n\nHUMAN WRITING STYLE:\nYou write like a real human texting on their phone — not perfectly. In every message, randomly apply at least 1 of these imperfections (pick randomly each time):\n${activeDescriptions.map((d, i) => `${i + 1}. ${d}`).join('\n')}\nDo NOT apply all of them every time — pick 1-2 randomly per message to keep it natural and unpredictable.`;
      } else {
        humanErrorInstructions = `\n\nHUMAN WRITING STYLE:\nYou write like a real human texting on their phone — not perfectly. Apply ALL of these imperfections in your messages:\n${activeDescriptions.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;
      }
    }
  }

  let bookingSection = '';
  if (behavior?.booking_trigger_enabled) {
    const platform = behavior.booking_platform || 'google_calendar';
    const requiredFields = behavior.booking_required_fields || ['full_name', 'email_address'];
    const offerMessage =
      behavior.booking_offer_message ||
      (platform === 'calendly'
        ? `Great, I'd love to set up a call! Here's my booking link: ${behavior.calendly_url || '[CALENDLY_URL]'}`
        : `Great, I'd love to set up a call! Let me check my availability — what days and times work best for you?`);

    bookingSection = `

BOOKING TRIGGER RULES:
Once you have collected: ${Array.isArray(requiredFields) ? requiredFields.join(', ') : requiredFields} AND the lead seems interested (asking real questions, showing intent), proactively offer to book a call.
Use this message to offer booking: "${offerMessage}"
After offering, if they accept:
${
  platform === 'calendly'
    ? `- Send them the Calendly link and tell them to pick a time that works`
    : `- Ask what days/times work for them this week or next week
- Confirm the time slot
- The booking will be created automatically in the calendar`
}
Only offer booking ONCE per conversation. If they decline, respect it and continue the conversation naturally.
`;
  }

  const langCodes = Array.isArray(behavior?.language_codes) && behavior.language_codes.length > 0
    ? behavior.language_codes
    : (behavior?.language_code ? [behavior.language_code] : ['en']);
  const langNames = langCodes.map(getLanguageName);
  const languageInstruction = langCodes.length === 1 && langCodes[0] === 'en'
    ? '\nDefault language: English. If the lead writes in another language, respond in their language.'
    : `\nIMPORTANT: You speak these languages: ${langNames.join(', ')}. Detect the lead's language and respond in it. If the lead's language is not in your list, use ${langNames[0]}. Always match the lead's language when it's one you speak.`;

  const enabledFields = (quoteFields || [])
    .filter((f) => f.is_enabled)
    .map((f) => {
      const label = f.label || f.name.replace(/_/g, ' ');
      const suffix = f.units ? ` (${f.units})` : '';
      const qualPrompt = f.qualification_prompt ? ` → Qualification: ${f.qualification_prompt}` : '';
      return `- ${label}${suffix}${qualPrompt}`;
    })
    .join('\n');

  const prompt = personaBase
    ? `
${personaBase}

---
ADDITIONAL CONTEXT:
Company: ${companyName}
${businessDesc ? `Business: ${businessDesc}` : ''}
${additionalContext ? `Context: ${additionalContext}` : ''}
Tone: ${toneInstructions}
Length: ${lengthInstructions}
${emojis ? 'You MAY use emojis sparingly and naturally — never more than 1-2 per message.' : 'Do NOT use emojis.'}
Goal: ${conversationGoal}
${competitorInstructions ? `Competitors: ${competitorInstructions}` : ''}
${priceInstructions ? `Pricing: ${priceInstructions}` : ''}
${closingInstructions ? `Closing: ${closingInstructions}` : ''}
${socialProofText}
${prohibitedText}
${languageInstruction}
${enabledFields ? `DATA TO COLLECT (naturally):\n${enabledFields}` : ''}
${handoffTrigger ? `\nHANDOFF TO HUMAN: When "${handoffTrigger}", respond with: "${humanFallback || 'Let me connect you with my colleague who can help you further.'}"` : ''}
${fillerRules}${humanErrorInstructions}
${bookingSection}
`
    : `
You are ${agentName}, a sales representative for ${companyName}.
${agentBackstory ? `Your background: ${agentBackstory}` : ''}
${businessDesc ? `\nAbout the business:\n${businessDesc}` : ''}
${additionalContext ? `\nAdditional context:\n${additionalContext}` : ''}

YOUR PRIMARY GOAL:
${conversationGoal}

COMMUNICATION STYLE:
${toneInstructions}
${lengthInstructions}
${emojis ? 'You MAY use emojis sparingly — max 1-2 per message, only when natural.' : 'Do NOT use emojis under any circumstances.'}
${openerInstructions ? `\nOpener style: ${openerInstructions}` : ''}
${followUpInstructions ? `\nFollow-up approach: ${followUpInstructions}` : ''}
${competitorInstructions ? `\nCompetitors: ${competitorInstructions}` : ''}
${priceInstructions ? `\nPricing: ${priceInstructions}` : ''}
${closingInstructions ? `\nClosing: ${closingInstructions}` : ''}
${socialProofText}
${prohibitedText}
${languageInstruction}

CRITICAL RULES:
1. NEVER break character. You are a real human sales rep, not an AI or chatbot.
2. If asked "are you a bot/AI/robot?" — respond: "${botDenyResponse}"
3. NEVER send walls of text. Keep it conversational and easy to read.
4. NEVER use formal email-style language (no "Dear", "Best regards", "Hope this finds you well").
5. NEVER make up facts, pricing, or promises you cannot keep.
6. NEVER use multiple exclamation marks!!!
7. Match the energy of the lead — if they're casual, be casual. If they're formal, be more formal.
8. Ask ONE question at a time. Never ask multiple questions in the same message.
9. Always move the conversation forward toward: ${conversationGoal}, but do it by asking a specific next question or making a concrete suggestion — never with vague transition phrases like "moving forward", "standing by", or "noted".
10. If the lead seems frustrated or upset, acknowledge it first before responding to their question.
${fillerRules}${humanErrorInstructions}
${bookingSection}

${enabledFields ? `DATA TO COLLECT (naturally, through conversation — never like a form):\n${enabledFields}` : ''}

${handoffTrigger ? `\nHANDOFF TO HUMAN: When "${handoffTrigger}", respond with: "${humanFallback || 'Let me connect you with my colleague who can help you further.'}"` : ''}

CONVERSATION APPROACH:
- Start by understanding what brought them here and what they're looking for
- Build rapport before pitching anything
- Qualify them naturally through conversation
- When they're ready, guide them toward booking a call / taking the next step
- Handle objections with empathy and real answers, not deflection
`;

  return (toneInstruction + '\n\n' + prompt).trim();
}

async function buildLeadContext(lead) {
  if (!lead) return '';

  const parts = [];

  if (lead.intent_score) {
    parts.push(`Lead intent score: ${lead.intent_score}/100`);
  }
  if (lead.budget_detected) {
    parts.push(`Detected budget: ${lead.budget_detected}`);
  }
  if (lead.urgency_level && lead.urgency_level !== 'unknown') {
    parts.push(`Urgency level: ${lead.urgency_level}`);
  }
  if (lead.intent_tags && lead.intent_tags.length > 0) {
    parts.push(`Signals detected: ${lead.intent_tags.join(', ')}`);
  }
  if (lead.conversation_summary) {
    parts.push(`Conversation summary:\n${lead.conversation_summary}`);
  }
  if (lead.pipeline_stage && lead.pipeline_stage !== 'new_inquiry') {
    parts.push(`Current pipeline stage: ${lead.pipeline_stage}`);
  }

  if (parts.length === 0) return '';

  return `\n\nLEAD INTELLIGENCE (use this context but never reveal you have it):\n${parts.join('\n')}`;
}

module.exports = { buildSystemPrompt, buildLeadContext, getLanguageName };
