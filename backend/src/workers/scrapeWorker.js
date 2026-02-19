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
  if (!job || !job.data || !job.data.companyId) {
    throw new Error('Missing job.data.companyId');
  }
  const { companyId, websiteUrl: payloadUrl } = job.data;
  const websiteUrl = (payloadUrl || '').trim();
  const jobId = job.id;
  console.log('[scrapeWorker] start', { jobId, companyId, websiteUrl });

  if (!websiteUrl) {
    const msg = 'websiteUrl is missing in job.data';
    console.error('[scrapeWorker] failed', { jobId, companyId, err: msg });
    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'failed', {
      scrape_error: msg,
      scraped_summary: null,
    });
    throw new Error(msg);
  }

  try {
    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'running');

    const apiKey = process.env.SCRAPER_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('SCRAPER_API_KEY is required for crawl');
    }

    const pages = await crawlWebsite(websiteUrl);
    if (!pages || pages.length === 0) {
      const msg = 'No content returned from crawl API';
      await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'failed', {
        scrape_error: msg,
        scraped_summary: null,
      });
      console.error('[scrapeWorker] failed', { jobId, companyId, err: msg });
      throw new Error(msg);
    }

    await chatbotScrapedPagesRepository.upsertMany(companyId, pages);
    const aggregated = aggregateContent(pages);

    const summary = await summarizeWithLLM(aggregated);

    await chatbotCompanyInfoRepository.setScrapeDone(companyId, summary);
    console.log('[scrapeWorker] success', { jobId, companyId });
  } catch (err) {
    const safeMsg = (err?.message || 'Scrape failed').slice(0, 500);
    console.error('[scrapeWorker] failed', { jobId, companyId, err: safeMsg });
    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'failed', {
      scrape_error: safeMsg,
      scraped_summary: null,
    });
    throw err;
  }
}

module.exports = { handleScrapeJob };
