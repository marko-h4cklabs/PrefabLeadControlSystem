const Anthropic = require('@anthropic-ai/sdk');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function buildExtractionPrompt(quoteFields) {
  const fieldsDesc = (quoteFields || [])
    .map((f) => `- ${f.name}: ${f.type}${f.units ? ` (${f.units})` : ''}`)
    .join('\n');
  return `You extract quote field values from user messages. Output ONLY valid JSON, no other text.

Fields to look for:
${fieldsDesc || '(none)'}

Rules:
- For type "number": extract numeric value. Accept "12000", "12,000", "€12000", "budget 12k", etc.
- For type "text": extract the value. Accept "location: Zagreb", "in Denver", "city is Berlin", etc.
- Only include fields where you found a clear value.
- Use exact field names as keys.

Output format:
{"extracted": {"fieldName": {"type":"text|number","value": <value>}}}

If nothing found: {"extracted": {}}`;
}

async function extractFieldsWithClaude(userMessage, quoteFields) {
  if (!quoteFields || quoteFields.length === 0) return {};
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const systemPrompt = buildExtractionPrompt(quoteFields);
  const response = await client.messages.create({
    model,
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  const textBlock = response.content?.find((b) => b.type === 'text');
  const raw = (textBlock?.text ?? '').trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : raw;
  try {
    const parsed = JSON.parse(jsonStr);
    const extracted = parsed?.extracted ?? {};
    return typeof extracted === 'object' ? extracted : {};
  } catch {
    return {};
  }
}

module.exports = { extractFieldsWithClaude };
