require('dotenv').config();
const path = require('path');
const express = require('express');
const {
  getStatus,
  withdraw,
  previewCloseAll,
  previewCloseAllAccounts,
  closeAllPositions,
  closeAllAndWithdrawAll,
  checkWithdrawalArrival,
  getAccounts,
} = require('./hyperliquid');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function findAccount(accountId) {
  const accounts = getAccounts();
  const account = accountId ? accounts.find((a) => a.id === accountId) : accounts[0];
  if (!account) {
    throw new Error(`Unknown account: ${accountId}`);
  }
  return account;
}

app.get('/api/status', async (req, res) => {
  try {
    res.json(await getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { destination, amount, account } = req.body || {};
    const wallet = findAccount(account).wallet;
    res.json(await withdraw({ wallet, destination, amount }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/positions', async (req, res) => {
  try {
    const dex = req.query.dex || '';
    const wallet = findAccount(req.query.account).wallet;
    res.json(await previewCloseAll(wallet, dex));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Positions across every configured account and every EXTRA_PERP_DEXES dex.
app.get('/api/positions-all', async (req, res) => {
  try {
    res.json(await previewCloseAllAccounts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/close-positions', async (req, res) => {
  try {
    const { dex, account } = req.body || {};
    const wallet = findAccount(account).wallet;
    res.json(await closeAllPositions(wallet, { dex: dex || '' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Closes every open position on every configured account, then withdraws
// each account's entire resulting balance to the same destination address.
app.post('/api/close-all-and-withdraw', async (req, res) => {
  try {
    const { destination } = req.body || {};
    res.json(await closeAllAndWithdrawAll({ destination }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Independent, on-chain check of whether a withdrawal has actually arrived
// on Arbitrum yet — polled by the frontend after a withdrawal is accepted.
app.get('/api/withdraw-arrival', async (req, res) => {
  try {
    const { destination, fromBlock } = req.query;
    if (!destination || !fromBlock) {
      throw new Error('destination and fromBlock are required');
    }
    res.json(await checkWithdrawalArrival({ destination, sinceBlock: Number(fromBlock) }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
// Bind to localhost only — this handles private keys and must never be
// reachable from the network.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Hyperliquid USDC withdraw UI: http://127.0.0.1:${PORT} (localhost only)`);
});
