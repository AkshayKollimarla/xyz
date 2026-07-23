'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const logger = require('../logger');
const erc20Abi = require('../utils/erc20Abi');
const { retry } = require('../utils/retry');
const { assertValidAddress, isPositiveAmount } = require('../utils/validators');

// Errors that are worth retrying (transient network / mempool conditions).
// Anything else (e.g. insufficient funds, invalid signature) is fatal and
// should surface immediately rather than burn retries.
const RETRYABLE_ERROR_PATTERNS = [
  /timeout/i,
  /network/i,
  /nonce.*(too low|already used)/i,
  /replacement.*underpriced/i,
  /could not detect network/i,
  /connection/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
];

function isRetryableError(err) {
  const msg = `${err.message || err}`;
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(msg));
}

/**
 * Forwarder is responsible for the actual on-chain USDC transfer: it signs
 * locally with the wallet's private key (no MetaMask popup — this runs
 * headless), estimates gas with a safety buffer, and retries transient
 * failures with fresh gas/nonce data on each attempt.
 */
class Forwarder {
  constructor({ wallet, provider }) {
    this.wallet = wallet;
    this.provider = provider;
    this.destination = assertValidAddress(config.wallet.destinationAddress, 'DESTINATION_ADDRESS');
    this.contract = new ethers.Contract(config.token.usdcAddress, erc20Abi, wallet);
    this._decimals = null;
    this._symbol = null;
  }

  async _loadTokenMeta() {
    if (this._decimals === null) {
      [this._decimals, this._symbol] = await Promise.all([
        this.contract.decimals(),
        this.contract.symbol().catch(() => 'USDC'),
      ]);
    }
  }

  /** Returns the wallet's current USDC balance as a bigint (raw units). */
  async getUsdcBalance() {
    return this.contract.balanceOf(this.wallet.address);
  }

  /**
   * Logs a warning (and lets the caller notify) if the wallet's ETH balance
   * is below the configured reserve. USDC transfers are ERC-20 calls, which
   * consume ETH for gas even though the *asset* being moved is USDC — the
   * wallet must keep a small ETH float or every forward will fail.
   */
  async checkEthReserve() {
    const ethBalance = await this.provider.getBalance(this.wallet.address);
    const ethBalanceFormatted = ethers.formatEther(ethBalance);
    const minReserve = ethers.parseEther(String(config.gas.minEthReserve));
    if (ethBalance < minReserve) {
      logger.warn(
        `Wallet ETH balance (${ethBalanceFormatted} ETH) is below MIN_ETH_RESERVE `
        + `(${config.gas.minEthReserve} ETH). Forwarding may fail due to insufficient gas funds.`,
      );
      return { sufficient: false, ethBalanceFormatted };
    }
    return { sufficient: true, ethBalanceFormatted };
  }

  /**
   * Forwards `amountRaw` (bigint, token base units) to the configured
   * destination address, retrying transient failures with fresh gas
   * pricing and nonce on each attempt.
   */
  async forward(amountRaw) {
    if (!isPositiveAmount(amountRaw)) {
      throw new Error(`Refusing to forward non-positive amount: ${amountRaw}`);
    }
    await this._loadTokenMeta();
    await this.checkEthReserve();

    const humanAmount = ethers.formatUnits(amountRaw, this._decimals);
    logger.info(`Preparing to forward ${humanAmount} ${this._symbol} to ${this.destination}`);

    const receipt = await retry(
      async (attempt) => this._sendOnce(amountRaw, attempt),
      {
        retries: config.retry.maxRetries,
        baseDelayMs: config.retry.baseDelayMs,
        shouldRetry: isRetryableError,
        onRetry: (err, attempt, delayMs) => {
          logger.warn(
            `Transfer attempt ${attempt} failed (${err.message}). `
            + `Retrying in ${delayMs}ms...`,
          );
        },
      },
    );

    logger.info('Forward transaction confirmed', {
      txHash: receipt.hash,
      amount: humanAmount,
      symbol: this._symbol,
      destination: this.destination,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed?.toString(),
    });

    return receipt;
  }

  async _sendOnce(amountRaw, attempt) {
    // Fresh gas estimate + fee data on every attempt, since a previous
    // attempt's parameters may now be stale/underpriced.
    const estimatedGas = await this.contract.transfer.estimateGas(this.destination, amountRaw);
    const gasLimit = (estimatedGas * BigInt(100 + config.gas.limitBufferPercent)) / 100n;

    const feeData = await this.provider.getFeeData();
    const txOverrides = { gasLimit };

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      // EIP-1559 pricing (Arbitrum supports this). Bump slightly on
      // retries to avoid "replacement underpriced" if a prior attempt's
      // tx is still floating around.
      const bump = BigInt(100 + (attempt - 1) * 15);
      txOverrides.maxFeePerGas = (feeData.maxFeePerGas * bump) / 100n;
      txOverrides.maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * bump) / 100n;
    } else if (feeData.gasPrice) {
      const bump = BigInt(100 + (attempt - 1) * 15);
      txOverrides.gasPrice = (feeData.gasPrice * bump) / 100n;
    }

    logger.info(`Sending transfer transaction (attempt ${attempt})`, {
      to: this.destination,
      gasLimit: gasLimit.toString(),
    });

    const tx = await this.contract.transfer(this.destination, amountRaw, txOverrides);
    logger.info('Transfer transaction submitted', { txHash: tx.hash, attempt });

    const receipt = await tx.wait(config.monitor.confirmations);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Transaction ${tx.hash} reverted or returned no receipt`);
    }
    return receipt;
  }
}

module.exports = { Forwarder, isRetryableError };
