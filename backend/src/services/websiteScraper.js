const cheerio = require('cheerio');

const REQUEST_TIMEOUT_MS = 10000;
const MAX_TEXT_CHARS = 50000;

function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const s = url.trim();
  return s.startsWith('http://') || s.startsWith('https://');
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PrefabLeadBot/1.0)' },
    });
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractReadableText(html) {
  if (!html || typeof html !== 'string') return '';
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, noscript, iframe').remove();
  const bodyText = $('body').text();
  const fullText = bodyText || $('html').text() || $.text();
  return fullText
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

async function scrapeHomepage(websiteUrl) {
  if (!isValidUrl(websiteUrl)) {
    throw new Error('website_url must be http or https');
  }
  const html = await fetchWithTimeout(websiteUrl);
  const text = extractReadableText(html);
  return text.slice(0, MAX_TEXT_CHARS);
}

module.exports = { scrapeHomepage, isValidUrl };
