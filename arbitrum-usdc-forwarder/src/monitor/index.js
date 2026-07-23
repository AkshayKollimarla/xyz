'use strict';

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const config = require('../config');
const logger = require('../logger');
const erc20Abi = require('../utils/erc20Abi');
const { JsonStore } = require('../utils/jsonStore');

// Cap how many historical logs we ever try to fetch in one call/on first
// boot, so a long downtime doesn't trigger one giant, rate-limit-busting
// getLogs request. We chunk instead.
const MAX_BLOCK_RANGE_PER_QUERY = 2000;

/**
 * DepositMonitor watches the USDC contract for Transfer events *to* the
 * wallet address and emits a `deposit` event once each transfer has
 * accumulated the configured number of confirmations.
 *
 * Design notes (why polling, not just WS event listeners):
 *  - WebSocket subscriptions can silently drop on reconnects/provider
 *    hiccups, which would mean missed deposits. Polling `getLogs` over a
 *    known block range is idempotent and self-healing: if a poll is missed,
 *    the next one just covers a wider range.
 *  - The optional WS provider is used ONLY to trigger an out-of-cycle poll
 *    immediately when a Transfer is seen, cutting latency without giving up
 *    the correctness guarantees of the polling approach.
 *  - `CONFIRMATIONS` protects against forwarding funds from a deposit that
 *    later gets reorg'd out.
 */
class DepositMonitor extends EventEmitter {
  constructor({ provider, wsProvider, walletAddress }) {
    super();
    this.provider = provider;
    this.wsProvider = wsProvider || null;
    this.walletAddress = walletAddress;
    this.contract = new ethers.Contract(config.token.usdcAddress, erc20Abi, provider);
    this.wsContract = wsProvider
      ? new ethers.Contract(config.token.usdcAddress, erc20Abi, wsProvider)
      : null;

    this.stateStore = new JsonStore(config.persistence.stateFile, { lastScannedBlock: null });
    this.processedStore = new JsonStore(config.persistence.processedTxFile, { processed: [] });
    this.processedSet = new Set(this.processedStore.get().processed);

    this._pollTimer = null;
    this._polling = false;
    this._pollNowRequested = false;
    this._stopped = false;
  }

  /** Starts polling and (optionally) the WS fast-wake listener. */
  async start() {
    const currentBlock = await this.provider.getBlockNumber();
    const persisted = this.stateStore.get().lastScannedBlock;

    if (persisted !== null && persisted !== undefined) {
      this.lastScannedBlock = persisted;
      logger.info(`Resuming monitor from persisted block ${this.lastScannedBlock}`);
    } else if (config.monitor.startBlock !== null) {
      this.lastScannedBlock = config.monitor.startBlock - 1;
      logger.info(`Starting monitor from configured START_BLOCK ${config.monitor.startBlock}`);
    } else {
      this.lastScannedBlock = currentBlock;
      logger.info(`No persisted state — starting monitor from current block ${currentBlock}`);
    }

    this._setupWsFastWake();

    // Kick off the first poll immediately, then on the configured interval.
    await this._poll();
    this._pollTimer = setInterval(() => {
      this._poll().catch((err) => logger.error(`Poll cycle failed: ${err.message}`, { stack: err.stack }));
    }, config.monitor.pollIntervalMs);
  }

  /** Stops all timers and listeners. Safe to call multiple times. */
  stop() {
    this._stopped = true;
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this.wsContract) {
      try {
        this.wsContract.removeAllListeners();
      } catch (err) {
        logger.warn(`Error removing WS listeners: ${err.message}`);
      }
    }
  }

  _setupWsFastWake() {
    if (!this.wsContract) return;
    try {
      const filter = this.wsContract.filters.Transfer(null, this.walletAddress);
      this.wsContract.on(filter, () => {
        logger.debug('WS fast-wake: Transfer event seen, triggering immediate poll');
        this._pollNowRequested = true;
        this._poll().catch((err) => logger.error(`WS-triggered poll failed: ${err.message}`));
      });
      logger.info('WebSocket fast-wake listener attached for USDC Transfer events');
    } catch (err) {
      logger.warn(`Failed to attach WS listener, continuing with polling only: ${err.message}`);
    }
  }

  /**
   * Scans from lastScannedBlock+1 up to (latestBlock - confirmations),
   * in chunks, emitting a `deposit` event for each new, unprocessed,
   * sufficiently-confirmed incoming Transfer.
   */
  async _poll() {
    if (this._stopped) return;
    if (this._polling) return; // avoid overlapping poll cycles
    this._polling = true;
    this._pollNowRequested = false;

    try {
      const latestBlock = await this.provider.getBlockNumber();
      const safeTarget = latestBlock - config.monitor.confirmations;

      if (safeTarget <= this.lastScannedBlock) {
        return; // nothing new and confirmed yet
      }

      let fromBlock = this.lastScannedBlock + 1;
      const filter = this.contract.filters.Transfer(null, this.walletAddress);

      while (fromBlock <= safeTarget) {
        const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE_PER_QUERY - 1, safeTarget);
        // eslint-disable-next-line no-await-in-loop
        const logs = await this.contract.queryFilter(filter, fromBlock, toBlock);

        for (const log of logs) {
          this._handleLog(log);
        }

        fromBlock = toBlock + 1;
        this.lastScannedBlock = toBlock;
        this.stateStore.set({ lastScannedBlock: this.lastScannedBlock });
      }
    } catch (err) {
      logger.error(`Error while polling for deposits: ${err.message}`, { stack: err.stack });
    } finally {
      this._polling = false;
      if (this._pollNowRequested) {
        // A fast-wake came in while we were already polling; run once more.
        setImmediate(() => this._poll().catch((e) => logger.error(e.message)));
      }
    }
  }

  _handleLog(log) {
    const txHash = log.transactionHash;
    const logKey = `${txHash}:${log.index}`;
    if (this.processedSet.has(logKey)) return;

    this.processedSet.add(logKey);
    this.processedStore.set({ processed: Array.from(this.processedSet) });

    const { from, to, value } = log.args;
    logger.info('Deposit detected', {
      txHash,
      from,
      to,
      amountRaw: value.toString(),
      blockNumber: log.blockNumber,
    });

    this.emit('deposit', {
      txHash,
      from,
      to,
      valueRaw: value,
      blockNumber: log.blockNumber,
    });
  }
}

module.exports = { DepositMonitor };
