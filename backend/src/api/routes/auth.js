const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const axios = require('axios');
const { pool } = require('../../../db');
const { userRepository, companyRepository, chatbotBehaviorRepository } = require('../../../db/repositories');
const { authMiddleware } = require('../middleware/auth');
const { generateVerifyToken, sendVerificationEmail } = require('../../services/emailService');
const { generateSmsCode, sendVerificationSms, isTwilioConfigured } = require('../../services/smsService');
const { getGoogleUserInfo, isGoogleConfigured } = require('../../services/googleAuthService');

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function registerCompanyAndUser(body) {
  const companyName = (body.company_name || body.companyName || '').trim();
  const fullName = (body.full_name || body.fullName || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password;

  if (!companyName || companyName.length < 2 || companyName.length > 120) {
    throw Object.assign(new Error('company_name is required (2–120 characters)'), { statusCode: 400 });
  }
  if (!email || !EMAIL_REGEX.test(email)) {
    throw Object.assign(new Error('Valid email is required'), { statusCode: 400 });
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw Object.assign(new Error('password must be at least 8 characters'), { statusCode: 400 });
  }

  const existing = await userRepository.findByEmailOnly(email);
  if (existing) {
    throw Object.assign(new Error('Email already in use'), { statusCode: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const webhookToken = crypto.randomBytes(32).toString('hex');
  const client = await pool.connect();
  let company;
  let user;
  try {
    await client.query('BEGIN');
    const companyRes = await client.query(
      `INSERT INTO companies (
        name, contact_email, contact_phone, chatbot_style, scoring_config, channels_enabled,
        subscription_status, subscription_plan, trial_ends_at, monthly_message_count, webhook_token
      ) VALUES ($1, $2, NULL, '{}', '{}', '[]', 'trial', 'trial', NOW() + INTERVAL '14 days', 0, $3)
      RETURNING id, name, webhook_token`,
      [companyName, email, webhookToken]
    );
    company = companyRes.rows[0];
    const userRes = await client.query(
      `INSERT INTO users (company_id, email, password_hash, role, full_name)
       VALUES ($1, $2, $3, 'admin', $4)
       RETURNING id, email, role, full_name`,
      [company.id, email, passwordHash, fullName || null]
    );
    user = userRes.rows[0];
    await client.query('COMMIT');
  } catch (txErr) {
    await client.query('ROLLBACK').catch(() => {});
    throw txErr;
  } finally {
    client.release();
  }

  await chatbotBehaviorRepository.upsert(company.id, {
    persona_style: 'professional',
    response_length: 'medium',
    emojis_enabled: true,
    agent_name: 'Alex',
    conversation_goal: 'Book a sales call',
    opener_style: 'greeting',
  });

  const warmingService = require('../../services/warmingService');
  warmingService.ensureDefaultSequences(company.id).catch(() => {});

  return { company, user };
}

router.post('/signup', async (req, res) => {
  try {
    const body = req.body || {};
    const companyName = (body.companyName || body.company_name || '').trim();
    if (!companyName) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'companyName is required' },
      });
    }
    if (!body.email || !EMAIL_REGEX.test(String(body.email).trim())) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Valid email is required' },
      });
    }
    if (!body.password || String(body.password).length < 8) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'password must be at least 8 characters' },
      });
    }
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'JWT_SECRET is not configured' },
      });
    }

    const phoneNumber = body.phone_number || body.phoneNumber || null;
    const countryCode = body.country_code || body.countryCode || null;

    const { company, user } = await registerCompanyAndUser({
      company_name: companyName,
      email: body.email,
      password: body.password,
      full_name: body.full_name || body.fullName,
    });

    const verifyToken = generateVerifyToken();
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `UPDATE users SET
        email_verify_token = $1,
        email_verify_expires = $2,
        email_verified = false,
        phone_number = $3,
        country_code = $4,
        auth_provider = 'email'
      WHERE id = $5`,
      [verifyToken, verifyExpires, phoneNumber || null, countryCode || null, user.id]
    );

    if (countryCode) {
      await pool.query('UPDATE companies SET country_code = $1 WHERE id = $2', [
        countryCode,
        company.id,
      ]);
    }

    sendVerificationEmail(
      user.email,
      body.full_name || body.fullName || companyName,
      verifyToken
    ).catch((err) => {
      console.error('[register] Failed to send verification email:', err.message);
    });

    const token = jwt.sign(
      { id: user.id, companyId: company.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, role: user.role, email_verified: false },
      company: { id: company.id, name: company.name, webhook_token: company.webhook_token },
      message: 'Account created. Please check your email to verify your account.',
      requires_verification: true,
    });
  } catch (err) {
    if (err.statusCode === 409) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: err.message } });
    }
    if (err.statusCode === 400) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    if (err.code === '23505') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'Email already in use' } });
    }
    if (err.code === '23514') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid data' } });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
});

router.post('/register', async (req, res) => {
  try {
    const body = req.body || {};
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'JWT_SECRET is not configured' },
      });
    }
    const phoneNumber = body.phone_number || body.phoneNumber || null;
    const countryCode = body.country_code || body.countryCode || null;
    const { company, user } = await registerCompanyAndUser({
      company_name: body.company_name || body.companyName,
      full_name: body.full_name || body.fullName,
      email: body.email,
      password: body.password,
    });

    const verifyToken = generateVerifyToken();
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `UPDATE users SET
        email_verify_token = $1,
        email_verify_expires = $2,
        email_verified = false,
        phone_number = $3,
        country_code = $4,
        auth_provider = 'email'
      WHERE id = $5`,
      [verifyToken, verifyExpires, phoneNumber || null, countryCode || null, user.id]
    );

    if (countryCode) {
      await pool.query('UPDATE companies SET country_code = $1 WHERE id = $2', [
        countryCode,
        company.id,
      ]);
    }

    sendVerificationEmail(
      user.email,
      body.full_name || body.fullName || body.company_name || body.companyName,
      verifyToken
    ).catch((err) => {
      console.error('[register] Failed to send verification email:', err.message);
    });

    const token = jwt.sign(
      { id: user.id, companyId: company.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, role: user.role, email_verified: false },
      company: { id: company.id, name: company.name, webhook_token: company.webhook_token },
      message: 'Account created. Please check your email to verify your account.',
      requires_verification: true,
    });
  } catch (err) {
    if (err.statusCode === 409) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: err.message } });
    }
    if (err.statusCode === 400) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    if (err.code === '23505') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'Email already in use' } });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'email and password are required' },
      });
    }
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'JWT_SECRET is not configured' },
      });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email.trim().toLowerCase()]
    );
    const user = result.rows[0];
    if (user && user.locked_until && new Date() < new Date(user.locked_until)) {
      const minutesLeft = Math.ceil(
        (new Date(user.locked_until) - new Date()) / 60000
      );
      return res
        .status(429)
        .json({ error: `Account temporarily locked. Try again in ${minutesLeft} minutes.` });
    }
    if (!user) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
      });
    }

    let match = false;
    try {
      match = await bcrypt.compare(password, user.password_hash);
    } catch {
      match = false;
    }
    if (!match) {
      const attempts = (user.login_attempts || 0) + 1;
      const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await pool.query(
        'UPDATE users SET login_attempts = $1, locked_until = $2 WHERE email = $3',
        [attempts, lockUntil, email.trim().toLowerCase()]
      );
      if (attempts >= 5) {
        return res
          .status(429)
          .json({ error: 'Too many failed attempts. Account locked for 15 minutes.' });
      }
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
      });
    }

    const company = await companyRepository.findById(user.company_id);
    await pool.query(
      'UPDATE users SET login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1',
      [user.id]
    );
    const token = jwt.sign(
      { id: user.id, companyId: user.company_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role, companyId: user.company_id },
      company: company ? { id: company.id, name: company.name } : { id: user.company_id, name: '' },
    });
  } catch (err) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
});

// GET /api/auth/verify-email?token=xxx
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send(verifyPage('invalid', 'No token provided'));

  try {
    const result = await pool.query(
      `SELECT id, email, email_verify_expires FROM users
       WHERE email_verify_token = $1 AND email_verified = false`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.send(
        verifyPage('invalid', 'This verification link is invalid or already used.')
      );
    }

    const user = result.rows[0];
    if (new Date() > new Date(user.email_verify_expires)) {
      return res.send(
        verifyPage('expired', 'This link has expired. Please request a new one.')
      );
    }

    await pool.query(
      `UPDATE users
       SET email_verified = true, email_verify_token = NULL, email_verify_expires = NULL
       WHERE id = $1`,
      [user.id]
    );

    const frontendUrl =
      process.env.FRONTEND_URL || 'https://prefab-lead-hub-c6cbca89.vercel.app';
    return res.redirect(`${frontendUrl}/onboarding?verified=true`);
  } catch (err) {
    return res.send(verifyPage('error', 'Something went wrong. Please try again.'));
  }
});

// POST /api/auth/resend-verification
router.post('/resend-verification', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, full_name, email_verified FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.email_verified) return res.json({ message: 'Email already verified' });

    const token = generateVerifyToken();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      'UPDATE users SET email_verify_token = $1, email_verify_expires = $2 WHERE id = $3',
      [token, expires, req.user.id]
    );
    await sendVerificationEmail(user.email, user.full_name, token);
    res.json({ success: true, message: 'Verification email sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/send-phone-code
router.post('/send-phone-code', authMiddleware, async (req, res) => {
  try {
    const { phone_number } = req.body || {};
    if (!phone_number) return res.status(400).json({ error: 'Phone number required' });

    const normalized = String(phone_number).replace(/\s/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
      return res.status(400).json({
        error: 'Invalid phone format. Use international format: +1234567890',
      });
    }

    const code = generateSmsCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      'UPDATE users SET phone_number = $1, phone_verify_code = $2, phone_verify_expires = $3 WHERE id = $4',
      [normalized, code, expires, req.user.id]
    );

    if (!isTwilioConfigured()) {
      console.log(`[dev] SMS code for ${normalized}: ${code}`);
      return res.json({
        success: true,
        dev_code: process.env.NODE_ENV !== 'production' ? code : undefined,
        message: 'Code sent',
      });
    }

    await sendVerificationSms(normalized, code);
    res.json({ success: true, message: 'Verification code sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/verify-phone
router.post('/verify-phone', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body || {};
    const result = await pool.query(
      'SELECT phone_verify_code, phone_verify_expires FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user || !user.phone_verify_code) {
      return res.status(400).json({ error: 'No pending verification' });
    }
    if (new Date() > new Date(user.phone_verify_expires)) {
      return res.status(400).json({ error: 'Code expired. Request a new one.' });
    }
    if (user.phone_verify_code !== String(code).trim()) {
      return res.status(400).json({ error: 'Incorrect code' });
    }

    await pool.query(
      'UPDATE users SET phone_verified = true, phone_verify_code = NULL, phone_verify_expires = NULL WHERE id = $1',
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google OAuth
// GET /api/auth/google — redirect to Google
router.get('/google', (req, res) => {
  if (!isGoogleConfigured()) {
    const frontendUrl =
      process.env.FRONTEND_URL || 'https://prefab-lead-hub-c6cbca89.vercel.app';
    return res.redirect(`${frontendUrl}/login?error=google_not_configured`);
  }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${process.env.BACKEND_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /api/auth/google/callback
router.get('/google/callback', async (req, res) => {
  const frontendUrl =
    process.env.FRONTEND_URL || 'https://prefab-lead-hub-c6cbca89.vercel.app';
  try {
    const { code } = req.query;
    if (!code) return res.redirect(`${frontendUrl}/login?error=google_denied`);

    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${process.env.BACKEND_URL}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    });

    const { access_token } = tokenRes.data;
    const googleUser = await getGoogleUserInfo(access_token);
    const { id: googleId, email, name } = googleUser;

    let userId;
    let companyId;
    let isNewUser = false;

    const existing = await pool.query(
      'SELECT * FROM users WHERE google_id = $1 OR LOWER(email) = LOWER($2) LIMIT 1',
      [googleId, email]
    );

    if (existing.rows.length > 0) {
      const u = existing.rows[0];
      userId = u.id;
      companyId = u.company_id;
      await pool.query(
        'UPDATE users SET google_id = $1, email_verified = true, last_login_at = NOW() WHERE id = $2',
        [googleId, userId]
      );
    } else {
      isNewUser = true;
      const companyName = name ? `${name}'s Business` : 'My Business';
      const webhookToken = crypto.randomBytes(32).toString('hex');

      const companyResult = await pool.query(
        `INSERT INTO companies (
           id, name, subscription_status, subscription_plan, trial_ends_at,
           monthly_message_count, webhook_token, created_at
         )
         VALUES (gen_random_uuid(), $1, 'trial', 'trial', NOW() + INTERVAL '14 days', 0, $2, NOW())
         RETURNING id`,
        [companyName, webhookToken]
      );
      companyId = companyResult.rows[0].id;

      const userResult = await pool.query(
        `INSERT INTO users (
           id, company_id, email, full_name, email_verified, google_id,
           auth_provider, last_login_at, role, created_at
         )
         VALUES (gen_random_uuid(), $1, $2, $3, true, $4, 'google', NOW(), 'admin', NOW())
         RETURNING id`,
        [companyId, email, name, googleId]
      );
      userId = userResult.rows[0].id;

      await pool.query(
        `INSERT INTO chatbot_behavior (
           company_id, persona_style, response_length, emojis_enabled, agent_name,
           conversation_goal, opener_style
         )
         VALUES ($1, 'professional', 'medium', true, 'Alex', 'Book a sales call', 'greeting')
         ON CONFLICT (company_id) DO NOTHING`,
        [companyId]
      );
    }

    const token = jwt.sign(
      { id: userId, companyId, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    const redirectPath = isNewUser ? '/onboarding' : '/dashboard';
    return res.redirect(
      `${frontendUrl}/auth/callback?token=${token}&companyId=${companyId}&isNew=${isNewUser}&redirect=${redirectPath}`
    );
  } catch (err) {
    console.error('[google/callback]', err.message);
    return res.redirect(`${frontendUrl}/login?error=google_failed`);
  }
});

// Simple HTML page for email verification result
function verifyPage(status, message) {
  const frontendUrl =
    process.env.FRONTEND_URL || 'https://prefab-lead-hub-c6cbca89.vercel.app';
  return `<!DOCTYPE html><html><head><title>Email Verification</title><style>
    body{font-family:Arial,sans-serif;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
    .card{background:#111;border:1px solid #222;border-radius:12px;padding:40px;max-width:400px;text-align:center;}
    .icon{font-size:48px;margin-bottom:16px;}
    h2{margin:0 0 8px;}p{color:#aaa;}
    a{display:inline-block;margin-top:24px;background:#f5c518;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;}
  </style></head><body><div class="card">
    <div class="icon">${status === 'invalid' || status === 'expired' ? '❌' : '⚠️'}</div>
    <h2>${status === 'expired' ? 'Link Expired' : 'Verification Failed'}</h2>
    <p>${message}</p>
    <a href="${frontendUrl}/login">Back to Login</a>
  </div></body></html>`;
}
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const company = await companyRepository.findById(req.user.companyId);
    const operating_mode = company?.operating_mode ?? null;
    const google_calendar_connected = company?.google_calendar_connected === true;
    res.json({
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      companyId: req.user.companyId,
      company_name: company?.name ?? null,
      is_admin: Boolean(req.user.is_admin),
      operating_mode,
      google_calendar_connected,
    });
  } catch (err) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
});

module.exports = router;
