const jwt = require('jsonwebtoken');

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const decoded = jwt.verify(token.trim(), process.env.JWT_SECRET);
    return decoded;
  } catch {
    return null;
  }
}

module.exports = { verifyToken };
