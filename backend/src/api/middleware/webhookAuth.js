const { companyRepository } = require('../../../db/repositories');

function webhookAuthMiddleware(req, res, next) {
  const secret = req.headers['x-webhook-secret'];
  const expected = process.env.WEBHOOK_SECRET;

  if (!expected || !secret) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Missing webhook secret' },
    });
  }
  if (secret !== expected) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Invalid webhook secret' },
    });
  }

  const companyId = req.headers['x-company-id'];
  if (!companyId) {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'Missing X-Company-Id header for tenant context' },
    });
  }

  companyRepository
    .findById(companyId)
    .then((company) => {
      if (!company) {
        return res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Company not found' },
        });
      }
      req.tenantId = companyId;
      next();
    })
    .catch((err) => {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: err.message },
      });
    });
}

module.exports = { webhookAuthMiddleware };
