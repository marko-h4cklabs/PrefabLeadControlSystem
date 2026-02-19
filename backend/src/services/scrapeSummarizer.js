const PROMPT = `You are a business analyst. Summarize the scraped website content into a structured format.

Output a JSON object with these keys (use empty string or empty array if not found):
- company_overview: string (2-4 sentences about the company)
- services: array of strings (bullet points of services)
- locations_service_area: string (locations or service area if present)
- quote_notes: string (anything relevant for quoting/sales)

Then convert to a single formatted paragraph suitable for a chatbot business_description. Use the format:
Paragraph 1: company_overview.
Paragraph 2: Services: [bullet list]. [locations if present].
Paragraph 3: [quote_notes if present].

Output ONLY the final formatted paragraph string, no JSON.`;

function fallbackSummary(text) {
  const first = (text || '').slice(0, 2000).trim();
  const paragraphs = first.split(/\n\n+/).filter((p) => p.trim().length > 50).slice(0, 4);
  return paragraphs.join('\n\n') || first.slice(0, 500) || 'Content extracted from website.';
}

async function summarizeWithLLM(scrapedText) {
  const truncated = (scrapedText || '').slice(0, 30000);
  if (!truncated.trim()) return 'No content could be extracted from the website.';

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return fallbackSummary(truncated);

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: PROMPT,
      messages: [{ role: 'user', content: `Summarize this website content:\n\n${truncated}` }],
    });
    const textBlock = response.content?.find((b) => b.type === 'text');
    const result = (textBlock?.text ?? '').trim();
    return result || fallbackSummary(truncated);
  } catch (err) {
    console.error('[scrapeSummarizer] Anthropic error:', err.message);
    return fallbackSummary(truncated);
  }
}

module.exports = { summarizeWithLLM };
