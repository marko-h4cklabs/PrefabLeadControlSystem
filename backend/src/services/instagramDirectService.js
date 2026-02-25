/**
 * Instagram Direct Send — bypasses ManyChat to send audio via Meta's Graph API.
 * ManyChat doesn't support audio/file/video for Instagram, so we call Meta directly.
 *
 * Env vars:
 *   INSTAGRAM_PAGE_TOKEN — User or Page access token with instagram_manage_messages
 *   FACEBOOK_PAGE_ID     — (optional) Facebook Page ID; skips /me/accounts resolution
 */

const axios = require('axios');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Cache resolved page info so we don't call /me/accounts on every message
let _cachedPageInfo = null;

/**
 * Get the Instagram-Scoped User ID (IGSID) from ManyChat's subscriber info.
 */
async function getSubscriberInfo(subscriberId, manychatApiKey) {
  const response = await axios.get('https://api.manychat.com/fb/subscriber/getInfo', {
    params: { subscriber_id: subscriberId },
    headers: {
      Authorization: `Bearer ${manychatApiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });
  return response.data?.data || null;
}

/**
 * Resolve token → Page ID + Page Token.
 * Priority:
 *   1. FACEBOOK_PAGE_ID env var → use token as-is (assumes it's a Page Token or has page access)
 *   2. GET /me/accounts → find page automatically
 */
async function resolvePageToken(token) {
  if (_cachedPageInfo) return _cachedPageInfo;

  // Option 1: explicit Page ID from env
  const envPageId = (process.env.FACEBOOK_PAGE_ID || '').trim();
  if (envPageId) {
    console.log('[instagram-direct] Using FACEBOOK_PAGE_ID from env:', envPageId);
    _cachedPageInfo = { pageId: envPageId, pageToken: token };
    return _cachedPageInfo;
  }

  // Option 2: resolve via /me/accounts
  console.log('[instagram-direct] No FACEBOOK_PAGE_ID set, resolving via /me/accounts...');
  const response = await axios.get(`${GRAPH_API_BASE}/me/accounts`, {
    params: {
      access_token: token,
      fields: 'id,name,access_token,instagram_business_account',
    },
    timeout: 10000,
  });

  const pages = response.data?.data || [];
  console.log('[instagram-direct] /me/accounts returned', pages.length, 'pages:', pages.map((p) => `${p.name} (${p.id})`).join(', '));

  const igPage = pages.find((p) => p.instagram_business_account) || pages[0];
  if (!igPage) {
    throw new Error('No Facebook Pages found. Set FACEBOOK_PAGE_ID env var as a workaround.');
  }

  _cachedPageInfo = { pageId: igPage.id, pageToken: igPage.access_token };
  console.log('[instagram-direct] Resolved page:', igPage.name, 'pageId:', igPage.id);
  return _cachedPageInfo;
}

/**
 * Send an audio attachment to an Instagram DM via Meta's Graph API.
 */
async function sendInstagramAudio(recipientId, audioUrl, token) {
  const pageInfo = await resolvePageToken(token);
  const endpoint = `${GRAPH_API_BASE}/${pageInfo.pageId}/messages`;

  const response = await axios.post(
    endpoint,
    {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: 'audio',
          payload: {
            url: audioUrl,
            is_reusable: false,
          },
        },
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      params: { access_token: pageInfo.pageToken },
      timeout: 30000,
    }
  );

  return response.data;
}

module.exports = { getSubscriberInfo, sendInstagramAudio };
