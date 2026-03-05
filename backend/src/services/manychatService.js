/**
 * ManyChat API - send Instagram messages via ManyChat.
 * All outbound calls use the company's apiKey parameter; no global env.
 */

const logger = require('../lib/logger');
const axios = require('axios');
const { decrypt } = require('../lib/encryption');

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
    const apiKey = decrypt(company?.manychat_api_key);
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
    logger.error({ err: err.message }, '[manychat] sendManyChatImage error');
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

async function sendFlow(subscriberId, flowNs, apiKey) {
  const response = await axios.post(
    'https://api.manychat.com/fb/sending/sendFlow',
    {
      subscriber_id: subscriberId,
      flow_ns: flowNs,
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

module.exports = { sendInstagramMessage, getPageInfo, sendManyChatImage, sendManyChatFile, sendFlow };
