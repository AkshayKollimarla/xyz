const { ethers } = require('ethers');
const hl = require('@nktkas/hyperliquid');
const { SymbolConverter } = require('@nktkas/hyperliquid/utils');

// Supports up to two accounts: PRIVATE_KEY (required) and an optional
// PRIVATE_KEY_2. Every function below is parametrized by wallet so it works
// the same for either account; the "AllAccounts" wrappers loop over
// whichever accounts are actually configured.
function getAccounts() {
  const candidates = [
    { id: 'account1', pk: process.env.PRIVATE_KEY },
    { id: 'account2', pk: process.env.PRIVATE_KEY_2 },
  ].filter((a) => a.pk && !a.pk.includes('yourmasteraccountprivatekeyhere'));

  if (candidates.length === 0) {
    throw new Error('No PRIVATE_KEY configured in .env');
  }

  return candidates.map(({ id, pk }) => ({
    id,
    wallet: new ethers.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`),
  }));
}

function getClients(wallet) {
  const transport = new hl.HttpTransport();
  const info = new hl.InfoClient({ transport });
  const exchange = new hl.ExchangeClient({ transport, wallet });
  return { info, exchange, transport };
}

// Native, Circle-issued USDC on Arbitrum One. Confirmed live against the
// real contract (unlike Hyperliquid's internal per-token identifiers, this
// is a stable public contract address, safe to hardcode).
const ARBITRUM_USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ERC20_TRANSFER_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];

function getArbitrumProvider() {
  return new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc');
}

// Checks whether a withdrawal has actually landed on Arbitrum yet, by
// looking for an incoming USDC Transfer to `destination` on or after
// `sinceBlock`. This is independent verification (reads Arbitrum directly)
// rather than trusting that Hyperliquid accepting the withdraw3 action means
// funds have arrived — the bridge step takes a few minutes and can be
// checked for separately.
async function checkWithdrawalArrival({ destination, sinceBlock }) {
  const provider = getArbitrumProvider();
  const contract = new ethers.Contract(ARBITRUM_USDC_ADDRESS, ERC20_TRANSFER_ABI, provider);
  const events = await contract.queryFilter(contract.filters.Transfer(null, destination), sinceBlock, 'latest');

  if (events.length === 0) {
    return { found: false };
  }

  const last = events[events.length - 1];
  return {
    found: true,
    txHash: last.transactionHash,
    blockNumber: last.blockNumber,
    amount: ethers.formatUnits(last.args.value, 6),
  };
}

// HIP-3 dexes (e.g. "xyz" in the Hyperliquid frontend's "Perps (xyz)" row)
// are separate balance buckets from the main Perps dex. List any dex names
// your accounts use in EXTRA_PERP_DEXES (comma-separated) — applied to every
// configured account; a dex an account doesn't use just shows as empty.
function getExtraDexNames() {
  return (process.env.EXTRA_PERP_DEXES || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

// Every dex a position check should cover: the main Perps dex ("") plus
// any configured HIP-3 dexes.
function getAllPositionDexNames() {
  return ['', ...getExtraDexNames()];
}

async function getAccountStatus(wallet) {
  const { info } = getClients(wallet);
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
  };
}

async function getStatus() {
  const accounts = getAccounts();
  const statuses = await Promise.all(accounts.map((a) => getAccountStatus(a.wallet)));

  return {
    accounts: accounts.map((a, i) => ({ id: a.id, ...statuses[i] })),
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
async function sweepToMainPerp(wallet, exchange, info) {
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

async function withdraw({ wallet, destination, amount }) {
  const { exchange, info } = getClients(wallet);

  const dest = destination || process.env.DESTINATION_ADDRESS;
  if (!dest) {
    throw new Error('No destination address provided or configured in .env');
  }

  const moved = await sweepToMainPerp(wallet, exchange, info);

  let amt = amount;
  if (!amt) {
    const perp = await info.clearinghouseState({ user: wallet.address });
    amt = perp.withdrawable;
  }
  if (Number(amt) <= 0) {
    throw new Error('Nothing to withdraw (withdrawable balance is 0)');
  }

  // Captured *before* submitting, so the arrival check below never misses a
  // fast-landing transfer.
  const arbitrumFromBlock = await getArbitrumProvider().getBlockNumber();

  const result = await exchange.withdraw3({ destination: dest, amount: amt });
  return {
    destination: dest,
    amount: amt,
    arbitrumFromBlock,
    movedFromSpot: moved.spot,
    movedFromDexes: moved.dexes,
    result,
  };
}

// Withdraws every configured account's entire balance to the same
// destination address, one account at a time.
async function withdrawAllAccounts({ destination } = {}) {
  const accounts = getAccounts();
  const results = [];
  for (const acc of accounts) {
    const r = await withdraw({ wallet: acc.wallet, destination });
    results.push({ accountId: acc.id, address: acc.wallet.address, ...r });
  }
  return results;
}

// Hyperliquid perp price rule: at most 5 significant figures, and at most
// (6 - szDecimals) decimal places for perps. Integer prices are always valid.
function roundPrice(price, szDecimals) {
  if (Number.isInteger(price)) {
    return String(price);
  }
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const fiveSigFigs = Number(price.toPrecision(5));
  return String(Number(fiveSigFigs.toFixed(maxDecimals)));
}

async function getPositions(wallet, dex) {
  const { info } = getClients(wallet);
  const state = await info.clearinghouseState({ user: wallet.address, dex });

  return state.assetPositions.map(({ position: p }) => ({
    coin: p.coin,
    size: p.szi,
    side: Number(p.szi) < 0 ? 'short' : 'long',
    entryPx: p.entryPx,
    positionValue: p.positionValue,
    unrealizedPnl: p.unrealizedPnl,
    liquidationPx: p.liquidationPx,
  }));
}

async function previewCloseAll(wallet, dex) {
  const positions = await getPositions(wallet, dex);
  const totalUnrealizedPnl = positions.reduce((sum, p) => sum + Number(p.unrealizedPnl), 0);
  return { dex, positions, totalUnrealizedPnl: String(totalUnrealizedPnl) };
}

// Read-only: previews open positions for every configured account, across
// every EXTRA_PERP_DEXES dex. Only returns entries that actually have
// open positions (or errored while checking).
async function previewCloseAllAccounts() {
  const accounts = getAccounts();
  const dexNames = getAllPositionDexNames();
  const results = [];

  for (const acc of accounts) {
    for (const dex of dexNames) {
      try {
        const preview = await previewCloseAll(acc.wallet, dex);
        if (preview.positions.length > 0) {
          results.push({ accountId: acc.id, address: acc.wallet.address, ...preview });
        }
      } catch (err) {
        results.push({ accountId: acc.id, address: acc.wallet.address, dex, error: err.message });
      }
    }
  }

  return results;
}

// Submits one round of market-order closes for whatever is currently open
// on `dex`, at a given slippage buffer. Returns the orders submitted (not
// whether they actually filled — that's verified separately by re-reading
// position state, since Hyperliquid's order response isn't treated as
// sufficient proof on its own).
async function submitCloseOrders(wallet, dex, slippage) {
  const { info, exchange, transport } = getClients(wallet);

  // Main-dex assets are always loaded by SymbolConverter by default; passing
  // "" as a builder-dex name would be wrong, so only pass dexs for HIP-3.
  const converterOpts = dex ? { transport, dexs: [dex] } : { transport };

  const [state, mids, converter] = await Promise.all([
    info.clearinghouseState({ user: wallet.address, dex }),
    info.allMids({ dex }),
    SymbolConverter.create(converterOpts),
  ]);

  const orders = [];
  for (const { position: p } of state.assetPositions) {
    const szi = Number(p.szi);
    if (szi === 0) continue;

    const assetId = converter.getAssetId(p.coin);
    const szDecimals = converter.getSzDecimals(p.coin);
    if (assetId === undefined || szDecimals === undefined) {
      throw new Error(`Could not resolve asset id for ${p.coin}`);
    }

    const mid = Number(mids[p.coin]);
    if (!mid) {
      throw new Error(`No live price available for ${p.coin}`);
    }

    const isBuy = szi < 0; // short position -> buy to close; long -> sell to close
    const aggressivePrice = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);

    orders.push({
      a: assetId,
      b: isBuy,
      p: roundPrice(aggressivePrice, szDecimals),
      s: Math.abs(szi).toFixed(szDecimals),
      r: true,
      // "FrontendMarket" = same immediate-fill-or-cancel execution as "Ioc",
      // but tagged as a market order (matches what was actually requested,
      // and shows correctly as "Market" in Hyperliquid's own trade history).
      t: { limit: { tif: 'FrontendMarket' } },
    });
  }

  if (orders.length === 0) {
    return { orders: [], result: null };
  }

  const result = await exchange.order({ orders, grouping: 'na' });
  return { orders, result };
}

// Escalating slippage per retry — a thin book that won't fill at 2% might
// fill at 5% or 10%. This is a deliberate "get it closed" market order, not
// a price-sensitive limit order.
const CLOSE_SLIPPAGE_STEPS = [0.02, 0.05, 0.10];

// Closes every open position on `dex` (for one account/wallet) with
// reduce-only market orders, freeing their margin back into that dex's
// withdrawable balance. Does NOT withdraw or sweep anything itself.
//
// IOC/market orders on a thin book aren't guaranteed to fully fill in one
// shot, so this doesn't trust the order response — after each attempt it
// re-reads the actual position state from Hyperliquid and retries anything
// still open (at a more aggressive price) up to CLOSE_SLIPPAGE_STEPS.length
// times. The final result reports exactly what, if anything, is still open
// rather than assuming success.
async function closeAllPositions(wallet, { dex }) {
  const allOrders = [];
  let remaining = await getPositions(wallet, dex);

  for (let attempt = 0; attempt < CLOSE_SLIPPAGE_STEPS.length && remaining.length > 0; attempt++) {
    const { orders } = await submitCloseOrders(wallet, dex, CLOSE_SLIPPAGE_STEPS[attempt]);
    allOrders.push(...orders);

    await sleep(1500); // let the fill settle before re-checking real position state
    remaining = await getPositions(wallet, dex);
  }

  return {
    dex,
    closed: allOrders,
    fullyClosed: remaining.length === 0,
    remainingPositions: remaining,
  };
}

// Closes every open position across every configured account and every
// EXTRA_PERP_DEXES dex. Does not withdraw anything.
async function closeAllPositionsAllAccounts() {
  const accounts = getAccounts();
  const dexNames = getAllPositionDexNames();
  const results = [];

  for (const acc of accounts) {
    for (const dex of dexNames) {
      const positions = await getPositions(acc.wallet, dex);
      if (positions.length === 0) continue;
      const r = await closeAllPositions(acc.wallet, { dex });
      results.push({ accountId: acc.id, address: acc.wallet.address, ...r });
    }
  }

  return results;
}

// Combined action: closes every open position on every account/dex, then
// sweeps + withdraws each account's entire resulting balance to the same
// destination address.
async function closeAllAndWithdrawAll({ destination } = {}) {
  const closeResults = await closeAllPositionsAllAccounts();
  if (closeResults.some((r) => r.closed && r.closed.length > 0)) {
    await sleep(2000); // let fills settle before sweeping/withdrawing
  }
  const withdrawResults = await withdrawAllAccounts({ destination });

  // Withdraw only ever moves the currently-free balance, so it's always
  // safe to run regardless — but if something didn't actually close, the
  // caller needs to know clearly rather than assume everything is flat.
  const incompleteCloses = closeResults.filter((r) => r.fullyClosed === false);

  return { closeResults, withdrawResults, incompleteCloses };
}

module.exports = {
  getStatus,
  withdraw,
  withdrawAllAccounts,
  previewCloseAll,
  previewCloseAllAccounts,
  closeAllPositions,
  closeAllPositionsAllAccounts,
  closeAllAndWithdrawAll,
  checkWithdrawalArrival,
  getAccounts,
};
