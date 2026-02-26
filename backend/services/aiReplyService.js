const { claudeWithRetry } = require('../src/utils/claudeWithRetry');
const { pool } = require('../db');
const {
  conversationRepository,
  chatbotBehaviorRepository,
  chatbotCompanyInfoRepository,
  chatbotQuoteFieldsRepository,
  chatAttachmentRepository,
  companyRepository,
  leadRepository,
  schedulingRequestRepository,
} = require('../db/repositories');
const { createNotification } = require('../src/services/notificationService');
const { extractFieldsWithClaude, getAllowedFieldNames } = require('../src/chat/extractService');
const { dimensionsToDisplayString } = require('../src/chat/dimensionsFormat');
const { computeFieldsState } = require('../src/chat/fieldsState');
const { buildSystemPrompt, buildLeadContext } = require('../src/services/systemPromptBuilder');
const { buildFieldQuestion } = require('../src/chat/systemPrompt');
const { detectObjection } = require('../src/services/objectionHandler');
const { validateAndCleanReply, checkReplyQuality } = require('../src/services/replyValidator');
const { enforceStyle } = require('../src/chat/enforceStyle');
const {
  shouldGreet,
  shouldClose,
  prependGreeting,
  appendClosing,
} = require('../src/chat/conversationHelpers');
const { generateGreeting, generateClosing } = require('../src/chat/greetingClosingService');
const { buildHighlights } = require('../src/chat/fieldsState');
const { picturesToCollected, attachmentsToPicturesCollected } = require('../src/chat/picturesHelpers');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function parsedFieldsToCollected(parsedFields, quoteFields) {
  const quoteByName = Object.fromEntries((quoteFields ?? []).map((f) => [f.name, f]));
  return Object.entries(parsedFields ?? {})
    .filter(([key, v]) => {
      if (key.startsWith('__')) return false;
      if (v == null) return false;
      if (typeof v === 'object' && !Array.isArray(v)) return false;
      if (Array.isArray(v)) return v.length > 0;
      return typeof v !== 'string' || v.trim() !== '';
    })
    .map(([name, value]) => {
      const qf = quoteByName[name];
      let displayValue = value;
      if (name === 'dimensions' && value != null) {
        const str = dimensionsToDisplayString(value, qf?.config);
        if (str) displayValue = str;
        else return null;
      }
      const type = name === 'pictures' ? 'pictures' : (qf?.type ?? 'text');
      const base = { name, type, units: qf?.units ?? null, priority: qf?.priority ?? 100 };
      if (name === 'pictures') {
        const { value: urls, links } = picturesToCollected(displayValue);
        return { ...base, value: urls, links };
      }
      return { ...base, value: displayValue };
    })
    .filter(Boolean);
}

function filterOutPicturesFromUpdates(updates) {
  if (!updates || typeof updates !== 'object') return updates ?? {};
  return Object.fromEntries(Object.entries(updates).filter(([k]) => k.toLowerCase() !== 'pictures'));
}

function mergeParsedFields(current, updates, allowedFieldNames, quoteFields = []) {
  const merged = { ...current };
  const allowed = allowedFieldNames ? new Set([...allowedFieldNames].map((s) => String(s).toLowerCase())) : null;
  const dimensionsField = (quoteFields ?? []).find((f) => f.name === 'dimensions');
  const dimensionsConfig = dimensionsField?.config ?? {};
  for (const [key, value] of Object.entries(updates ?? {})) {
    if (key.toLowerCase() === 'pictures') continue; // Pictures: attachments-only, never overwrite from Claude
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) continue;
    if (allowed && !allowed.has(String(key).toLowerCase())) continue;
    let finalValue = value;
    if (key === 'dimensions' && value != null && typeof value === 'object' && !Array.isArray(value)) {
      const str = dimensionsToDisplayString(value, dimensionsConfig);
      if (str) finalValue = str;
    }
    merged[key] = finalValue;
  }
  return merged;
}

async function callClaude(systemPrompt, messages, maxTokens = 1024) {
  const { content } = await claudeWithRetry({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });
  return content ?? '';
}

function detectBookingConfirmation(incomingMessage, conversationMessages, behavior) {
  if (!behavior?.booking_trigger_enabled) return false;
  const messages = conversationMessages ?? [];
  const lastAiMessages = messages
    .filter((m) => m.role === 'assistant')
    .slice(-2)
    .map((m) => m.transcription || m.content || '');
  const bookingWasOffered = lastAiMessages.some(
    (m) =>
      m.toLowerCase().includes('book') ||
      m.toLowerCase().includes('calendar') ||
      m.toLowerCase().includes('schedule') ||
      m.toLowerCase().includes('set up a call') ||
      m.toLowerCase().includes('calendly')
  );
  if (!bookingWasOffered) return false;
  const acceptPhrases = [
    'yes',
    'sure',
    'okay',
    'ok',
    'sounds good',
    'perfect',
    "let's do it",
    'book it',
    'go ahead',
    'yes please',
  ];
  const lower = (incomingMessage || '').toLowerCase();
  return acceptPhrases.some((p) => lower.includes(p));
}

async function handleBookingFlow(lead, company, behavior, conversation, companyId) {
  try {
    await schedulingRequestRepository.create({
      companyId,
      leadId: lead.id,
      conversationId: conversation?.id ?? null,
      source: 'chatbot',
      status: 'open',
      requestType: 'call',
      notes: 'Requested via AI chat',
    });
    const leadName = lead?.name || lead?.external_id || 'Lead';
    await createNotification(
      companyId,
      'booking_requested',
      'Lead wants to book',
      `${leadName} accepted your booking offer`,
      lead.id
    );
  } catch (err) {
    console.error('[bookingFlow] Error:', err.message);
  }
}

function buildClaudeMessages(conversationMessages, incomingMessage) {
  const recentMessages = (conversationMessages || []).slice(-20);
  const claudeMessages = recentMessages
    .map((msg) => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.transcription || msg.content || '',
    }))
    .filter((m) => m.content.trim() !== '');

  if (claudeMessages.length > 0 && claudeMessages[0].role === 'assistant') {
    claudeMessages.unshift({ role: 'user', content: '[conversation started]' });
  }

  const lastMessage = claudeMessages[claudeMessages.length - 1];
  if (lastMessage?.role !== 'user') {
    claudeMessages.push({ role: 'user', content: incomingMessage || '' });
  }

  claudeMessages.push({
    role: 'user',
    content:
      'Generate the next assistant reply. Output ONLY valid JSON: {"assistant_message": "your reply text", "field_updates": {}}. No other text.',
  });
  return claudeMessages;
}

function parseClaudeOutput(raw) {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : trimmed;
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Invalid JSON from Claude: ${e.message}`);
  }
  if (typeof parsed.assistant_message !== 'string') {
    throw new Error('Claude response missing assistant_message string');
  }
  if (parsed.field_updates != null && typeof parsed.field_updates !== 'object') {
    throw new Error('Claude field_updates must be an object');
  }
  return {
    assistant_message: parsed.assistant_message,
    field_updates: parsed.field_updates ?? {},
    done: parsed.done === true,
  };
}

async function generateAiReply(companyId, leadId) {
  let conversation = await conversationRepository.getByLeadId(leadId);
  if (!conversation) {
    conversation = await conversationRepository.createIfNotExists(leadId, companyId);
  }

  const validTypes = ['text', 'number', 'select_multi', 'composite_dimensions', 'boolean', 'pictures'];
  const orderedQuoteFields = (conversation.quote_snapshot ?? [])
    .filter((f) => f && validTypes.includes(f.type))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  const [behavior, companyInfo, companyRecord, personaRow, lead, leadIntelligence, socialProofImagesRows] =
    await Promise.all([
      chatbotBehaviorRepository.get(companyId),
      chatbotCompanyInfoRepository.get(companyId),
      companyRepository.findById(companyId),
      pool.query('SELECT id, name, system_prompt, agent_name, tone, opener_style FROM chatbot_personas WHERE company_id = $1 AND is_active = true LIMIT 1', [companyId]).then((r) => r.rows[0] ?? null),
      leadRepository.findById(companyId, leadId),
      pool.query('SELECT intent_score, budget_detected, urgency_level, intent_tags, conversation_summary, pipeline_stage FROM leads WHERE id = $1 AND company_id = $2', [leadId, companyId]).then((r) => r.rows[0] ?? null),
      pool.query('SELECT id, url, caption, send_when_asked FROM social_proof_images WHERE company_id = $1 ORDER BY created_at ASC', [companyId]).then((r) => r.rows || []),
    ]);
  const socialProofImages = socialProofImagesRows || [];
  const activePersona = personaRow;
  const company = {
    name: companyRecord?.name || 'our company',
    business_description: companyInfo?.business_description ?? '',
    additional_notes: companyInfo?.additional_notes ?? '',
  };
  const leadForContext = lead && leadIntelligence ? { ...lead, ...leadIntelligence } : lead;

  const lastUserMsg = (conversation.messages ?? []).filter((m) => m.role === 'user').pop();
  const userText = lastUserMsg?.content ?? '';
  const assistantCountBefore = (conversation.messages ?? []).filter((m) => m.role === 'assistant').length;
  const allowedFieldNames = getAllowedFieldNames(orderedQuoteFields);

  let parsedFields = conversation.parsed_fields ?? {};

  const { extracted } = await extractFieldsWithClaude(userText, orderedQuoteFields);
  const extractedUpdates = {};
  for (const e of extracted ?? []) {
    if (e?.name && e.name.toLowerCase() !== 'pictures' && e?.value != null && String(e.value).trim() !== '') {
      extractedUpdates[e.name] = e.type === 'number' ? Number(e.value) : String(e.value).trim();
    }
  }
  parsedFields = mergeParsedFields(parsedFields, extractedUpdates, allowedFieldNames, orderedQuoteFields);

  const collectedFromParsed = parsedFieldsToCollected(parsedFields, orderedQuoteFields);
  const { required_infos: requiredInfos, collected_infos: collectedInfos } = computeFieldsState(
    orderedQuoteFields,
    collectedFromParsed
  );
  const collectedMap = Object.fromEntries(collectedInfos.map((c) => [c.name, c.value]));
  const topMissing = requiredInfos[0] ?? null;

  console.info('[aiReplyService]', {
    endpoint: 'POST /leads/:leadId/ai-reply',
    companyId,
    leadId,
    behaviour: {
      persona_style: behavior?.persona_style,
      response_length: behavior?.response_length,
      emojis_enabled: behavior?.emojis_enabled,
    },
    quoteFieldsLoaded: { count: orderedQuoteFields.length, names: orderedQuoteFields.map((f) => f.name) },
    extractionOutput: extracted,
    required_infos_count: requiredInfos.length,
    collected_infos_count: collectedInfos.length,
  });

  let assistantMessage;

  if (requiredInfos.length > 0 && !userText.trim()) {
    assistantMessage = buildFieldQuestion(topMissing.name, behavior, topMissing.units);
  } else {
    let systemPrompt = await buildSystemPrompt(company, behavior, orderedQuoteFields, activePersona, socialProofImages);
    const leadContext = await buildLeadContext(leadForContext);
    systemPrompt += leadContext;
    const objection = detectObjection(userText);
    if (objection) {
      systemPrompt += `\n\nOBJECTION DETECTED: "${objection.type}"\nSuggested approach: ${objection.hint}`;
    }
    systemPrompt += '\n\nRespond with ONLY a JSON object: {"assistant_message": "your reply text", "field_updates": {}}. No other text.';

    try {
      console.log(
        '[aiReplyService] System prompt for company',
        companyId,
        'lead',
        leadId,
        ':\n',
        systemPrompt
      );
    } catch (e) {
      console.warn('[aiReplyService] Failed to log system prompt:', e.message);
    }

    const claudeMessages = buildClaudeMessages(conversation.messages, userText);
    const rawOutput = await callClaude(systemPrompt, claudeMessages);
    const parsed = parseClaudeOutput(rawOutput);
    let rawReply = parsed.assistant_message;
    const fieldUpdatesNoPictures = filterOutPicturesFromUpdates(parsed.field_updates);
    parsedFields = mergeParsedFields(parsedFields, fieldUpdatesNoPictures, allowedFieldNames, orderedQuoteFields);

    rawReply = validateAndCleanReply(rawReply, behavior);
    const qualityIssues = checkReplyQuality(rawReply);
    if (qualityIssues.length > 0) {
      console.warn('[aiReply] Quality issues detected:', qualityIssues);
    }
    assistantMessage = rawReply;

    const bookingConfirmed = detectBookingConfirmation(userText, conversation.messages, behavior);
    if (bookingConfirmed && lead) {
      await handleBookingFlow(lead, company, behavior, conversation, companyId);
    }
  }

  assistantMessage = enforceStyle(assistantMessage, behavior, {
    nextRequiredField: topMissing?.name,
    topMissingField: topMissing,
    allowedFieldNames,
  });

  let finalCollectedFromParsed = parsedFieldsToCollected(parsedFields, orderedQuoteFields);
  const picturesPreset = (orderedQuoteFields ?? []).find((f) => f?.name === 'pictures' && f?.is_enabled !== false);
  if (picturesPreset) {
    const hasPictures = finalCollectedFromParsed.some((c) => c.name === 'pictures');
    if (!hasPictures) {
      const attachments = await chatAttachmentRepository.getByLeadId(companyId, leadId);
      if (attachments.length > 0) {
        const baseUrl = process.env.BACKEND_URL || 'http://localhost:3000';
        const { value: urls, links } = attachmentsToPicturesCollected(attachments, baseUrl);
        finalCollectedFromParsed = [...finalCollectedFromParsed, { name: 'pictures', value: urls, links, type: 'pictures', units: null, priority: picturesPreset.priority ?? 100 }];
      }
    }
  }
  const { required_infos: finalRequired, collected_infos: finalCollected } = computeFieldsState(
    orderedQuoteFields,
    finalCollectedFromParsed
  );

  if (shouldGreet(assistantCountBefore)) {
    const greetingWords = await generateGreeting(userText, behavior);
    assistantMessage = prependGreeting(assistantMessage, greetingWords);
  }
  if (shouldClose(userText, finalRequired)) {
    const finalCollectedMap = Object.fromEntries(finalCollected.map((c) => [c.name, c.value]));
    const closingWords = await generateClosing(userText, finalCollectedMap, behavior);
    assistantMessage = appendClosing(assistantMessage, closingWords);
  }

  const highlights = buildHighlights(orderedQuoteFields, finalCollected, finalRequired, behavior);

  const allRequiredFromSnapshot = (orderedQuoteFields ?? [])
    .filter((f) => f?.required !== false)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    .map((f) => ({
      name: f.name ?? '',
      type: f.type ?? 'text',
      units: f.units ?? null,
      priority: f.priority ?? 100,
    }));

  return {
    assistant_message: assistantMessage,
    field_updates: parsedFields,
    leadId,
    conversation_id: conversation.id,
    parsed_fields: parsedFields,
    required_infos: allRequiredFromSnapshot,
    missing_required_infos: finalRequired,
    collected_infos: finalCollected,
    active_settings: {
      tone: behavior?.tone ?? 'professional',
      response_length: behavior?.response_length ?? 'medium',
      persona_style: behavior?.persona_style ?? 'busy',
      emojis_enabled: behavior?.emojis_enabled ?? false,
      forbidden_topics: Array.isArray(behavior?.forbidden_topics) ? behavior.forbidden_topics : [],
    },
    highlights,
  };
}


module.exports = { generateAiReply };
