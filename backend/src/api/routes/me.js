const express = require('express');
const bcrypt = require('bcrypt');
const { userRepository } = require('../../../db/repositories');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.use(authMiddleware);

router.get('/', (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    name: req.user.name ?? null,
    company_id: req.user.companyId,
    is_admin: Boolean(req.user.is_admin),
  });
});

router.put('/email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'email is required' },
      });
    }
    const emailLower = email.trim().toLowerCase();
    if (!EMAIL_REGEX.test(emailLower)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid email format' },
      });
    }
    const existing = await userRepository.findByEmailOnly(emailLower);
    if (existing && existing.id !== req.user.id) {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'Email already in use' },
      });
    }
    const updated = await userRepository.update(req.user.companyId, req.user.id, {
      email: emailLower,
    });
    if (!updated) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'User not found' },
      });
    }
    res.json({ ok: true, email: updated.email });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'Email already in use' },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

router.put('/password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || typeof current_password !== 'string') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'current_password is required' },
      });
    }
    if (!new_password || typeof new_password !== 'string' || new_password.length < 8) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'new_password must be at least 8 characters' },
      });
    }
    const user = await userRepository.findById(req.user.companyId, req.user.id);
    if (!user) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'User not found' },
      });
    }
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Current password is incorrect' },
      });
    }
    const passwordHash = await bcrypt.hash(new_password, 10);
    const updated = await userRepository.update(req.user.companyId, req.user.id, {
      password_hash: passwordHash,
    });
    if (!updated) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'User not found' },
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

module.exports = router;
