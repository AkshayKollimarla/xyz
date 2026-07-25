require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
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

const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!APP_PASSWORD || APP_PASSWORD.length < 8) {
  throw new Error(
    'APP_PASSWORD must be set in .env to a strong password (8+ chars) before starting. ' +
    'This gates every action in the app — required once this is reachable from outside your own machine.'
  );
}
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error(
    'SESSION_SECRET must be set in .env to a long random value before starting. ' +
    "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
// Defaults to HTTPS-only cookies in production (correct behind a TLS
// reverse proxy). Set COOKIE_SECURE=false to explicitly allow the app to
// work over plain HTTP instead — only do this if you understand that the
// password and session cookie then travel in plaintext over the network.
const COOKIE_SECURE = process.env.COOKIE_SECURE !== undefined
  ? process.env.COOKIE_SECURE === 'true'
  : IS_PRODUCTION;

const app = express();
// Required so express-session/rate-limit see the real client IP and scheme
// when running behind Caddy/nginx, not the proxy's own loopback address.
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json());

app.use(session({
  name: 'hlw.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    // Secure cookies require HTTPS. See COOKIE_SECURE above.
    secure: COOKIE_SECURE,
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000, // 12h
  },
}));

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Comparing different-length buffers directly would leak length via
  // timing; pad to a fixed size before the constant-time comparison.
  const len = Math.max(bufA.length, bufB.length, 32);
  const paddedA = Buffer.alloc(len);
  const paddedB = Buffer.alloc(len);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  return bufA.length === bufB.length && crypto.timingSafeEqual(paddedA, paddedB);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (typeof password === 'string' && timingSafeEqualStrings(password, APP_PASSWORD)) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Incorrect password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: Boolean(req.session && req.session.authenticated) });
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

// The static shell (HTML/CSS/JS) itself has no secrets in it — only the API
// routes below, which every one of, are gated by requireAuth.
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', requireAuth);

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
// Defaults to loopback only — a reverse proxy is meant to be the thing
// actually facing the network. Set BIND_HOST=0.0.0.0 to make this process
// itself directly reachable from the network instead (e.g. IP:port access
// with no reverse proxy in front) — only do this deliberately.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
app.listen(PORT, BIND_HOST, () => {
  console.log(`Hyperliquid USDC withdraw UI listening on ${BIND_HOST}:${PORT}`);
});
