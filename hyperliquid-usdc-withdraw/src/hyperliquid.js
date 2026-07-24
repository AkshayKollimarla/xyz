const { ethers } = require('ethers');
const hl = require('@nktkas/hyperliquid');

function getWallet() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk || pk.includes('yourmasteraccountprivatekeyhere')) {
    throw new Error('PRIVATE_KEY is not set in .env');
  }
  return new ethers.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`);
}

function getClients() {
  const wallet = getWallet();
  const transport = new hl.HttpTransport();
  const info = new hl.InfoClient({ transport });
  const exchange = new hl.ExchangeClient({ transport, wallet });
  return { wallet, info, exchange };
}

async function getStatus() {
  const { wallet, info } = getClients();
  const [perp, spot] = await Promise.all([
    info.clearinghouseState({ user: wallet.address }),
    info.spotClearinghouseState({ user: wallet.address }),
  ]);
  const spotUsdc = spot.balances.find((b) => b.coin === 'USDC');

  return {
    address: wallet.address,
    perpWithdrawable: perp.withdrawable,
    spotUsdc: spotUsdc ? spotUsdc.total : '0',
    defaultDestination: process.env.DESTINATION_ADDRESS || null,
  };
}

// Hyperliquid withdrawals pull from the Perps USDC balance. If USDC is
// sitting in the Spot balance instead, it needs to be moved to Perps first.
async function consolidateToPerp() {
  const { exchange, info, wallet } = getClients();
  const spot = await info.spotClearinghouseState({ user: wallet.address });
  const spotUsdc = spot.balances.find((b) => b.coin === 'USDC');
  const amount = spotUsdc ? spotUsdc.total : '0';

  if (Number(amount) <= 0) {
    return { moved: '0' };
  }

  await exchange.usdClassTransfer({ amount, toPerp: true });
  return { moved: amount };
}

async function withdraw({ destination, amount }) {
  const { exchange, info, wallet } = getClients();

  const dest = destination || process.env.DESTINATION_ADDRESS;
  if (!dest) {
    throw new Error('No destination address provided or configured in .env');
  }

  let amt = amount;
  if (!amt) {
    const perp = await info.clearinghouseState({ user: wallet.address });
    amt = perp.withdrawable;
  }
  if (Number(amt) <= 0) {
    throw new Error('Nothing to withdraw (withdrawable balance is 0)');
  }

  const result = await exchange.withdraw3({ destination: dest, amount: amt });
  return { destination: dest, amount: amt, result };
}

module.exports = { getStatus, consolidateToPerp, withdraw };
