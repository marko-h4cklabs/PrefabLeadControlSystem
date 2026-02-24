/**
 * ManyChat API - send Instagram messages via ManyChat.
 */

const axios = require('axios');

async function sendInstagramMessage(subscriberId, text, apiKey) {
  const response = await axios.post(
    'https://api.manychat.com/instagram/sending/sendContent',
    {
      subscriber_id: subscriberId,
      data: {
        version: 'v2',
        content: {
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

module.exports = { sendInstagramMessage };
