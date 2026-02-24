async function claudeWithRetry(fn, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable = err.status === 529 || err.status === 529 ||
        err.status === 503 || err.status === 502 ||
        (err.error?.error?.type === 'overloaded_error');
      if (!isRetryable) throw err;
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.log(`[claude] Overloaded, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

module.exports = { claudeWithRetry };
