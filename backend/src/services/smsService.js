function getTwilioClient() {
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!sid || !token) return null;
  const twilio = require('twilio');
  return twilio(sid, token);
}

function generateSmsCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendVerificationSms(phoneNumber, code) {
  const client = getTwilioClient();
  if (!client) {
    console.warn('[sms] Twilio not configured — skipping SMS verification');
    return false;
  }
  await client.messages.create({
    body: `Your verification code is: ${code}. Expires in 10 minutes.`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phoneNumber,
  });
  return true;
}

module.exports = {
  generateSmsCode,
  sendVerificationSms,
  isTwilioConfigured: () => !!getTwilioClient(),
};
