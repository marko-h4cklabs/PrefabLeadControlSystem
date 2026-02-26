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

/**
 * Convert raw PCM buffer to WAV format by prepending a 44-byte header.
 */
function pcmToWav(pcmBuffer, sampleRate = 22050, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Add silence padding and natural fade-out to PCM audio.
 *
 * Fixes:
 * 1. Prepends ~250ms silence so the first words aren't cut off by the player
 * 2. Applies a gradual volume fade-out over the last ~1s so the voice
 *    trails off naturally (like real human speech)
 * 3. Appends ~400ms silence so the last word isn't clipped
 */
function processVoiceAudio(pcmBuffer, sampleRate = 22050) {
  const bytesPerSample = 2; // 16-bit PCM

  // 1. Silence padding
  const leadSilenceMs = 250;
  const trailSilenceMs = 400;
  const leadBytes = Math.floor(sampleRate * (leadSilenceMs / 1000)) * bytesPerSample;
  const trailBytes = Math.floor(sampleRate * (trailSilenceMs / 1000)) * bytesPerSample;
  const leadSilence = Buffer.alloc(leadBytes, 0);
  const trailSilence = Buffer.alloc(trailBytes, 0);

  // 2. Fade-out on the last ~1 second of actual audio (natural voice trailing)
  const fadeOutMs = 1000;
  const fadeOutSamples = Math.floor(sampleRate * (fadeOutMs / 1000));
  const totalSamples = Math.floor(pcmBuffer.length / bytesPerSample);
  const fadeStartSample = Math.max(0, totalSamples - fadeOutSamples);

  // Work on a copy so we don't mutate the original
  const audioData = Buffer.from(pcmBuffer);

  for (let i = fadeStartSample; i < totalSamples; i++) {
    const progress = (i - fadeStartSample) / (totalSamples - fadeStartSample); // 0 -> 1
    // Cosine fade: smooth curve from 1.0 down to 0.35 (don't go to zero, just quieter)
    const multiplier = 0.35 + 0.65 * (0.5 * (1 + Math.cos(Math.PI * progress)));
    const offset = i * bytesPerSample;
    if (offset + 1 < audioData.length) {
      const sample = audioData.readInt16LE(offset);
      audioData.writeInt16LE(Math.round(sample * multiplier), offset);
    }
  }

  return Buffer.concat([leadSilence, audioData, trailSilence]);
}

/**
 * Generate TTS audio in WAV format (for ManyChat Instagram voice messages).
 * Requests PCM from ElevenLabs and wraps in a WAV header.
 */
async function textToSpeechWav(voiceId, text, settings = {}) {
  const key = getElevenLabsKey();
  if (!key) throw new Error('ElevenLabs API key not configured');

  const response = await axios({
    method: 'POST',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
    },
    params: {
      output_format: 'pcm_22050',
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

  const pcmBuffer = Buffer.from(response.data);

  // Apply silence padding (prevents first/last word cutoff) and natural fade-out
  const processedPcm = processVoiceAudio(pcmBuffer, 22050);
  const wavBuffer = pcmToWav(processedPcm);

  return {
    audio_base64: wavBuffer.toString('base64'),
    content_type: 'audio/wav',
  };
}

module.exports = { getElevenLabsKey, isElevenLabsConfigured, elevenLabsRequest, getUsage, getVoices, textToSpeech, textToSpeechWav };
