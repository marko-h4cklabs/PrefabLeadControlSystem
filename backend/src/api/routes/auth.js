const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { pool } = require('../../../db');
const { userRepository, companyRepository, chatbotBehaviorRepository } = require('../../../db/repositories');

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
      `INSERT INTO users (company_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       RETURNING id, email, role`,
      [company.id, email, passwordHash]
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

    const { company, user } = await registerCompanyAndUser({
      company_name: companyName,
      email: body.email,
      password: body.password,
      full_name: body.full_name || body.fullName,
    });

    const token = jwt.sign(
      { id: user.id, companyId: company.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
      company: { id: company.id, name: company.name, webhook_token: company.webhook_token },
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
    const { company, user } = await registerCompanyAndUser({
      company_name: body.company_name || body.companyName,
      full_name: body.full_name || body.fullName,
      email: body.email,
      password: body.password,
    });

    const token = jwt.sign(
      { id: user.id, companyId: company.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
      company: { id: company.id, name: company.name, webhook_token: company.webhook_token },
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

    const user = await userRepository.findByEmailOnly(email.trim().toLowerCase());
    if (!user) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
      });
    }

    let match = false;
    try {
      match = await bcrypt.compare(password, user.password_hash);
    } catch {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
      });
    }
    if (!match) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
      });
    }

    const company = await companyRepository.findById(user.company_id);
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

const { authMiddleware } = require('../middleware/auth');

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
