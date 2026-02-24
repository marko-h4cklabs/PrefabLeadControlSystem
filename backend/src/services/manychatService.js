/**
 * ManyChat API - send Instagram messages via ManyChat.
 */

const fetch = require('node-fetch');

async function sendInstagramMessage(subscriberId, text, apiKey) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('ManyChat API key is required');
  }

  console.log(`[manychat] Sending message to subscriber: ${subscriberId} using key prefix: ${apiKey?.substring(0, 10)}`);

  const response = await fetch('https://api.manychat.com/fb/sending/sendContent', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subscriber_id: subscriberId,
      data: {
        version: 'v2',
        content: {
          messages: [{ type: 'text', text }],
        },
      },
      message_tag: 'ACCOUNT_UPDATE',
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`ManyChat API failed: ${response.status} ${errBody}`);
  }

  return response.json();
}

module.exports = { sendInstagramMessage };
