function errorJson(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

module.exports = { errorJson };
