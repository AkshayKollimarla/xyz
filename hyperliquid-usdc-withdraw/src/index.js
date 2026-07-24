require('dotenv').config();
const path = require('path');
const express = require('express');
const { getStatus, withdraw } = require('./hyperliquid');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/status', async (req, res) => {
  try {
    res.json(await getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { destination, amount } = req.body || {};
    res.json(await withdraw({ destination, amount }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
// Bind to localhost only — this handles a private key and must never be
// reachable from the network.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Hyperliquid USDC withdraw UI: http://127.0.0.1:${PORT} (localhost only)`);
});
