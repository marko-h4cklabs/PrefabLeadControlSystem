const nodemailer = require('nodemailer');
const crypto = require('crypto');

function getTransporter() {
  // Supports SendGrid, Mailgun, or any SMTP
  // Set EMAIL_PROVIDER=sendgrid or smtp
  if (process.env.SENDGRID_API_KEY) {
    return nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      auth: {
        user: 'apikey',
        pass: process.env.SENDGRID_API_KEY,
      },
    });
  }
  // Generic SMTP fallback
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function generateVerifyToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function sendVerificationEmail(toEmail, userName, token) {
  const fromEmail = process.env.EMAIL_FROM || 'noreply@prefableadcontrolsystem.com';
  const appName = process.env.APP_NAME || 'Prefab Lead Control System';
  const backendUrl =
    process.env.BACKEND_URL || 'https://prefableadcontrolsystem-production.up.railway.app';
  const verifyUrl = `${backendUrl}/api/auth/verify-email?token=${token}`;

  const transporter = getTransporter();
  await transporter.sendMail({
    from: `"${appName}" <${fromEmail}>`,
    to: toEmail,
    subject: `Verify your email — ${appName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #0a0a0a; color: #ffffff; padding: 40px; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <div style="background: #f5c518; width: 48px; height: 48px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; font-weight: bold; font-size: 20px; color: #000;">P</div>
        </div>
        <h2 style="margin: 0 0 8px; font-size: 22px;">Welcome, ${userName || 'there'}!</h2>
        <p style="color: #aaa; margin: 0 0 32px;">Click the button below to verify your email and activate your account.</p>
        <a href="${verifyUrl}" style="display: block; background: #f5c518; color: #000; text-align: center; padding: 14px 24px; border-radius: 8px; font-weight: bold; text-decoration: none; font-size: 16px;">
          ✓ Verify My Email
        </a>
        <p style="color: #666; font-size: 12px; margin-top: 24px; text-align: center;">
          This link expires in 24 hours. If you didn't create an account, ignore this email.
        </p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail(toEmail, token) {
  const fromEmail = process.env.EMAIL_FROM || 'noreply@prefableadcontrolsystem.com';
  const appName = process.env.APP_NAME || 'Prefab Lead Control System';
  const frontendUrl =
    process.env.FRONTEND_URL || 'https://prefab-lead-hub-c6cbca89.vercel.app';
  const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

  const transporter = getTransporter();
  await transporter.sendMail({
    from: `"${appName}" <${fromEmail}>`,
    to: toEmail,
    subject: `Reset your password — ${appName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #0a0a0a; color: #ffffff; padding: 40px; border-radius: 12px;">
        <h2 style="margin: 0 0 8px;">Reset your password</h2>
        <p style="color: #aaa; margin: 0 0 32px;">Click below to set a new password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" style="display: block; background: #f5c518; color: #000; text-align: center; padding: 14px 24px; border-radius: 8px; font-weight: bold; text-decoration: none;">
          Reset Password
        </a>
        <p style="color: #666; font-size: 12px; margin-top: 24px; text-align: center;">
          If you didn't request this, ignore this email.
        </p>
      </div>
    `,
  });
}

module.exports = { generateVerifyToken, sendVerificationEmail, sendPasswordResetEmail };
