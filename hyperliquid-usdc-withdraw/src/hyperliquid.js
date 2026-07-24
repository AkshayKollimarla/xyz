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

// HIP-3 dexes (e.g. "xyz" in the Hyperliquid frontend's "Perps (xyz)" row)
// are separate balance buckets from the main Perps dex. List any dex names
// your account uses in EXTRA_PERP_DEXES (comma-separated) to see them here.
function getExtraDexNames() {
  return (process.env.EXTRA_PERP_DEXES || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

async function getStatus() {
  const { wallet, info } = getClients();
  const extraDexNames = getExtraDexNames();

  const [perp, spot, ...extraPerps] = await Promise.all([
    info.clearinghouseState({ user: wallet.address }),
    info.spotClearinghouseState({ user: wallet.address }),
    // A typo'd or non-existent dex name shouldn't break the whole status
    // call — surface it as an error string for that dex instead.
    ...extraDexNames.map((dex) =>
      info.clearinghouseState({ user: wallet.address, dex }).catch((err) => ({ error: err.message }))
    ),
  ]);
  const spotUsdc = spot.balances.find((b) => b.coin === 'USDC');

  return {
    address: wallet.address,
    perpWithdrawable: perp.withdrawable,
    spotUsdc: spotUsdc ? spotUsdc.total : '0',
    extraPerpDexes: extraDexNames.map((name, i) => ({
      name,
      withdrawable: extraPerps[i].error ? null : extraPerps[i].withdrawable,
      error: extraPerps[i].error || null,
    })),
    defaultDestination: process.env.DESTINATION_ADDRESS || null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The USDC token identifier needed for sendAsset (dex-to-dex transfers) is
// not a fixed constant — resolve it live rather than hardcoding it, since
// even Hyperliquid's own SDK doc examples show a stale value.
async function getUsdcSpotToken(info) {
  const meta = await info.spotMeta();
  const usdc = meta.tokens.find((t) => t.name === 'USDC');
  if (!usdc) {
    throw new Error('Could not resolve USDC token id from spotMeta');
  }
  return `USDC:${usdc.tokenId}`;
}

// Hyperliquid withdrawals only ever pull from the main Perps USDC balance —
// not Spot, and not any HIP-3 dex (EXTRA_PERP_DEXES) balance. So a "withdraw
// everything" needs to sweep both of those into main Perps first.
async function sweepToMainPerp(exchange, info, wallet) {
  const moved = { spot: '0', dexes: {} };

  const spot = await info.spotClearinghouseState({ user: wallet.address });
  const spotUsdc = spot.balances.find((b) => b.coin === 'USDC');
  const spotAmount = spotUsdc ? spotUsdc.total : '0';
  if (Number(spotAmount) > 0) {
    await exchange.usdClassTransfer({ amount: spotAmount, toPerp: true });
    moved.spot = spotAmount;
  }

  const extraDexNames = getExtraDexNames();
  if (extraDexNames.length > 0) {
    const usdcToken = await getUsdcSpotToken(info);
    for (const dex of extraDexNames) {
      const state = await info.clearinghouseState({ user: wallet.address, dex });
      const dexAmount = state.withdrawable;
      if (Number(dexAmount) > 0) {
        await exchange.sendAsset({
          destination: wallet.address,
          sourceDex: dex,
          destinationDex: '',
          token: usdcToken,
          amount: dexAmount,
        });
        moved.dexes[dex] = dexAmount;
      }
    }
  }

  if (Number(moved.spot) > 0 || Object.keys(moved.dexes).length > 0) {
    await sleep(1500); // give transfers a moment to settle before reading the new Perps balance
  }

  return moved;
}

async function withdraw({ destination, amount }) {
  const { exchange, info, wallet } = getClients();

  const dest = destination || process.env.DESTINATION_ADDRESS;
  if (!dest) {
    throw new Error('No destination address provided or configured in .env');
  }

  const moved = await sweepToMainPerp(exchange, info, wallet);

  let amt = amount;
  if (!amt) {
    const perp = await info.clearinghouseState({ user: wallet.address });
    amt = perp.withdrawable;
  }
  if (Number(amt) <= 0) {
    throw new Error('Nothing to withdraw (withdrawable balance is 0)');
  }

  const result = await exchange.withdraw3({ destination: dest, amount: amt });
  return {
    destination: dest,
    amount: amt,
    movedFromSpot: moved.spot,
    movedFromDexes: moved.dexes,
    result,
  };
}

module.exports = { getStatus, withdraw };
