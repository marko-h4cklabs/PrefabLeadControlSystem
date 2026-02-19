const { crawlWebsite } = require('../services/crawlApiService');
const { summarizeWithLLM } = require('../services/scrapeSummarizer');
const { chatbotCompanyInfoRepository, chatbotScrapedPagesRepository } = require('../../db/repositories');

const MAX_CHARS = parseInt(process.env.SCRAPER_MAX_CHARS, 10) || 200000;

function aggregateContent(pages) {
  let total = 0;
  const parts = [];
  for (const p of pages) {
    const text = (p.content_text || p.content_markdown || '').trim();
    if (!text) continue;
    const remaining = MAX_CHARS - total;
    if (remaining <= 0) break;
    parts.push(text.slice(0, remaining));
    total += Math.min(text.length, remaining);
  }
  return parts.join('\n\n');
}

async function handleScrapeJob(job) {
  const { companyId, websiteUrl } = job.data;
  console.log('[scrapeWorker] Job start', { companyId, websiteUrl });

  try {
    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'running');

    const apiKey = process.env.SCRAPER_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('SCRAPER_API_KEY is required for crawl');
    }

    const pages = await crawlWebsite(websiteUrl);
    if (!pages || pages.length === 0) {
      await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'failed', {
        scrape_error: 'No content returned from crawl API',
      });
      console.log('[scrapeWorker] Job failed: no content');
      return;
    }

    await chatbotScrapedPagesRepository.upsertMany(companyId, pages);
    const aggregated = aggregateContent(pages);

    const summary = await summarizeWithLLM(aggregated);

    await chatbotCompanyInfoRepository.setScrapeDone(companyId, summary);
    console.log('[scrapeWorker] Job done', { companyId });
  } catch (err) {
    console.error('[scrapeWorker] Job error', { companyId, error: err.message });
    const safeMsg = (err?.message || 'Scrape failed').slice(0, 500);
    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'failed', {
      scrape_error: safeMsg,
    });
  }
}

module.exports = { handleScrapeJob };
