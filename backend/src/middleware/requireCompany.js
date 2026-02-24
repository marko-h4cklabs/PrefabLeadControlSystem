/**
 * Ensures req.companyId is set from token/user or x-company-id.
 * Use after authMiddleware (and tenantMiddleware) so req.user and req.tenantId are available.
 */
function requireCompany(req, res, next) {
  const companyId =
    req.companyId ||
    req.tenantId ||
    req.user?.companyId ||
    (req.headers['x-company-id'] && String(req.headers['x-company-id']).trim()) ||
    null;
  if (!companyId) {
    return res.status(400).json({ error: 'company_id required' });
  }
  if (req.tenantId && req.tenantId !== companyId) {
    return res.status(403).json({ error: 'x-company-id does not match authenticated tenant' });
  }
  req.companyId = companyId;
  if (!req.tenantId) req.tenantId = companyId;
  next();
}

module.exports = { requireCompany };
