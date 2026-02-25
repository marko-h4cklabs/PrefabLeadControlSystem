/**
 * Instagram Direct Send — bypasses ManyChat to send audio via Meta's Graph API.
 * ManyChat doesn't support audio/file/video for Instagram, so we call Meta directly.
 */

const axios = require('axios');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

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
 * Send an audio attachment to an Instagram DM via Meta's Graph API.
 *
 * @param {string} recipientId — IGSID of the recipient
 * @param {string} audioUrl — publicly accessible URL to the audio file
 * @param {string} pageAccessToken — Facebook Page access token with instagram_manage_messages
 * @param {string} [pageId] — Facebook Page ID (optional, defaults to 'me')
 */
async function sendInstagramAudio(recipientId, audioUrl, pageAccessToken, pageId) {
  const endpoint = `${GRAPH_API_BASE}/${pageId || 'me'}/messages`;

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
      params: { access_token: pageAccessToken },
      timeout: 30000,
    }
  );

  return response.data;
}

module.exports = { getSubscriberInfo, sendInstagramAudio };
