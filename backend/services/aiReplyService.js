const Anthropic = require('@anthropic-ai/sdk');
const {
  conversationRepository,
  chatbotBehaviorRepository,
  chatbotCompanyInfoRepository,
  chatbotQuoteFieldsRepository,
} = require('../db/repositories');
const { extractFieldsWithClaude, getAllowedFieldNames } = require('../src/chat/extractService');
const { computeFieldsState } = require('../src/chat/fieldsState');
const { buildSystemPrompt, buildFieldQuestion } = require('../src/chat/systemPrompt');
const { enforceStyle } = require('../src/chat/enforceStyle');
const { shouldGreet, shouldGoodbye, addGreeting, addGoodbye } = require('../src/chat/conversationHelpers');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function parsedFieldsToCollected(parsedFields, quoteFields) {
  const quoteByName = Object.fromEntries((quoteFields ?? []).map((f) => [f.name, f]));
  return Object.entries(parsedFields ?? {})
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([name, value]) => {
      const qf = quoteByName[name];
      return {
        name,
        value,
        type: qf?.type ?? 'text',
        units: qf?.units ?? null,
        priority: qf?.priority ?? 100,
      };
    });
}

function mergeParsedFields(current, updates, allowedFieldNames) {
  const merged = { ...current };
  const allowed = allowedFieldNames ? new Set([...allowedFieldNames].map((s) => String(s).toLowerCase())) : null;
  for (const [key, value] of Object.entries(updates ?? {})) {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) continue;
    if (allowed && !allowed.has(String(key).toLowerCase())) continue;
    merged[key] = value;
  }
  return merged;
}

async function callClaude(systemPrompt, userPrompt, maxTokens = 1024) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const textBlock = response.content?.find((b) => b.type === 'text');
  return textBlock?.text ?? '';
}

function buildUserPrompt(messages) {
  const history = (messages ?? [])
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  return `Conversation so far:\n${history || '(no messages yet)'}\n\nGenerate the next assistant reply. Output ONLY valid JSON: {"assistant_message": "your reply", "field_updates": {}}`;
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
  const [behavior, companyInfo, quoteFields] = await Promise.all([
    chatbotBehaviorRepository.get(companyId),
    chatbotCompanyInfoRepository.get(companyId),
    chatbotQuoteFieldsRepository.list(companyId),
  ]);

  const orderedQuoteFields = (quoteFields ?? [])
    .filter((f) => ['text', 'number'].includes(f.type))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  let conversation = await conversationRepository.getByLeadId(leadId);
  if (!conversation) {
    conversation = await conversationRepository.createIfNotExists(leadId);
  }

  const lastUserMsg = (conversation.messages ?? []).filter((m) => m.role === 'user').pop();
  const userText = lastUserMsg?.content ?? '';
  const assistantCountBefore = (conversation.messages ?? []).filter((m) => m.role === 'assistant').length;
  const allowedFieldNames = getAllowedFieldNames(orderedQuoteFields);

  let parsedFields = conversation.parsed_fields ?? {};

  const { extracted } = await extractFieldsWithClaude(userText, orderedQuoteFields);
  const extractedUpdates = {};
  for (const e of extracted ?? []) {
    if (e?.name && e?.value != null && String(e.value).trim() !== '') {
      extractedUpdates[e.name] = e.type === 'number' ? Number(e.value) : String(e.value).trim();
    }
  }
  parsedFields = mergeParsedFields(parsedFields, extractedUpdates, allowedFieldNames);

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
  } else if (requiredInfos.length > 0) {
    const systemPrompt = buildSystemPrompt(behavior, companyInfo, orderedQuoteFields, collectedMap, requiredInfos);
    const userPrompt = buildUserPrompt(conversation.messages);
    const rawOutput = await callClaude(systemPrompt, userPrompt);
    const parsed = parseClaudeOutput(rawOutput);
    assistantMessage = parsed.assistant_message;
    parsedFields = mergeParsedFields(parsedFields, parsed.field_updates, allowedFieldNames);
  } else {
    const systemPrompt = buildSystemPrompt(behavior, companyInfo, orderedQuoteFields, collectedMap, []);
    const userPrompt = buildUserPrompt(conversation.messages);
    const rawOutput = await callClaude(systemPrompt, userPrompt);
    const parsed = parseClaudeOutput(rawOutput);
    assistantMessage = parsed.assistant_message;
    parsedFields = mergeParsedFields(parsedFields, parsed.field_updates, allowedFieldNames);
  }

  assistantMessage = enforceStyle(assistantMessage, behavior, {
    nextRequiredField: topMissing?.name,
    topMissingField: topMissing,
    allowedFieldNames,
  });
  if (shouldGreet(assistantCountBefore)) {
    assistantMessage = addGreeting(assistantMessage, behavior);
  }

  const finalCollectedFromParsed = parsedFieldsToCollected(parsedFields, orderedQuoteFields);
  const { required_infos: finalRequired, collected_infos: finalCollected } = computeFieldsState(
    orderedQuoteFields,
    finalCollectedFromParsed
  );
  if (shouldGoodbye(userText, finalRequired)) {
    assistantMessage = addGoodbye(assistantMessage, behavior);
  }

  return {
    assistant_message: assistantMessage,
    field_updates: parsedFields,
    leadId,
    parsed_fields: parsedFields,
    required_infos: finalRequired,
    collected_infos: finalCollected,
  };
}


module.exports = { generateAiReply };
