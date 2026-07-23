'use strict';

const { isAddress, getAddress } = require('ethers');

/** Returns true if `value` is a syntactically and checksum-valid EVM address. */
function isValidAddress(value) {
  return typeof value === 'string' && isAddress(value);
}

/**
 * Throws if `value` is not a valid address; otherwise returns the
 * EIP-55 checksummed form. Use this before ANY on-chain send.
 */
function assertValidAddress(value, label = 'address') {
  if (!isValidAddress(value)) {
    throw new Error(`Invalid ${label}: "${value}"`);
  }
  return getAddress(value);
}

/** Returns true if `amount` (bigint) is strictly greater than zero. */
function isPositiveAmount(amount) {
  return typeof amount === 'bigint' && amount > 0n;
}

module.exports = { isValidAddress, assertValidAddress, isPositiveAmount };
