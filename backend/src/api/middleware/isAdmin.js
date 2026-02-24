/**
 * Protects /api/admin/* routes. Requires valid Bearer token and users.is_admin = true.
 * Must run after authMiddleware (so req.user is set).
 */

function isAdminMiddleware(req, res, next) {
  if (!req.user) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

module.exports = { isAdminMiddleware };
