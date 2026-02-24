const axios = require('axios');

function getElevenLabsKey() {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key || key.length < 10) return null;
  return key;
}

function isElevenLabsConfigured() {
  return !!getElevenLabsKey();
}

async function elevenLabsRequest(method, path, data = null, extraHeaders = {}) {
  const key = getElevenLabsKey();
  if (!key) throw new Error('ElevenLabs API key not configured. Check ELEVENLABS_API_KEY in Railway.');

  const config = {
    method,
    url: `https://api.elevenlabs.io/v1${path}`,
    headers: {
      'xi-api-key': key,
      ...extraHeaders,
    },
    timeout: 60000,
  };
  if (data) config.data = data;

  const response = await axios(config);
  return response.data;
}

async function getUsage() {
  const data = await elevenLabsRequest('GET', '/user/subscription');
  return {
    characters_used: data.character_count || 0,
    character_limit: data.character_limit || 10000,
  };
}

async function getVoices() {
  const data = await elevenLabsRequest('GET', '/voices');
  return data.voices || [];
}

async function textToSpeech(voiceId, text, settings = {}) {
  const key = getElevenLabsKey();
  if (!key) throw new Error('ElevenLabs API key not configured');

  const response = await axios({
    method: 'POST',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
    },
    data: {
      text,
      model_id: settings.model || 'eleven_turbo_v2_5',
      voice_settings: {
        stability: settings.stability ?? 0.5,
        similarity_boost: settings.similarity_boost ?? 0.75,
        style: settings.style ?? 0,
        use_speaker_boost: settings.speaker_boost ?? true,
      },
    },
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  return {
    audio_base64: Buffer.from(response.data).toString('base64'),
    content_type: 'audio/mpeg',
  };
}

module.exports = { getElevenLabsKey, isElevenLabsConfigured, elevenLabsRequest, getUsage, getVoices, textToSpeech };
