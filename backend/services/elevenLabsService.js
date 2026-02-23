/**
 * ElevenLabs API - text-to-speech and voice management.
 */

const fetch = require('node-fetch');

const DEFAULT_MODEL = 'eleven_monolingual_v1';

async function textToSpeech(text, voiceId = null) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY is required for text-to-speech');
  }

  const vid = voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (!vid) {
    throw new Error('voiceId or ELEVENLABS_VOICE_ID is required');
  }

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: DEFAULT_MODEL,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs API failed: ${res.status} ${errText}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

async function getVoices() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY is required');
  }

  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    method: 'GET',
    headers: {
      'xi-api-key': apiKey,
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs voices API failed: ${res.status} ${errText}`);
  }

  const json = await res.json();
  return json.voices ?? json ?? [];
}

module.exports = { textToSpeech, getVoices };
