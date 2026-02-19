const PROMPT = `You are a business analyst. Produce a structured "deep dive" summary from the scraped website content.

Output sections:
- What the company does (2-4 sentences)
- Main services/products (bullets)
- Target customer / geography (bullets if inferable)
- Quote-relevant notes (bullets)

Format as a single cohesive text suitable for a chatbot business_description. Use clear section headers and bullet points where appropriate. Output ONLY the formatted text, no JSON.`;

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
