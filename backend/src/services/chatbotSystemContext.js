/**
 * Pure function: assemble chatbot system context string from company info, behavior, and quote fields.
 */
function buildSystemContext(companyInfo, behavior, quoteFields) {
  const parts = [];
  const info = companyInfo ?? {};
  const beh = behavior ?? {};
  const fields = quoteFields ?? [];

  parts.push('## Company context');
  if (info.website_url) {
    parts.push(`Website: ${info.website_url}`);
  }
  if (info.business_description) {
    parts.push(`Business: ${info.business_description}`);
  }
  if (info.additional_notes) {
    parts.push(`Notes: ${info.additional_notes}`);
  }
  parts.push('Website content (once available) is treated as knowledge base.');

  parts.push('\n## Response style');
  parts.push(`Tone: ${beh.tone ?? 'professional'}`);
  parts.push(`Response length: ${beh.response_length ?? 'medium'}`);
  parts.push(`Emojis: ${beh.emojis_enabled ? 'enabled' : 'disabled'}`);
  if (beh.persona_style === 'busy') {
    parts.push('No fluff, no confirmations like "gotcha" or "noted". Be concise.');
  } else {
    parts.push('Persona: explanatory and helpful.');
  }

  if (beh.forbidden_topics && beh.forbidden_topics.length > 0) {
    parts.push('\n## Forbidden topics (do not discuss)');
    parts.push(beh.forbidden_topics.join(', '));
  }

  if (fields.length > 0) {
    parts.push('\n## Quote requirements');
    parts.push('Required fields must be collected. Collect these fields in priority order if the user has not provided them:');
    const sorted = [...fields].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    sorted.forEach((f) => {
      const req = f.required ? ' (required)' : '';
      const units = f.units ? ` [${f.units}]` : '';
      parts.push(`- ${f.name}: ${f.type}${units}${req}`);
    });
  }

  return parts.join('\n').trim();
}

module.exports = { buildSystemContext };
