/**
 * Instagram Direct Send — bypasses ManyChat to send audio via Meta's Graph API.
 * ManyChat doesn't support audio/file/video for Instagram, so we call Meta directly.
 */

const axios = require('axios');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Cache resolved page info so we don't call /me/accounts on every message
let _cachedPageInfo = null;

/**
 * Get the Instagram-Scoped User ID (IGSID) from ManyChat's subscriber info.
 * ManyChat's subscriber_id is their internal ID — we need the platform-specific IGSID.
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
 * Resolve User Token → Page ID + Page Token.
 * Calls GET /me/accounts to find the Facebook Page linked to Instagram.
 * Caches the result for subsequent calls.
 */
async function resolvePageToken(userOrPageToken) {
  if (_cachedPageInfo) return _cachedPageInfo;

  const response = await axios.get(`${GRAPH_API_BASE}/me/accounts`, {
    params: {
      access_token: userOrPageToken,
      fields: 'id,name,access_token,instagram_business_account',
    },
    timeout: 10000,
  });

  const pages = response.data?.data || [];
  // Prefer a page that has an instagram_business_account linked
  const igPage = pages.find((p) => p.instagram_business_account) || pages[0];

  if (!igPage) {
    throw new Error('No Facebook Pages found for this token. Make sure the token has pages_show_list permission.');
  }

  _cachedPageInfo = {
    pageId: igPage.id,
    pageName: igPage.name,
    pageToken: igPage.access_token,
    igAccountId: igPage.instagram_business_account?.id || null,
  };

  console.log('[instagram-direct] Resolved page:', _cachedPageInfo.pageName, 'pageId:', _cachedPageInfo.pageId, 'igAccountId:', _cachedPageInfo.igAccountId);
  return _cachedPageInfo;
}

/**
 * Send an audio attachment to an Instagram DM via Meta's Graph API.
 *
 * @param {string} recipientId — IGSID of the recipient
 * @param {string} audioUrl — publicly accessible URL to the audio file
 * @param {string} token — User or Page access token with instagram_manage_messages
 */
async function sendInstagramAudio(recipientId, audioUrl, token) {
  // Resolve the page ID and page-level token from whatever token we have
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
