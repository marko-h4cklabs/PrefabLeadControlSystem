const Anthropic = require('@anthropic-ai/sdk');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function buildExtractionPrompt(quoteFields) {
  const fieldNames = (quoteFields || []).map((f) => f.name).filter(Boolean);
  const fieldsDesc = (quoteFields || [])
    .map((f) => `- ${f.name}: ${f.type}${f.units ? ` (${f.units})` : ''}${f.required ? ' [required]' : ''}`)
    .join('\n');
  return `You extract quote field values from user messages. Output ONLY valid JSON, no other text.

CONFIGURED FIELDS (you may ONLY extract these - no other fields):
${fieldsDesc || '(none)'}

Allowed field names: ${fieldNames.join(', ') || 'none'}

Rules:
- ONLY output values for the configured fields above. Do NOT extract doors, windows, placement, or any field not in the list.
- For type "number": extract numeric value. Accept "12000", "12,000", "€12000", etc.
- For type "text": extract the value. Use exact field names from the list.
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

function getAllowedFieldNames(quoteFields) {
  return new Set((quoteFields ?? []).map((f) => String(f.name ?? '').toLowerCase().trim()).filter(Boolean));
}

async function extractFieldsWithClaude(userMessage, quoteFields) {
  const missingRequiredFallback = allRequiredAsMissing(quoteFields);
  const allowedNames = getAllowedFieldNames(quoteFields);
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
    const normalized = extracted
      .filter((e) => e?.name != null && e?.value != null)
      .map((e) => {
        const name = String(e.name ?? '').trim();
        const type = (e.type ?? 'text').toLowerCase() === 'number' ? 'number' : 'text';
        let value = e.value;
        if (type === 'number' && value != null) {
          const num = Number(value);
          value = Number.isFinite(num) ? num : value;
        } else if (type === 'text' && value != null) {
          value = String(value).trim();
        }
        return { name, value, type, units: e.units ?? null, confidence: typeof e.confidence === 'number' ? e.confidence : 0.9 };
      })
      .filter((e) => e.name !== '' && allowedNames.has(e.name.toLowerCase()));
    return {
      extracted: normalized,
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

module.exports = { extractFieldsWithClaude, allRequiredAsMissing, getAllowedFieldNames };
