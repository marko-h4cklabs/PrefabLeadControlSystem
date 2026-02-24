/**
 * Post-processes the AI reply: removes AI self-identification, formal openers, and enforces quality.
 */
function validateAndCleanReply(reply, behavior) {
  if (!reply || typeof reply !== 'string') return '';

  let cleaned = reply;

  const aiPhrases = [
    /as an ai/gi,
    /as an artificial intelligence/gi,
    /i am an ai/gi,
    /i'm an ai/gi,
    /i am a (language model|llm|chatbot|bot)/gi,
    /i('m| am) claude/gi,
    /i('m| am) gpt/gi,
    /i('m| am) chatgpt/gi,
    /i was (trained|designed|programmed)/gi,
    /my (training|knowledge) (cutoff|data)/gi,
  ];
  aiPhrases.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, '');
  });

  const formalOpeners = [
    /^(dear|hello there|good (morning|afternoon|evening)|greetings|hope (this|you))[,!.]?\s*/gi,
    /^(hi there|hey there),?\s+i hope you('re| are) (doing well|having a great day)[.!,]?\s*/gi,
  ];
  formalOpeners.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, '');
  });

  cleaned = cleaned.replace(/!{2,}/g, '!');
  cleaned = cleaned.replace(/\?{2,}/g, '?');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  if (!behavior?.emojis_enabled) {
    cleaned = cleaned.replace(
      /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu,
      ''
    );
  }

  cleaned = cleaned.trim();

  if (!cleaned) {
    return 'Thanks for reaching out! Let me check on that for you.';
  }

  return cleaned;
}

function checkReplyQuality(reply) {
  const issues = [];

  if (reply.length > 600) {
    issues.push('Reply is too long (over 600 characters)');
  }
  if ((reply.match(/\?/g) || []).length > 2) {
    issues.push('Reply contains too many questions');
  }
  if (reply.toLowerCase().includes('as an ai')) {
    issues.push('Reply mentions being an AI');
  }

  return issues;
}

module.exports = { validateAndCleanReply, checkReplyQuality };
