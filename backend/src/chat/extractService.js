const Anthropic = require('@anthropic-ai/sdk');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function buildExtractionPrompt(quoteFields) {
  const requiredFields = (quoteFields || []).filter((f) => f.required !== false);
  const fieldsDesc = (quoteFields || [])
    .map((f) => `- ${f.name}: ${f.type}${f.units ? ` (${f.units})` : ''}${f.required ? ' [required]' : ''}`)
    .join('\n');
  return `You extract quote field values from user messages. Output ONLY valid JSON, no other text.

Fields to look for:
${fieldsDesc || '(none)'}

Rules:
- For type "number": extract numeric value. Accept "12000", "12,000", "€12000", "budget 12k", etc.
- For type "text": extract the value. Accept "location: Zagreb", "in Denver", "city is Berlin", etc.
- Only include fields where you found a clear value. Use exact field names.
- Include confidence 0-1 for each extracted value.

Output format:
{"extracted":[{"name":"fieldName","value":<value>,"type":"text|number","units":null,"confidence":0.9}]}

If nothing found: {"extracted":[]}`;
}

function allRequiredAsMissing(quoteFields) {
  return (quoteFields || [])
    .filter((f) => f.required !== false)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    .map((f) => ({
      name: f.name,
      type: f.type,
      units: f.units ?? null,
      priority: f.priority ?? 100,
    }));
}

async function extractFieldsWithClaude(userMessage, quoteFields) {
  const missingRequiredFallback = allRequiredAsMissing(quoteFields);
  if (!quoteFields || quoteFields.length === 0) {
    return { extracted: [], missing_required: [] };
  }
  try {
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
    const parsed = JSON.parse(jsonStr);
    const extracted = Array.isArray(parsed?.extracted) ? parsed.extracted : [];
    return {
      extracted: extracted.filter((e) => e?.name && e?.value != null),
      missing_required: [],
    };
  } catch (err) {
    console.info('[extractService] extraction failed, returning empty:', err.message);
    return {
      extracted: [],
      missing_required: missingRequiredFallback,
    };
  }
}

module.exports = { extractFieldsWithClaude, allRequiredAsMissing };
