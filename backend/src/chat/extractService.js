const Anthropic = require('@anthropic-ai/sdk');
const { dimensionsToDisplayString } = require('./dimensionsFormat');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function buildExtractionPrompt(quoteFields) {
  const fields = quoteFields || [];
  const fieldNames = fields.map((f) => f.name).filter(Boolean);
  const fieldsDesc = fields
    .map((f) => {
      let line = `- ${f.name}: ${f.type}`;
      if (f.units) line += ` (${f.units})`;
      if (f.config?.units) line += ` allowed units: ${(f.config.units || []).join(', ')}`;
      if (f.config?.options?.length) line += ` allowed values: ${(f.config.options || []).slice(0, 20).join(', ')}${(f.config.options || []).length > 20 ? '...' : ''}`;
      if (f.config?.enabledParts?.length) line += ` parts: ${(f.config.enabledParts || []).join(', ')}`;
      if (f.type === 'boolean') line += ' (yes/no, true/false)';
      if (f.required !== false) line += ' [required]';
      return line;
    })
    .join('\n');
  return `You extract quote field values from user messages. Output ONLY valid JSON, no other text.

ENABLED FIELDS (you may ONLY extract these - no other fields):
${fieldsDesc || '(none)'}

Allowed field names: ${fieldNames.join(', ') || 'none'}

Rules:
- ONLY output values for the enabled fields above. Do NOT extract any field not in the list.
- For type "number": extract numeric value. Use exact field names.
- For type "text": extract the value. For email_address validate email format; for phone_number validate phone format.
- For type "boolean" (e.g. pictures): extract yes/no or true/false. Store as "true" or "false" string.
- For type "select_multi": if options list exists, value must be from that list or a valid subset. For time_window, object_type, ground_condition, utility_connections, completion_level: extract as string or list.
- For type "composite_dimensions": extract length, width, height (as numbers) and unit. Output as object {"length":N,"width":N,"height":N,"unit":"m"} - backend will normalize to string.
- Include confidence 0-1 for each extracted value.

Output format:
{"extracted":[{"name":"fieldName","value":<value>,"type":"text|number|boolean","units":null,"confidence":0.9}]}

If nothing found: {"extracted":[]}`;
}

function allRequiredAsMissing(quoteFields) {
  return (quoteFields || [])
    .filter((f) => f?.is_enabled !== false && f.required !== false)
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
    const dimensionsField = (quoteFields ?? []).find((f) => f.name === 'dimensions');
    const dimensionsConfig = dimensionsField?.config ?? {};

    const normalized = extracted
      .filter((e) => e?.name != null && e?.value != null)
      .map((e) => {
        const name = String(e.name ?? '').trim();
        const rawType = (e.type ?? 'text').toLowerCase();
        const type = rawType === 'number' ? 'number' : rawType === 'boolean' ? 'boolean' : 'text';
        let value = e.value;
        if (type === 'number' && value != null) {
          const num = Number(value);
          value = Number.isFinite(num) ? num : value;
        } else if (type === 'boolean' && value != null) {
          const v = String(value).toLowerCase();
          value = ['true', 'yes', '1'].includes(v) ? 'true' : 'false';
        } else if (type === 'text' && value != null) {
          value = String(value).trim();
        }
        if (name === 'dimensions' && value != null) {
          const str = dimensionsToDisplayString(value, dimensionsConfig);
          if (str) value = str;
          return { name, value, type: 'text', units: e.units ?? null, confidence: typeof e.confidence === 'number' ? e.confidence : 0.9 };
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
