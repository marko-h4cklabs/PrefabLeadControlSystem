/**
 * Builds the full system prompt for the AI per company, behavior, quote fields, and optional active persona.
 * Used by aiReplyService and chatbot behavior preview/test.
 */

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

async function buildSystemPrompt(company, behavior, quoteFields, activePersona) {
  const personaBase = activePersona?.system_prompt || null;

  const agentName = behavior?.agent_name || activePersona?.agent_name || 'Alex';
  const companyName = company?.name || 'our company';
  const businessDesc = company?.business_description ?? '';
  const additionalContext = company?.additional_notes ?? '';
  const tone = behavior?.persona_style || activePersona?.tone || behavior?.tone || 'professional';
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
      'Be professional, polished, and credible. Use clear business language. Avoid slang.',
    friendly:
      'Be warm, approachable, and personable. Use conversational language. Feel like a friend.',
    casual:
      'Be very relaxed and informal. Use everyday language, contractions, and feel natural.',
    direct: 'Be concise and straight to the point. No fluff. Every sentence has a purpose.',
    empathetic:
      'Be understanding and supportive. Acknowledge feelings before providing information.',
    humorous: 'Be light-hearted with appropriate humor. Keep it professional but fun.',
    busy: 'Be brief and efficient. No filler. No unnecessary apologies.',
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

  const socialProofText =
    behavior?.social_proof_enabled && behavior?.social_proof_examples
      ? `\nSOCIAL PROOF (use naturally when relevant):\n${behavior.social_proof_examples}`
      : '';

  const prohibitedText = behavior?.prohibited_topics
    ? `\nNEVER discuss or engage with these topics: ${behavior.prohibited_topics}`
    : '';

  const languageInstruction =
    behavior?.language_code && behavior.language_code !== 'en'
      ? `\nIMPORTANT: Respond in ${getLanguageName(behavior.language_code)} unless the lead writes in a different language, in which case match their language.`
      : '\nDefault language: English. If the lead writes in another language, respond in their language.';

  const enabledFields = (quoteFields || [])
    .filter((f) => f.is_enabled)
    .map((f) => `- ${f.label || f.name}`)
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
9. Always move the conversation forward toward: ${conversationGoal}
10. If the lead seems frustrated or upset, acknowledge it first before responding to their question.

${enabledFields ? `DATA TO COLLECT (naturally, through conversation — never like a form):\n${enabledFields}` : ''}

${handoffTrigger ? `\nHANDOFF TO HUMAN: When "${handoffTrigger}", respond with: "${humanFallback || 'Let me connect you with my colleague who can help you further.'}"` : ''}

CONVERSATION APPROACH:
- Start by understanding what brought them here and what they're looking for
- Build rapport before pitching anything
- Qualify them naturally through conversation
- When they're ready, guide them toward booking a call / taking the next step
- Handle objections with empathy and real answers, not deflection
`;

  return prompt.trim();
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
