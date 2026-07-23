'use strict';

/**
 * Runs `fn` and retries on failure with exponential backoff.
 *
 * @param {Function} fn - async function to execute. Receives the attempt
 *   number (1-indexed) as its only argument.
 * @param {Object} opts
 * @param {number} opts.retries - max number of attempts (>=1)
 * @param {number} opts.baseDelayMs - base delay, doubled each retry
 * @param {Function} [opts.shouldRetry] - (error) => boolean. If it returns
 *   false, the error is rethrown immediately without further retries.
 * @param {Function} [opts.onRetry] - (error, attempt, delayMs) => void,
 *   called before sleeping ahead of the next attempt.
 */
async function retry(fn, {
  retries = 3,
  baseDelayMs = 1000,
  shouldRetry = () => true,
  onRetry = () => {},
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === retries;
      if (isLastAttempt || !shouldRetry(err)) {
        throw err;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      onRetry(err, attempt, delayMs);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Unreachable, but keeps linters happy.
  throw lastError;
}

module.exports = { retry };
