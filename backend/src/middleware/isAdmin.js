const { userRepository } = require('../../db/repositories');
const { verifyToken } = require('../utils/auth');

async function isAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);
    if (!decoded) return res.status(403).json({ error: 'Forbidden' });
    const userId = decoded.userId ?? decoded.id;
    if (!userId) return res.status(403).json({ error: 'Forbidden' });
    const user = await userRepository.getUserById(userId);
    if (!user || !user.is_admin) return res.status(403).json({ error: 'Forbidden' });
    req.adminUser = user;
    req.user = {
      id: user.id,
      companyId: user.company_id,
      role: user.role,
      email: user.email,
      is_admin: true,
    };
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Forbidden' });
  }
}

module.exports = isAdmin;
