'use strict';

const { retry } = require('../src/utils/retry');

describe('retry', () => {
  it('returns the result on first success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await retry(fn, { retries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('ok');

    const result = await retry(fn, { retries: 5, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all retries', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));
    await expect(retry(fn, { retries: 3, baseDelayMs: 1 })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops immediately when shouldRetry returns false', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fatal: insufficient funds'));
    const shouldRetry = jest.fn().mockReturnValue(false);

    await expect(
      retry(fn, { retries: 5, baseDelayMs: 1, shouldRetry }),
    ).rejects.toThrow('fatal: insufficient funds');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry with attempt number and delay before each retry', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockResolvedValueOnce('ok');
    const onRetry = jest.fn();

    await retry(fn, { retries: 3, baseDelayMs: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, 10);
  });

  it('applies exponential backoff between attempts', async () => {
    const delays = [];
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValueOnce('ok');

    await retry(fn, {
      retries: 5,
      baseDelayMs: 100,
      onRetry: (_err, _attempt, delayMs) => delays.push(delayMs),
    });

    expect(delays).toEqual([100, 200]);
  });
});
