const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { pool } = require('../../../db');
const { userRepository } = require('../../../db/repositories');

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/signup', async (req, res) => {
  try {
    const { companyName, email, password } = req.body;

    if (!companyName || typeof companyName !== 'string') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'companyName is required' },
      });
    }
    const cn = companyName.trim();
    if (cn.length < 2 || cn.length > 120) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'companyName must be 2–120 characters' },
      });
    }
    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'email is required' },
      });
    }
    if (!EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid email format' },
      });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'password must be at least 8 characters' },
      });
    }

    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'JWT_SECRET is not configured' },
      });
    }

    const emailLower = email.trim().toLowerCase();
    const existing = await userRepository.findByEmailOnly(emailLower);
    if (existing) {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'Email already in use' },
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const client = await pool.connect();
    let company;
    let user;
    try {
      await client.query('BEGIN');
      const companyRes = await client.query(
        `INSERT INTO companies (name, contact_email, contact_phone, chatbot_style, scoring_config, channels_enabled)
         VALUES ($1, $2, NULL, '{}', '{}', '[]')
         RETURNING id, name`,
        [cn, emailLower]
      );
      company = companyRes.rows[0];
      const userRes = await client.query(
        `INSERT INTO users (company_id, email, password_hash, role)
         VALUES ($1, $2, $3, 'admin')
         RETURNING id, email, role`,
        [company.id, emailLower, passwordHash]
      );
      user = userRes.rows[0];
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    const token = jwt.sign(
      { id: user.id, companyId: company.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
      company: { id: company.id, name: company.name },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'Email already in use' },
      });
    }
    if (err.code === '23514') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid data' },
      });
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

    const token = jwt.sign(
      { id: user.id, companyId: user.company_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
      companyId: user.company_id,
    });
  } catch (err) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
});

const { authMiddleware } = require('../middleware/auth');

router.get('/me', authMiddleware, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    role: req.user.role,
    companyId: req.user.companyId,
  });
});

module.exports = router;
