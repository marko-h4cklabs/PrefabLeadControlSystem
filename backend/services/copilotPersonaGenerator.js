/**
 * Copilot AI Persona Generator
 *
 * Parses uploaded files (IG DM JSON exports, plain text transcripts, .docx, .xlsx)
 * and screenshots (images via Claude vision) to analyze communication style,
 * then generates a comprehensive persona configuration for all 14 behavior fields
 * plus a knowledge_base of extracted insights.
 */

const logger = require('../src/lib/logger');
const { claudeWithRetry } = require('../src/utils/claudeWithRetry');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const IMAGE_MIMETYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/gif', 'image/heic', 'image/heif',
]);

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif']);

function isImageFile(mimetype, originalname) {
  const ext = (originalname || '').split('.').pop().toLowerCase();
  return IMAGE_MIMETYPES.has(mimetype) || IMAGE_EXTS.has(ext);
}

/**
 * Parse a single text-based file buffer based on its extension/mimetype.
 * Returns extracted text or null if unsupported.
 */
async function parseFileToText(buffer, mimetype, originalname, senderName) {
  const ext = (originalname || '').split('.').pop().toLowerCase();

  // Plain text
  if (ext === 'txt' || mimetype === 'text/plain') {
    return buffer.toString('utf8');
  }

  // IG DM JSON export (or generic JSON transcript)
  if (ext === 'json' || mimetype === 'application/json') {
    try {
      const raw = buffer.toString('utf8');
      const data = JSON.parse(raw);

      const matchesSender = (msgSender) => {
        if (!senderName) return true;
        if (!msgSender) return false;
        return msgSender.toLowerCase().includes(senderName.toLowerCase());
      };

      // Instagram DM export format: { participants: [...], messages: [...] }
      if (data.messages && Array.isArray(data.messages)) {
        const participants = (data.participants || []).map((p) => p.name).join(', ');
        const header = participants ? `[Conversation between: ${participants}]\n\n` : '';

        if (senderName) {
          const lines = data.messages
            .filter((m) => m.content && typeof m.content === 'string' && m.content.trim())
            .map((m) => {
              const isSetter = matchesSender(m.sender_name);
              const label = isSetter ? `[SETTER] ${m.sender_name || 'Unknown'}` : (m.sender_name || 'Lead');
              return `${label}: ${m.content.trim()}`;
            });
          if (lines.length > 0) return header + lines.join('\n');
        } else {
          const lines = data.messages
            .filter((m) => m.content && typeof m.content === 'string' && m.content.trim())
            .map((m) => `${m.sender_name || 'Unknown'}: ${m.content.trim()}`);
          if (lines.length > 0) return header + lines.join('\n');
        }
      }

      // Generic JSON array of message objects
      if (Array.isArray(data)) {
        const lines = data
          .filter((m) => m && (m.content || m.text || m.message))
          .map((m) => {
            const sender = m.sender || m.from || m.author || m.sender_name || '';
            const text = m.content || m.text || m.message || '';
            return sender ? `${sender}: ${text}` : text;
          })
          .filter(Boolean);
        if (lines.length > 0) return lines.join('\n');
      }

      return JSON.stringify(data, null, 2).slice(0, 50000);
    } catch {
      return buffer.toString('utf8').slice(0, 50000);
    }
  }

  // .docx and .xlsx — delegate to documentParser
  const { parseDocument } = require('../src/services/documentParser');
  return parseDocument(buffer, mimetype, originalname);
}

const ANALYSIS_PROMPT = `You are an expert sales communication analyst building AI persona profiles.

You have been given transcripts, DM exports, documents, and/or screenshots from a salesperson / setter (the person selling or qualifying leads). Your job is to analyze their communication style in depth and output a precise persona configuration plus a knowledge base.

IMPORTANT: Focus ONLY on the business representative / setter — not on the leads they talk to. Identify who is the seller from context (usually the person initiating, asking questions, pitching) and extract ONLY their style.

For screenshots: read the conversation carefully, identify who is the setter, and analyze their messages just like you would text data.

Analyze carefully:
1. TONE — Professional, friendly, confident, or relatable?
2. MESSAGE LENGTH — Short (1-2 sentences), medium (2-4), or long (6+)?
3. EMOJI USAGE — Frequent or sparse?
4. PUNCTUATION — End periods? Ellipses? No punctuation?
5. CAPITALIZATION — Always capitalized? Sometimes lowercase starts?
6. SHORT FORMS — "ur", "u", "gonna", "wanna", "rn", "ngl", "tbh"?
7. TYPOS — Occasional small intentional-feeling typos or always clean?
8. SPLIT MESSAGES — Multiple short messages vs one long one?
9. APPROACH — Field-focused (straight to qualifying) or rapport-building (warmth first)?
10. FOLLOW-UP ENERGY — Gentle nudges, persistent CTAs, or value-led?
11. CLOSING STYLE — Soft / assumptive / direct?
12. PERSONA NAME — What first name fits this person's vibe?
13. BOT RESPONSE — How would this person naturally respond if asked "are you a bot?"?
14. KNOWLEDGE BASE — What patterns, common objections, lead types, and key insights appear across these conversations? What does the setter handle most often? What topics come up repeatedly?

Return ONLY valid JSON:

{
  "agent_name": "a fitting first name for this persona",
  "agent_backstory": "2-3 paragraphs describing this person's sales personality, background, communication style, and approach — written so an AI can adopt this exact persona",
  "tone": "professional" or "friendly" or "confident" or "relatable",
  "response_length": "short" or "medium" or "long",
  "emojis_enabled": true or false,
  "opener_style": "casual" or "formal" or "question" or "statement" or "greeting" or "direct" or "professional",
  "conversation_approach": "field_focused" or "rapport_building",
  "follow_up_style": "gentle" or "persistent" or "value_first",
  "closing_style": "soft" or "direct" or "assumptive",
  "human_error_enabled": true or false,
  "human_error_types": ["typos", "no_periods", "lowercase_starts", "short_forms"],
  "human_error_random": true or false,
  "no_trailing_period": true or false,
  "bot_deny_response": "the exact response this persona would give if asked 'are you a bot?'",
  "style_summary": "2-3 sentences capturing the essence of this person's communication style",
  "knowledge_base": "A structured summary of: common lead objections and how they were handled, recurring topics and questions, lead qualification patterns, pricing/product mentions, and any other repeated insights that would help an AI respond authentically in this setter's context. Write this as a useful reference, not a transcript."
}

Rules:
- "human_error_types" should only contain types you actually observed: typos, no_periods, lowercase_starts, short_forms
- "human_error_enabled" should be true only if you found 2+ clear patterns
- "no_trailing_period" should be true if they consistently skip end periods
- "human_error_random" should be true if the imperfections are inconsistent/random
- Choose "rapport_building" if warmth before business; "field_focused" if they get to the point quickly
- Never use dashes or em-dashes (-- or \u2014) in any generated text fields`;

/**
 * Generate a full persona configuration from an array of file buffers.
 * Supports text files (json, txt, docx, xlsx) and images (jpg, png, webp, heic).
 *
 * @param {Array<{buffer: Buffer, mimetype: string, originalname: string}>} files
 * @param {string|null} senderName
 * @returns {Promise<{ persona: Object, style_summary: string, knowledge_base: string }>}
 */
async function generatePersonaFromFiles(files, senderName = null) {
  if (!files || files.length === 0) {
    throw new Error('At least one file is required');
  }

  const textParts = [];
  const imageBlocks = []; // Claude vision content blocks

  for (const f of files) {
    try {
      if (isImageFile(f.mimetype, f.originalname)) {
        // Determine the correct media_type for Claude vision
        const ext = (f.originalname || '').split('.').pop().toLowerCase();
        let mediaType = f.mimetype;
        if (!IMAGE_MIMETYPES.has(mediaType)) {
          const extMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/jpeg', heif: 'image/jpeg' };
          mediaType = extMap[ext] || 'image/jpeg';
        }
        // Claude vision only supports jpeg, png, gif, webp
        if (mediaType === 'image/heic' || mediaType === 'image/heif') mediaType = 'image/jpeg';

        imageBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: f.buffer.toString('base64'),
          },
        });
        logger.info({ file: f.originalname, mediaType }, '[personaGenerator] Added image for vision analysis');
      } else {
        const text = await parseFileToText(f.buffer, f.mimetype, f.originalname, senderName);
        if (text && text.trim().length > 0) {
          textParts.push(`--- FILE: ${f.originalname} ---\n${text.trim()}`);
        }
      }
    } catch (err) {
      logger.warn({ file: f.originalname, err: err.message }, '[personaGenerator] Failed to parse file, skipping');
    }
  }

  if (textParts.length === 0 && imageBlocks.length === 0) {
    throw new Error('Could not extract content from any of the uploaded files. Try .txt, .json, .docx, .xlsx, or image files.');
  }

  // Trim text to ~80k chars
  const combinedText = textParts.join('\n\n');
  const truncated = combinedText.length > 80000
    ? combinedText.slice(0, 80000) + '\n\n[...truncated for analysis...]'
    : combinedText;

  const senderHint = senderName
    ? `The person you must analyze is named "${senderName}". Their messages are marked with [SETTER] or simply appear under their name. ONLY model the style of "${senderName}" — completely ignore all other participants.\n\n`
    : '';

  // Build multi-modal message content
  // Text part always comes first, then images
  const userContent = [];

  const textPrompt = `${senderHint}${truncated ? `Here are the conversations and documents to analyze:\n\n${truncated}\n\n` : ''}${imageBlocks.length > 0 ? `Additionally, analyze the ${imageBlocks.length} screenshot(s) below — read every message visible in them and treat them as additional conversation data.\n\n` : ''}Generate the persona JSON now.`;

  userContent.push({ type: 'text', text: textPrompt });
  userContent.push(...imageBlocks);

  const { content } = await claudeWithRetry({
    model,
    max_tokens: 3000,
    system: ANALYSIS_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const raw = content ?? '';
  let parsed;
  try {
    const match = raw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : null;
  } catch {
    parsed = null;
  }

  if (!parsed || !parsed.agent_backstory) {
    logger.error({ raw: raw.slice(0, 500) }, '[personaGenerator] Failed to parse Claude JSON response');
    throw new Error('Analysis failed — could not extract persona from the provided files. Try adding more conversation examples.');
  }

  const VALID_TONES = ['professional', 'friendly', 'confident', 'relatable'];
  const VALID_LENGTHS = ['short', 'medium', 'long'];
  const VALID_OPENERS = ['casual', 'formal', 'question', 'statement', 'greeting', 'direct', 'professional'];
  const VALID_APPROACHES = ['field_focused', 'rapport_building'];
  const VALID_FOLLOWUPS = ['gentle', 'persistent', 'value_first'];
  const VALID_CLOSINGS = ['soft', 'direct', 'assumptive'];
  const VALID_ERROR_TYPES = ['typos', 'no_periods', 'lowercase_starts', 'short_forms'];

  const persona = {
    agent_name: String(parsed.agent_name || 'Alex').slice(0, 50),
    agent_backstory: String(parsed.agent_backstory || '').slice(0, 3000),
    tone: VALID_TONES.includes(parsed.tone) ? parsed.tone : 'friendly',
    response_length: VALID_LENGTHS.includes(parsed.response_length) ? parsed.response_length : 'medium',
    emojis_enabled: Boolean(parsed.emojis_enabled),
    opener_style: VALID_OPENERS.includes(parsed.opener_style) ? parsed.opener_style : 'casual',
    conversation_approach: VALID_APPROACHES.includes(parsed.conversation_approach) ? parsed.conversation_approach : 'rapport_building',
    follow_up_style: VALID_FOLLOWUPS.includes(parsed.follow_up_style) ? parsed.follow_up_style : 'gentle',
    closing_style: VALID_CLOSINGS.includes(parsed.closing_style) ? parsed.closing_style : 'soft',
    human_error_enabled: Boolean(parsed.human_error_enabled),
    human_error_types: Array.isArray(parsed.human_error_types)
      ? parsed.human_error_types.filter((t) => VALID_ERROR_TYPES.includes(t))
      : [],
    human_error_random: Boolean(parsed.human_error_random),
    no_trailing_period: Boolean(parsed.no_trailing_period),
    bot_deny_response: String(parsed.bot_deny_response || "I'm a real person, just quick at responding!").slice(0, 300),
    style_summary: String(parsed.style_summary || '').slice(0, 500),
  };

  const knowledge_base = String(parsed.knowledge_base || '').slice(0, 5000);

  logger.info({
    agent_name: persona.agent_name,
    tone: persona.tone,
    response_length: persona.response_length,
    conversation_approach: persona.conversation_approach,
    human_error_enabled: persona.human_error_enabled,
    fileCount: files.length,
    imageCount: imageBlocks.length,
    hasKnowledgeBase: knowledge_base.length > 0,
  }, '[personaGenerator] Persona generated successfully');

  return { persona, style_summary: persona.style_summary, knowledge_base };
}

module.exports = { generatePersonaFromFiles };
