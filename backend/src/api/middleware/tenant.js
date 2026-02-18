/**
 * MVP tenant context: reads x-company-id header.
 * In production, replace with JWT/session-based auth.
 */
function tenantMiddleware(req, res, next) {
  const companyId = req.headers['x-company-id'];
  if (!companyId) {
    return res.status(401).json({ error: 'Missing x-company-id header' });
  }
  req.companyId = companyId;
  next();
}

/**
 * Validates that req.params.id matches tenant context.
 * Use for routes like /api/companies/:id
 */
function requireCompanyMatch(req, res, next) {
  if (req.params.id !== req.companyId) {
    return res.status(403).json({ error: 'Company ID does not match tenant context' });
  }
  next();
}

module.exports = { tenantMiddleware, requireCompanyMatch };
