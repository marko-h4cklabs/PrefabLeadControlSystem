const { errorResponse } = require('./auth');

function tenantMiddleware(req, res, next) {
  if (!req.user) {
    return errorResponse(res, 401, 'Authentication required', 'UNAUTHORIZED');
  }
  req.tenantId = req.user.companyId;
  const headerCompanyId = req.headers['x-company-id'];
  if (headerCompanyId && headerCompanyId.trim() !== '') {
    if (headerCompanyId.trim() !== req.tenantId) {
      return errorResponse(res, 403, 'x-company-id does not match authenticated tenant', 'FORBIDDEN');
    }
  }
  next();
}

function requireCompanyMatch(req, res, next) {
  const paramId = req.params.id;
  if (paramId !== req.tenantId) {
    return errorResponse(res, 403, 'Company ID does not match authenticated tenant', 'FORBIDDEN');
  }
  next();
}

module.exports = { tenantMiddleware, requireCompanyMatch };
