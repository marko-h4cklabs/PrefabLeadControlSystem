/**
 * Pure function: assemble chatbot system context string from company info, behavior, and quote fields.
 */
function buildSystemContext(companyInfo, behavior, quoteFields) {
  const parts = [];

  parts.push('## Company context');
  if (companyInfo.website_url) {
    parts.push(`Website: ${companyInfo.website_url}`);
  }
  if (companyInfo.business_description) {
    parts.push(`Business: ${companyInfo.business_description}`);
  }
  if (companyInfo.additional_notes) {
    parts.push(`Notes: ${companyInfo.additional_notes}`);
  }
  parts.push('Website content (once available) is treated as knowledge base.');

  parts.push('\n## Response style');
  parts.push(`Tone: ${behavior.tone}`);
  parts.push(`Response length: ${behavior.response_length}`);
  parts.push(`Emojis: ${behavior.emojis_enabled ? 'enabled' : 'disabled'}`);
  if (behavior.persona_style === 'busy') {
    parts.push('No fluff, no confirmations like "gotcha" or "noted". Be concise.');
  } else {
    parts.push('Persona: explanatory and helpful.');
  }

  if (behavior.forbidden_topics && behavior.forbidden_topics.length > 0) {
    parts.push('\n## Forbidden topics (do not discuss)');
    parts.push(behavior.forbidden_topics.join(', '));
  }

  if (quoteFields && quoteFields.length > 0) {
    parts.push('\n## Quote requirements');
    parts.push('Collect these fields in priority order if the user has not provided them:');
    const sorted = [...quoteFields].sort((a, b) => a.priority - b.priority);
    sorted.forEach((f) => {
      const req = f.required ? ' (required)' : '';
      const units = f.units ? ` [${f.units}]` : '';
      parts.push(`- ${f.name}: ${f.type}${units}${req}`);
    });
  }

  return parts.join('\n').trim();
}

module.exports = { buildSystemContext };
