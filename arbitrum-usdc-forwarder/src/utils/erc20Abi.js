'use strict';

// Minimal ERC-20 ABI — only what this bot actually needs.
// Keeping the ABI small reduces attack surface and makes intent obvious.
module.exports = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];
