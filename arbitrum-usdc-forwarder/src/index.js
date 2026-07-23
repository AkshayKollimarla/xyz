'use strict';

const http = require('http');
const { ethers } = require('ethers');
const config = require('./config');
const logger = require('./logger');
const { DepositMonitor } = require('./monitor');
const { Forwarder } = require('./transfer');
const { notifyAll } = require('./utils/notifications');

let isForwarding = false;
let lastDepositAt = null;
let lastForwardAt = null;
let lastError = null;
let monitor = null;
let healthServer = null;

/**
 * Creates the read-only JSON-RPC provider used for all polling/reads, and
 * validates it's actually talking to the expected chain (Arbitrum One by
 * default) to fail fast on a misconfigured RPC_URL.
 */
async function createProvider() {
  const provider = new ethers.JsonRpcProvider(config.network.rpcUrl, undefined, {
    staticNetwork: true,
  });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.network.chainId) {
    throw new Error(
      `RPC_URL points at chain ${network.chainId}, but CHAIN_ID is configured as `
      + `${config.network.chainId}. Refusing to start to avoid sending funds on the wrong network.`,
    );
  }
  return provider;
}

/**
 * Creates the optional WebSocket provider used purely as a low-latency
 * "wake up and poll now" trigger. Wrapped with reconnect logic since WS
 * connections can drop; failure here is non-fatal because polling remains
 * the source of truth for correctness.
 */
function createWsProvider() {
  if (!config.network.rpcWsUrl) return null;

  let provider;
  const connect = () => {
    provider = new ethers.WebSocketProvider(config.network.rpcWsUrl);
    provider.websocket.onclose = () => {
      logger.warn('WebSocket RPC connection closed, reconnecting in 5s...');
      setTimeout(connect, 5000);
    };
    provider.websocket.onerror = (err) => {
      logger.warn(`WebSocket RPC error: ${err.message || err}`);
    };
    return provider;
  };

  return connect();
}

/**
 * Handles a confirmed deposit event by forwarding the wallet's entire
 * current USDC balance to the destination address. Uses a simple mutex
 * (`isForwarding`) so concurrent deposit events never trigger overlapping
 * forward transactions / nonce collisions.
 */
async function handleDeposit(forwarder, depositInfo) {
  lastDepositAt = new Date().toISOString();

  if (isForwarding) {
    logger.info('Forward already in progress, this deposit will be covered by that run.', {
      txHash: depositInfo.txHash,
    });
    return;
  }
  isForwarding = true;

  try {
    const balance = await forwarder.getUsdcBalance();
    if (balance <= 0n) {
      logger.info('Balance is zero at forward time (already forwarded or reorg'
        + ' invalidated deposit), nothing to do.');
      return;
    }

    const receipt = await forwarder.forward(balance);
    lastForwardAt = new Date().toISOString();
    lastError = null;

    const humanAmount = ethers.formatUnits(balance, 6); // USDC = 6 decimals
    await notifyAll(
      `✅ Forwarded ${humanAmount} USDC to ${config.wallet.destinationAddress}\n`
      + `Deposit tx: ${depositInfo.txHash}\n`
      + `Forward tx: ${receipt.hash}`,
    );
  } catch (err) {
    lastError = err.message;
    logger.error(`Failed to forward deposit: ${err.message}`, { stack: err.stack, depositTx: depositInfo.txHash });
    await notifyAll(
      `⚠️ Failed to forward USDC deposit after retries.\n`
      + `Deposit tx: ${depositInfo.txHash}\n`
      + `Error: ${err.message}`,
    );
  } finally {
    isForwarding = false;
  }
}

/** Minimal health check HTTP server for load balancers / uptime monitors. */
function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        isForwarding,
        lastDepositAt,
        lastForwardAt,
        lastError,
        destination: config.wallet.destinationAddress,
        uptimeSeconds: process.uptime(),
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(config.health.port, () => {
    logger.info(`Health check server listening on port ${config.health.port}`);
  });
  return server;
}

async function main() {
  logger.info('Starting Arbitrum USDC Forwarder...');

  const provider = await createProvider();
  const wsProvider = createWsProvider();
  const wallet = new ethers.Wallet(config.wallet.privateKey, provider);

  logger.info(`Monitoring wallet: ${wallet.address}`);
  logger.info(`Forwarding destination: ${config.wallet.destinationAddress}`);
  logger.info(`Confirmations required: ${config.monitor.confirmations}`);
  logger.info(`Poll interval: ${config.monitor.pollIntervalMs}ms`);

  const forwarder = new Forwarder({ wallet, provider });

  // Surface a startup warning immediately if there's no gas float, rather
  // than waiting for the first deposit to discover it.
  await forwarder.checkEthReserve();

  monitor = new DepositMonitor({ provider, wsProvider, walletAddress: wallet.address });
  monitor.on('deposit', (info) => {
    handleDeposit(forwarder, info).catch((err) => {
      logger.error(`Unhandled error in deposit handler: ${err.message}`, { stack: err.stack });
    });
  });

  await monitor.start();
  healthServer = startHealthServer();

  logger.info('Bot is live and monitoring for USDC deposits.');
}

/** Graceful shutdown: stop accepting new work, let in-flight work finish. */
async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  if (monitor) monitor.stop();
  if (healthServer) healthServer.close();

  // Give any in-flight forward transaction a brief window to finish rather
  // than killing the process mid-send.
  const start = Date.now();
  while (isForwarding && Date.now() - start < 30000) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  logger.info('Shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
  // Don't exit automatically — PM2/systemd/Docker will restart us if we do
  // exit, but an uncaught exception in a notification call, for example,
  // shouldn't take down the whole monitor.
});

main().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
