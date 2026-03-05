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

/**
 * Preprocess text so ElevenLabs produces natural pauses and breaths.
 * "..." → sentence-ending period + pause word that forces a break.
 */
function preprocessForTTS(text) {
  return text
    // "..." or "…" → period + soft breath pause (ElevenLabs reliably pauses on sentence boundaries)
    .replace(/\.{3,}|…/g, '. —')
    // Double dash "--" also gets a pause
    .replace(/--/g, ', —')
    // Clean up any resulting double spaces
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function textToSpeech(voiceId, text, settings = {}) {
  const key = getElevenLabsKey();
  if (!key) throw new Error('ElevenLabs API key not configured');

  const speed = Math.min(4.0, Math.max(0.25, parseFloat(settings.speed) || 1.0));
  const data = {
    text: preprocessForTTS(text),
    model_id: settings.model || 'eleven_turbo_v2_5',
    voice_settings: {
      stability: settings.stability ?? 0.5,
      similarity_boost: settings.similarity_boost ?? 0.75,
      style: settings.style ?? 0,
      use_speaker_boost: settings.speaker_boost ?? true,
    },
  };
  if (speed !== 1.0) data.speed = speed;

  try {
    const response = await axios({
      method: 'POST',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      data,
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    return {
      audio_base64: Buffer.from(response.data).toString('base64'),
      content_type: 'audio/mpeg',
    };
  } catch (err) {
    // If speed param caused the error, retry without it
    if (err.response?.status === 400 && speed !== 1.0) {
      delete data.speed;
      const response = await axios({
        method: 'POST',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        data,
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      return {
        audio_base64: Buffer.from(response.data).toString('base64'),
        content_type: 'audio/mpeg',
      };
    }
    throw err;
  }
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
 * Generate procedural restaurant ambient noise (crowd murmur + subtle clatter).
 * Returns a PCM 16-bit mono buffer of the requested length.
 */
function generateRestaurantAmbience(numSamples, sampleRate = 22050) {
  const buffer = Buffer.alloc(numSamples * 2);

  // Two cascaded low-pass filters create smooth crowd murmur
  let lp1 = 0, lp2 = 0;
  const alpha1 = 0.06;  // ~130Hz equivalent — deep room rumble
  const alpha2 = 0.12;  // ~260Hz — conversational murmur layer
  const baseVolume = 450; // Very subtle (~1.4% of max amplitude)

  for (let i = 0; i < numSamples; i++) {
    const noise = (Math.random() * 2 - 1) * baseVolume;

    // Cascaded low-pass for warm murmur
    lp1 += alpha1 * (noise - lp1);
    lp2 += alpha2 * (lp1 - lp2);

    // Slow amplitude modulation — simulates ebb and flow of crowd chatter
    const t = i / sampleRate;
    const mod = 0.55
      + 0.20 * Math.sin(2 * Math.PI * 0.35 * t)
      + 0.13 * Math.sin(2 * Math.PI * 0.73 * t)
      + 0.08 * Math.sin(2 * Math.PI * 1.4 * t);

    const sample = Math.round(lp2 * mod);
    buffer.writeInt16LE(Math.max(-32767, Math.min(32767, sample)), i * 2);
  }

  return buffer;
}

/**
 * Add silence padding and natural fade-out to PCM audio.
 * Optionally mixes in ambient background noise (e.g. restaurant ambience).
 *
 * Fixes:
 * 1. Prepends ~250ms silence so the first words aren't cut off by the player
 * 2. Applies a gradual volume fade-out over the last ~1s so the voice
 *    trails off naturally (like real human speech)
 * 3. Appends ~400ms silence so the last word isn't clipped
 * 4. (Optional) Mixes restaurant ambient noise throughout
 */
function processVoiceAudio(pcmBuffer, sampleRate = 22050, ambientNoise = null) {
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

  // 3. Combine lead silence + voice + trail silence
  const combined = Buffer.concat([leadSilence, audioData, trailSilence]);

  // 4. Mix ambient noise if requested
  if (ambientNoise === 'restaurant') {
    const totalCombinedSamples = Math.floor(combined.length / bytesPerSample);
    const ambient = generateRestaurantAmbience(totalCombinedSamples, sampleRate);
    for (let i = 0; i < combined.length - 1; i += bytesPerSample) {
      const voice = combined.readInt16LE(i);
      const noise = ambient.readInt16LE(i);
      combined.writeInt16LE(Math.max(-32767, Math.min(32767, voice + noise)), i);
    }
  }

  return combined;
}

/**
 * Generate TTS audio in WAV format (for ManyChat Instagram voice messages).
 * Requests PCM from ElevenLabs and wraps in a WAV header.
 */
async function textToSpeechWav(voiceId, text, settings = {}) {
  const key = getElevenLabsKey();
  if (!key) throw new Error('ElevenLabs API key not configured');

  const speed = Math.min(4.0, Math.max(0.25, parseFloat(settings.speed) || 1.0));
  const data = {
    text: preprocessForTTS(text),
    model_id: settings.model || 'eleven_turbo_v2_5',
    voice_settings: {
      stability: settings.stability ?? 0.5,
      similarity_boost: settings.similarity_boost ?? 0.75,
      style: settings.style ?? 0,
      use_speaker_boost: settings.speaker_boost ?? true,
    },
  };
  if (speed !== 1.0) data.speed = speed;

  const makeRequest = (reqData) => axios({
    method: 'POST',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    params: { output_format: 'pcm_22050' },
    data: reqData,
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  let response;
  try {
    response = await makeRequest(data);
  } catch (err) {
    // If speed param caused the error, retry without it
    if (err.response?.status === 400 && speed !== 1.0) {
      delete data.speed;
      response = await makeRequest(data);
    } else {
      throw err;
    }
  }

  const pcmBuffer = Buffer.from(response.data);

  // Apply silence padding (prevents first/last word cutoff), natural fade-out, and optional ambient noise
  const processedPcm = processVoiceAudio(pcmBuffer, 22050, settings.ambientNoise || null);
  const wavBuffer = pcmToWav(processedPcm);

  return {
    audio_base64: wavBuffer.toString('base64'),
    content_type: 'audio/wav',
  };
}

module.exports = { getElevenLabsKey, isElevenLabsConfigured, elevenLabsRequest, getUsage, getVoices, textToSpeech, textToSpeechWav };
