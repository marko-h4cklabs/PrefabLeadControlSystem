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

module.exports = { sendInstagramMessage, getPageInfo };
