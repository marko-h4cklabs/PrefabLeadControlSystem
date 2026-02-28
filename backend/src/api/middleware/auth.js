const jwt = require('jsonwebtoken');
const { userRepository } = require('../../../db/repositories');

function errorResponse(res, statusCode, message, errorCode = null) {
  const code = errorCode || (statusCode === 401 ? 'UNAUTHORIZED' : statusCode === 403 ? 'FORBIDDEN' : 'ERROR');
  return res.status(statusCode).json({ error: { code, message } });
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return errorResponse(res, 401, 'Missing or invalid Authorization header', 'UNAUTHORIZED');
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return errorResponse(res, 401, 'Missing token', 'UNAUTHORIZED');
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = payload.id ?? payload.userId;
    const { companyId, role } = payload;
    if (!userId || !companyId) {
      return errorResponse(res, 401, 'Invalid token payload', 'UNAUTHORIZED');
    }
    const user = await userRepository.findByIdOnly(userId);
    if (!user || user.company_id !== companyId) {
      return errorResponse(res, 401, 'User not found or tenant mismatch', 'UNAUTHORIZED');
    }
    req.user = {
      id: user.id,
      companyId: user.company_id,
      role: user.role,
      email: user.email,
      full_name: user.full_name || '',
      setter_status: user.setter_status || 'offline',
      account_type: user.account_type || 'owner',
      is_admin: Boolean(user.is_admin),
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return errorResponse(res, 401, 'Token expired', 'UNAUTHORIZED');
    }
    if (err.name === 'JsonWebTokenError') {
      return errorResponse(res, 401, 'Invalid token', 'UNAUTHORIZED');
    }
    return errorResponse(res, 401, 'Authentication failed', 'UNAUTHORIZED');
  }
}

function requireRole(...allowedRoles) {
  const roleMap = {
    owner: ['owner'],
    admin: ['owner', 'admin'],
    setter: ['owner', 'admin', 'setter'],
    member: ['owner', 'admin', 'sales', 'member', 'setter'],
  };
  return (req, res, next) => {
    if (!req.user) {
      return errorResponse(res, 401, 'Authentication required', 'UNAUTHORIZED');
    }
    const userRole = req.user.role;
    const allowed = new Set();
    for (const r of allowedRoles) {
      (roleMap[r] || [r]).forEach((x) => allowed.add(x));
    }
    if (!allowed.has(userRole)) {
      return errorResponse(res, 403, 'Insufficient permissions', 'FORBIDDEN');
    }
    next();
  };
}

module.exports = { authMiddleware, requireRole, errorResponse };
