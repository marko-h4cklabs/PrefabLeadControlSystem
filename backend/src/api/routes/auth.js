const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { userRepository } = require('../../../db/repositories');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password, companyId } = req.body;
    const companyIdFromHeader = req.headers['x-company-id'];
    const tenantId = companyId || companyIdFromHeader;

    if (!email || !password) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'email and password are required' },
      });
    }
    if (!tenantId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'companyId or x-company-id required for login' },
      });
    }
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'JWT_SECRET is not configured' },
      });
    }

    const user = await userRepository.findByEmail(tenantId, email.trim());
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
      { userId: user.id, companyId: user.company_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    res.json({
      token,
      user: { id: user.id, companyId: user.company_id, role: user.role, email: user.email },
    });
  } catch (err) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
});

module.exports = router;
