'use strict';

const { isValidAddress, assertValidAddress, isPositiveAmount } = require('../src/utils/validators');

describe('validators', () => {
  const VALID = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // USDC on Arbitrum
  const VALID_LOWERCASE = VALID.toLowerCase();
  const INVALID_SHORT = '0x1234';
  const INVALID_CHARS = '0xZZZZ065e77c8cC2239327C5EDb3A432268e5831';

  describe('isValidAddress', () => {
    it('accepts a properly checksummed address', () => {
      expect(isValidAddress(VALID)).toBe(true);
    });

    it('accepts a lowercase address (ethers normalizes case)', () => {
      expect(isValidAddress(VALID_LOWERCASE)).toBe(true);
    });

    it('rejects a too-short address', () => {
      expect(isValidAddress(INVALID_SHORT)).toBe(false);
    });

    it('rejects an address with invalid hex characters', () => {
      expect(isValidAddress(INVALID_CHARS)).toBe(false);
    });

    it('rejects non-string input', () => {
      expect(isValidAddress(undefined)).toBe(false);
      expect(isValidAddress(null)).toBe(false);
      expect(isValidAddress(123)).toBe(false);
    });
  });

  describe('assertValidAddress', () => {
    it('returns the checksummed address for valid input', () => {
      expect(assertValidAddress(VALID_LOWERCASE)).toBe(VALID);
    });

    it('throws for an invalid address', () => {
      expect(() => assertValidAddress(INVALID_SHORT, 'testAddr')).toThrow(/Invalid testAddr/);
    });
  });

  describe('isPositiveAmount', () => {
    it('returns true for a positive bigint', () => {
      expect(isPositiveAmount(100n)).toBe(true);
    });

    it('returns false for zero', () => {
      expect(isPositiveAmount(0n)).toBe(false);
    });

    it('returns false for negative bigint', () => {
      expect(isPositiveAmount(-1n)).toBe(false);
    });

    it('returns false for non-bigint values', () => {
      expect(isPositiveAmount(100)).toBe(false);
      expect(isPositiveAmount('100')).toBe(false);
    });
  });
});
