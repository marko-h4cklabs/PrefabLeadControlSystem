const { chatbotCompanyInfoRepository } = require('../../db/repositories');
const { scrapeHomepage } = require('./websiteScraper');
const { summarizeWithLLM } = require('./scrapeSummarizer');

async function runScrapeJob(companyId) {
  const info = await chatbotCompanyInfoRepository.get(companyId);
  const websiteUrl = (info.website_url || '').trim();
  if (!websiteUrl) {
    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'failed', {
      scrape_error: 'No website URL configured',
    });
    return;
  }

  try {
    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'running');

    const scrapedText = await scrapeHomepage(websiteUrl);
    if (!scrapedText.trim()) {
      await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'failed', {
        scrape_error: 'No readable content could be extracted from the website',
      });
      return;
    }

    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'summarizing');

    const summary = await summarizeWithLLM(scrapedText);

    await chatbotCompanyInfoRepository.setScrapeFinished(companyId, summary);
  } catch (err) {
    console.error('[scrapeService] Error:', err);
    const safeMsg = (err?.message || 'Scrape failed').slice(0, 500);
    await chatbotCompanyInfoRepository.setScrapeStatus(companyId, 'failed', {
      scrape_error: safeMsg,
    });
  }
}

function startScrapeJob(companyId) {
  setImmediate(() => runScrapeJob(companyId).catch((e) => console.error('[scrapeService] Job crash:', e)));
}

module.exports = { runScrapeJob, startScrapeJob };
