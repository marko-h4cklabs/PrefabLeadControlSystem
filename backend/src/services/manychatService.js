/**
 * ManyChat API - send Instagram messages via ManyChat.
 * All outbound calls use the company's apiKey parameter; no global env.
 */

const axios = require('axios');

async function getPageInfo(apiKey) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('API key required');
  }
  const response = await axios.get('https://api.manychat.com/fb/page/getInfo', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  return response.data;
}

async function sendInstagramMessage(subscriberId, text, apiKey) {
  const response = await axios.post(
    'https://api.manychat.com/fb/sending/sendContent',
    {
      subscriber_id: subscriberId,
      data: {
        version: 'v2',
        content: {
          type: 'instagram',
          messages: [
            {
              type: 'text',
              text: text
            }
          ]
        }
      }
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data;
}

async function sendManyChatImage(lead, imageUrl, caption, company) {
  try {
    const apiKey = company?.manychat_api_key;
    if (!apiKey) return;
    const subscriberId = lead?.external_id;
    if (!subscriberId) return;
    const messages = [{ type: 'image', url: imageUrl }];
    if (caption && String(caption).trim()) {
      messages.push({ type: 'text', text: String(caption).trim() });
    }
    await axios.post(
      'https://api.manychat.com/fb/sending/sendContent',
      {
        subscriber_id: subscriberId,
        data: {
          version: 'v2',
          content: {
            type: 'instagram',
            messages,
          },
        },
        message_tag: 'ACCOUNT_UPDATE',
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('[manychat] sendManyChatImage error:', err.message);
  }
}

async function sendManyChatFile(subscriberId, fileUrl, apiKey) {
  const response = await axios.post(
    'https://api.manychat.com/fb/sending/sendContent',
    {
      subscriber_id: subscriberId,
      data: {
        version: 'v2',
        content: {
          type: 'instagram',
          messages: [
            {
              type: 'audio',
              url: fileUrl,
            },
          ],
        },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data;
}

module.exports = { sendInstagramMessage, getPageInfo, sendManyChatImage, sendManyChatFile };
