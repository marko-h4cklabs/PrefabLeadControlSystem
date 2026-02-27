/**
 * Request ID middleware. Assigns a unique ID to every request for log tracing.
 * Passes through x-request-id from upstream (load balancer) or generates a new one.
 */
const { randomUUID } = require('crypto');

function requestIdMiddleware(req, res, next) {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}

module.exports = requestIdMiddleware;
