const { errorResponse } = require('./auth');

function tenantMiddleware(req, res, next) {
  if (!req.user) {
    return errorResponse(res, 401, 'Authentication required', 'UNAUTHORIZED');
  }
  req.tenantId = req.user.companyId;
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
