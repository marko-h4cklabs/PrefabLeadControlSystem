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

  // Remove filler transition phrases — these sound robotic and unnatural
  const fillerPhrases = [
    /\bmoving forward[,.]?\s*/gi,
    /\bstanding by[,.]?\s*/gi,
    /\bnoted[,.]?\s*(will assist|i'll help|let me)[,.]?\s*/gi,
    /\bnoted[,.]?\s*/gi,
    /\bgot it[,.]?\s*(i'll|let me|will)\s*/gi,
    /\bsounds good[,.]?\s*(let me|i'll|will)\s*/gi,
    /\bperfect[,.]?\s*(let me|i'll|will)\s*/gi,
    /\bgreat choice[,.]?\s*/gi,
    /\bexcellent[,.]?\s*/gi,
    /\babsolutely[,.]?\s*/gi,
    /\bcertainly[,.]?\s*/gi,
    /\bof course[,.]?\s*/gi,
    /\bsure thing[,.]?\s*/gi,
    /\bwill do[,.]?\s*/gi,
    /\bright away[,.]?\s*/gi,
    /\bstanding by\s*/gi,
    /\bmuch appreciated[,.]?\s*/gi,
    /\btalk soon[,.]?\s*/gi,
    /\bhope this helps[,.]?\s*/gi,
    /\bdoes that make sense\??\s*/gi,
    /\blet me know if you (have any|need any) (questions|help)[.!]?\s*/gi,
    /\bfeel free to (ask|reach out)[.!]?\s*/gi,
    /\bdon't hesitate to (ask|reach out)[.!]?\s*/gi,
    /\bi hope (this|that) (helps|answers)[.!]?\s*/gi,
    /\bi understand (your|that)[,.]?\s*/gi,
    /\bthank you for (reaching out|your message|contacting)[.!]?\s*/gi,
    /\bthanks for (reaching out|your message|contacting)[.!]?\s*/gi,
  ];
  fillerPhrases.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, '');
  });

  // Also remove standalone filler words at the START of a reply
  cleaned = cleaned.replace(/^(absolutely|certainly|of course|sure|great|perfect|wonderful|fantastic|awesome|noted)[,!.]?\s+/gi, '');

  // Clean up double spaces and leading/trailing whitespace after removals
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

  // If the reply starts with a lowercase letter after stripping (due to phrase removal), capitalize it
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
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
