const crypto = require('crypto');
const logger = require('../lib/logger');

function isEmailConfigured() {
  return !!(process.env.SENDGRID_API_KEY || (process.env.SMTP_USER && process.env.SMTP_PASS));
}

/**
 * Send email using SendGrid HTTP API (preferred) or nodemailer SMTP fallback.
 * Railway blocks outbound SMTP (port 587), so we use SendGrid's REST API on port 443.
 */
async function sendEmail({ to, subject, html }) {
  const fromEmail = process.env.EMAIL_FROM || 'noreply@eightpath.dev';
  const appName = process.env.APP_NAME || 'EightPath';

  if (process.env.SENDGRID_API_KEY) {
    // Use SendGrid HTTP API — works on Railway (port 443 not blocked)
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    await sgMail.send({
      to,
      from: { email: fromEmail, name: appName },
      subject,
      html,
    });
    return;
  }

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    // Fallback: nodemailer SMTP
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    await transporter.sendMail({
      from: `"${appName}" <${fromEmail}>`,
      to,
      subject,
      html,
    });
    return;
  }

  throw new Error('Email service not configured. Set SENDGRID_API_KEY or SMTP_USER/SMTP_PASS.');
}

function generateVerifyToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendVerificationEmail(toEmail, userName, token) {
  const appName = process.env.APP_NAME || 'EightPath';
  const backendUrl = process.env.BACKEND_URL || 'https://api.eightpath.dev';
  const verifyUrl = `${backendUrl}/api/auth/verify-email?token=${token}`;

  await sendEmail({
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
  const appName = process.env.APP_NAME || 'EightPath';
  const frontendUrl = process.env.FRONTEND_URL || 'https://app.eightpath.dev';
  const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

  await sendEmail({
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

async function sendVerificationCode(toEmail, userName, code) {
  const appName = process.env.APP_NAME || 'EightPath';
  const digits = code.split('').map(d =>
    `<span style="display:inline-block;width:44px;height:52px;line-height:52px;text-align:center;font-size:24px;font-weight:bold;background:#1a1a1a;border:1px solid #333;border-radius:8px;margin:0 3px;color:#fff;">${d}</span>`
  ).join('');

  await sendEmail({
    to: toEmail,
    subject: `Your verification code — ${appName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #0a0a0a; color: #ffffff; padding: 40px; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <div style="background: #f5c518; width: 48px; height: 48px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; font-weight: bold; font-size: 20px; color: #000;">P</div>
        </div>
        <h2 style="margin: 0 0 8px; font-size: 22px; text-align: center;">Welcome, ${userName || 'there'}!</h2>
        <p style="color: #aaa; margin: 0 0 24px; text-align: center;">Enter this code to verify your email address.</p>
        <div style="text-align: center; margin: 0 0 24px;">
          ${digits}
        </div>
        <p style="color: #666; font-size: 12px; margin-top: 24px; text-align: center;">
          This code expires in 10 minutes. If you didn't create an account, ignore this email.
        </p>
      </div>
    `,
  });
}

module.exports = { generateVerifyToken, generateVerificationCode, sendVerificationEmail, sendVerificationCode, sendPasswordResetEmail, isEmailConfigured };
