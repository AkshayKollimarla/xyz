'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { isAddress, getAddress } = require('ethers');

dotenv.config();

/**
 * Reads a required environment variable or throws a clear startup error.
 * Failing fast on missing config is much safer than limping along with
 * `undefined` values that could silently break address checks or signing.
 */
function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === '') {
    throw new Error(`[CONFIG] Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim();
}

function requireAddress(name) {
  const raw = requireEnv(name);
  if (!isAddress(raw)) {
    throw new Error(`[CONFIG] ${name} ("${raw}") is not a valid Ethereum address`);
  }
  // getAddress() returns the EIP-55 checksummed form, which also protects
  // against typos that happen to be valid hex but the wrong address.
  return getAddress(raw);
}

function requirePositiveInt(name, fallback) {
  const raw = optionalEnv(name, fallback);
  const num = Number.parseInt(raw, 10);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`[CONFIG] ${name} must be a positive integer, got "${raw}"`);
  }
  return num;
}

function requireNonNegativeFloat(name, fallback) {
  const raw = optionalEnv(name, fallback);
  const num = Number.parseFloat(raw);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`[CONFIG] ${name} must be a non-negative number, got "${raw}"`);
  }
  return num;
}

const privateKey = requireEnv('PRIVATE_KEY');
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error('[CONFIG] PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
}

const destination = requireAddress('DESTINATION_ADDRESS');
const usdcAddress = requireAddress('USDC_CONTRACT_ADDRESS');

const dataDir = path.resolve(optionalEnv('DATA_DIR', './data'));
const logDir = path.resolve(optionalEnv('LOG_DIR', './logs'));

const config = Object.freeze({
  network: Object.freeze({
    rpcUrl: requireEnv('RPC_URL'),
    rpcWsUrl: optionalEnv('RPC_WS_URL', ''),
    chainId: requirePositiveInt('CHAIN_ID', '42161'),
  }),
  wallet: Object.freeze({
    privateKey,
    destinationAddress: destination,
  }),
  token: Object.freeze({
    usdcAddress,
  }),
  monitor: Object.freeze({
    pollIntervalMs: requirePositiveInt('POLL_INTERVAL_MS', '7000'),
    confirmations: requirePositiveInt('CONFIRMATIONS', '3'),
    startBlock: optionalEnv('START_BLOCK', '') === ''
      ? null
      : requirePositiveInt('START_BLOCK', '0'),
  }),
  gas: Object.freeze({
    limitBufferPercent: requirePositiveInt('GAS_LIMIT_BUFFER_PERCENT', '20'),
    minEthReserve: requireNonNegativeFloat('MIN_ETH_RESERVE', '0.001'),
  }),
  retry: Object.freeze({
    maxRetries: requirePositiveInt('TX_MAX_RETRIES', '3'),
    baseDelayMs: requirePositiveInt('TX_RETRY_BASE_DELAY_MS', '3000'),
  }),
  persistence: Object.freeze({
    dataDir,
    processedTxFile: path.join(dataDir, 'processed.json'),
    stateFile: path.join(dataDir, 'state.json'),
  }),
  health: Object.freeze({
    port: requirePositiveInt('HEALTH_CHECK_PORT', '3000'),
  }),
  logging: Object.freeze({
    level: optionalEnv('LOG_LEVEL', 'info'),
    dir: logDir,
  }),
  notifications: Object.freeze({
    telegram: Object.freeze({
      botToken: optionalEnv('TELEGRAM_BOT_TOKEN', ''),
      chatId: optionalEnv('TELEGRAM_CHAT_ID', ''),
    }),
    discordWebhookUrl: optionalEnv('DISCORD_WEBHOOK_URL', ''),
    slackWebhookUrl: optionalEnv('SLACK_WEBHOOK_URL', ''),
  }),
});

module.exports = config;
