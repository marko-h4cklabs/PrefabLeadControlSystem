/**
 * Managed crawl API (Firecrawl-compatible) for JS-rendering.
 * Uses SCRAPER_API_KEY, SCRAPER_MAX_PAGES, SCRAPER_TIMEOUT_MS.
 */

const SCRAPER_BASE = process.env.SCRAPER_BASE_URL || 'https://api.firecrawl.dev/v1';
const USE_V2 = process.env.SCRAPER_USE_V2 === 'true';
const MAX_PAGES = parseInt(process.env.SCRAPER_MAX_PAGES, 10) || 20;
const TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS, 10) || 45000;

async function startCrawl(websiteUrl) {
  const apiKey = process.env.SCRAPER_API_KEY?.trim();
  if (!apiKey) throw new Error('SCRAPER_API_KEY is required');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const base = USE_V2 ? 'https://api.firecrawl.dev/v2' : SCRAPER_BASE;
    const res = await fetch(`${base}/crawl`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: websiteUrl,
        limit: MAX_PAGES,
        scrapeOptions: USE_V2 ? { formats: ['markdown'] } : { formats: ['markdown', 'html'] },
      }),
      signal: controller.signal,
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.message || `Crawl API error: ${res.status}`);
    return data.id || data.crawlId;
  } finally {
    clearTimeout(timeout);
  }
}

async function pollCrawlStatus(crawlId) {
  const apiKey = process.env.SCRAPER_API_KEY?.trim();
  const base = USE_V2 ? 'https://api.firecrawl.dev/v2' : SCRAPER_BASE;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/crawl/${crawlId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Poll error: ${res.status}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function crawlWebsite(websiteUrl) {
  const crawlId = await startCrawl(websiteUrl);
  const maxAttempts = 60;
  const pollInterval = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    const status = await pollCrawlStatus(crawlId);
    const st = status.status || status.state;
    if (st === 'completed' || st === 'done') {
      const rawPages = Array.isArray(status.data) ? status.data : [];
      return rawPages.map((p) => {
        const url = p.metadata?.sourceURL || p.url || p.sourceURL || p.link || websiteUrl;
        const title = p.metadata?.title ?? p.title ?? null;
        const md = p.markdown ?? p.content ?? null;
        return {
          url,
          title: Array.isArray(title) ? title[0] : title,
          content_markdown: md,
          content_text: p.html ? stripHtml(p.html) : md,
          content_hash: p.metadata?.hash ?? p.hash ?? null,
        };
      });
    }
    if (st === 'failed' || st === 'error') {
      throw new Error(status.error || status.message || 'Crawl failed');
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error('Crawl timed out');
}

function stripHtml(html) {
  if (!html || typeof html !== 'string') return null;
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { crawlWebsite };
