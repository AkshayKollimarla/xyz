'use strict';

const fs = require('fs');
const path = require('path');
const winston = require('winston');
const config = require('../config');

fs.mkdirSync(config.logging.dir, { recursive: true });

/**
 * Redacts anything that looks like a private key or long hex secret from
 * log output, as a defense-in-depth measure in case a raw error object
 * (e.g. from ethers) ever contains signing material.
 */
function redactSecrets(message) {
  if (typeof message !== 'string') return message;
  return message
    .replace(/0x[0-9a-fA-F]{64}/g, '0x[REDACTED_PRIVATE_KEY]')
    .replace(new RegExp(config.wallet.privateKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[REDACTED]');
}

const redactFormat = winston.format((info) => {
  info.message = redactSecrets(info.message);
  if (info.stack) info.stack = redactSecrets(info.stack);
  return info;
});

const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
    }),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(config.logging.dir, 'combined.log'),
    }),
    new winston.transports.File({
      filename: path.join(config.logging.dir, 'error.log'),
      level: 'error',
    }),
  ],
});

module.exports = logger;
