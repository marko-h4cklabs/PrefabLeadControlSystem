const Anthropic = require('@anthropic-ai/sdk');
const {
  companyRepository,
  qualificationFieldRepository,
  conversationRepository,
} = require('../db/repositories');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';

function buildSystemPrompt(company, fields, parsedFields) {
  const style = company.chatbot_style ?? {};
  const tone = style.tone || 'professional';
  const forbidden = (style.forbidden_topics ?? []).join(', ') || 'none';
  const duration = style.response_duration || 'concise';

  const requiredFields = (fields ?? []).filter((f) => f.required);
  const missingRequired = requiredFields.filter((f) => !parsedFields[f.field_key]);
  const fieldsDesc = (fields ?? [])
    .map((f) => `- ${f.field_key} (${f.field_type}${f.units ? `, ${f.units}` : ''})${f.required ? ' [required]' : ''}`)
    .join('\n');

  return `You are a sales assistant for ${company.name}, a prefabricated/modular construction company.

SCOPE: Stay strictly within prefab/modular construction sales. Do not discuss unrelated topics.

TONE: ${tone}. Response style: ${duration}.
FORBIDDEN TOPICS: ${forbidden}.

QUALIFICATION FIELDS:
${fieldsDesc || '(none configured)'}

CURRENT PARSED FIELDS (already collected): ${JSON.stringify(parsedFields)}
MISSING REQUIRED FIELDS: ${missingRequired.map((f) => f.field_key).join(', ') || 'none'}

TASK:
1. Reply naturally in the company's tone.
2. If the user provided information that maps to a qualification field, extract it into field_updates.
3. If required fields are still missing, gently ask for the next one (prioritize by display_order).
4. Set done=true only when all required fields are collected and the user seems ready to proceed (e.g., wants a quote, appointment).

OUTPUT FORMAT: You MUST respond with valid JSON only, no other text:
{
  "assistant_message": "your reply to the user",
  "field_updates": { "<field_key>": <value> },
  "done": false
}

For field_updates: use the exact field_key. Values: numbers for currency/number, strings for text, ISO date for date. Omit field_updates entirely {} if nothing to extract.
For assistant_message: write a natural, human reply. Keep it ${duration}.`;
}

function buildUserPrompt(messages) {
  const history = (messages ?? [])
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  return `Conversation so far:\n${history || '(no messages yet)'}\n\nGenerate the next assistant reply as JSON.`;
}

async function callClaude(systemPrompt, userPrompt) {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textBlock = response.content?.find((b) => b.type === 'text');
  return textBlock?.text ?? '';
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
  if (typeof parsed.done !== 'boolean') {
    parsed.done = false;
  }

  return {
    assistant_message: parsed.assistant_message,
    field_updates: parsed.field_updates ?? {},
    done: parsed.done,
  };
}

async function generateAiReply(companyId, leadId) {
  const company = await companyRepository.findById(companyId);
  if (!company) {
    throw new Error('Company not found');
  }

  const fields = await qualificationFieldRepository.findAll(companyId);
  let conversation = await conversationRepository.getByLeadId(leadId);
  if (!conversation) {
    conversation = await conversationRepository.createIfNotExists(leadId);
  }

  const parsedFields = conversation.parsed_fields ?? {};
  const systemPrompt = buildSystemPrompt(company, fields, parsedFields);
  const userPrompt = buildUserPrompt(conversation.messages);

  const rawOutput = await callClaude(systemPrompt, userPrompt);
  console.log('[aiReplyService] Raw Claude output:', rawOutput);

  const result = parseClaudeOutput(rawOutput);
  return { ...result, leadId };
}

module.exports = { generateAiReply };
