const { pool } = require('../../db');
const { chatbotCompanyInfoRepository } = require('../../db/repositories');

const MAX_PAGES = 10;
const MAX_TOTAL_CHARS = 50000;
const REQUEST_TIMEOUT_MS = 10000;

function stripHtmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function extractSameOriginLinks(html, baseUrl) {
  const links = new Set();
  try {
    const base = new URL(baseUrl);
    const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = hrefRegex.exec(html)) !== null) {
      try {
        const href = m[1].trim();
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) continue;
        const resolved = new URL(href, base);
        if (resolved.origin === base.origin) {
          links.add(resolved.href);
        }
      } catch {
        /* ignore invalid URLs */
      }
    }
  } catch {
    /* ignore */
  }
  return [...links];
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PrefabLeadBot/1.0)' },
    });
    const html = await res.text();
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateSummaryWithFallback(scrapedText) {
  const truncated = (scrapedText || '').slice(0, 30000);
  if (!truncated.trim()) return 'No content could be extracted from the website.';

  const hasAnthropic = process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim() !== '';
  if (hasAnthropic) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: 'You are a business analyst. Summarize the scraped website content into a concise business description (2-4 paragraphs) suitable for a chatbot context. Focus on the company\'s offerings, services, and value proposition.',
        messages: [{ role: 'user', content: `Summarize this website content:\n\n${truncated}` }],
      });
      const textBlock = response.content?.find((b) => b.type === 'text');
      return (textBlock?.text ?? '').trim() || fallbackSummary(truncated);
    } catch (err) {
      console.error('[scrapeService] Anthropic error:', err.message);
      return fallbackSummary(truncated);
    }
  }
  return fallbackSummary(truncated);
}

function fallbackSummary(text) {
  const first = (text || '').slice(0, 2000).trim();
  const paragraphs = first.split(/\n\n+/).filter((p) => p.trim().length > 50).slice(0, 4);
  return paragraphs.join('\n\n') || first.slice(0, 500) || 'Content extracted from website.';
}

async function runScrapeJob(companyId) {
  const info = await chatbotCompanyInfoRepository.get(companyId);
  const websiteUrl = (info.website_url || '').trim();
  if (!websiteUrl) {
    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'error', {
      scrape_error: 'No website URL configured',
    });
    return;
  }

  try {
    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'running');

    const urlsToFetch = [websiteUrl];
    let totalText = '';
    const fetched = new Set();

    while (urlsToFetch.length > 0 && fetched.size < MAX_PAGES && totalText.length < MAX_TOTAL_CHARS) {
      const url = urlsToFetch.shift();
      if (fetched.has(url)) continue;
      fetched.add(url);

      let html;
      try {
        html = await fetchWithTimeout(url);
      } catch (err) {
        console.error('[scrapeService] Fetch error:', err.message);
        continue;
      }

      const text = stripHtmlToText(html);
      if (text) totalText += (totalText ? '\n\n' : '') + text.slice(0, MAX_TOTAL_CHARS - totalText.length);

      if (fetched.size === 1) {
        const links = extractSameOriginLinks(html, url);
        for (const l of links) {
          if (!fetched.has(l) && !urlsToFetch.includes(l)) urlsToFetch.push(l);
        }
      }
    }

    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'summarizing');

    const summary = await generateSummaryWithFallback(totalText);

    await pool.query(
      `UPDATE chatbot_company_info SET
        scrape_status = 'done',
        scraped_summary = $2,
        business_description = $2,
        scrape_finished_at = NOW(),
        updated_at = NOW()
       WHERE company_id = $1`,
      [companyId, summary]
    );
  } catch (err) {
    console.error('[scrapeService] Error:', err);
    const safeMsg = (err?.message || 'Scrape failed').slice(0, 500);
    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'error', {
      scrape_error: safeMsg,
    });
  }
}

function startScrapeJob(companyId) {
  setImmediate(() => runScrapeJob(companyId).catch((e) => console.error('[scrapeService] Job crash:', e)));
}

module.exports = { runScrapeJob, startScrapeJob };
