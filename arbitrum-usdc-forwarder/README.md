# Arbitrum USDC Forwarder

A production-grade bot that watches an Arbitrum wallet (e.g. your Hyperliquid
withdrawal wallet) for incoming USDC deposits, waits for confirmations, and
automatically forwards the **entire USDC balance** to a destination address
you configure — no MetaMask popup, no manual step.

---

## 1. Why Node.js + ethers.js v6 (and not Python/web3.py)

Both stacks can absolutely do this job. I chose Node + ethers v6 because:

- **Native async I/O fit.** This bot is fundamentally an event loop: poll →
  wait → sign → send → wait for confirmations, repeated forever. Node's
  event loop and `async/await` map onto that directly without extra
  concurrency primitives.
- **ethers v6 ergonomics.** Typed `Contract` objects, built-in BigInt
  support for token amounts (no float/Decimal foot-guns), first-class
  `Wallet` local signing, and clean `Provider`/`WebSocketProvider`
  abstractions.
- **Deployment ecosystem.** PM2 (the most common Node process manager for
  exactly this "long-running worker on an EC2 box" use case), plus a huge
  base of examples for Node + Docker + systemd.
- **web3.py is a fine alternative** if your team is Python-first — the same
  architecture (poll `eth_getLogs`, wait N confirmations, sign locally,
  retry) translates directly. I'm happy to port it if you'd prefer that
  stack.

---

## 2. Important design note: the wallet needs a small ETH balance

USDC is an ERC-20 token. Moving it requires calling `transfer()` on the USDC
contract from your wallet, and **that call is paid for in ETH gas**, not
USDC — even though USDC is the asset being moved. Hyperliquid withdrawals
send you USDC, not ETH, so **your MetaMask wallet needs a small standing ETH
balance** (a few dollars' worth is enough on Arbitrum) or every forward
transaction will fail with "insufficient funds for gas."

The bot checks this on startup and before every forward (`MIN_ETH_RESERVE`
in `.env`), logs a warning, and sends a notification if the balance is low —
but it does **not** auto-refill ETH for you. Fund the wallet with a small
ETH float once, and top it up occasionally (or send a small amount of ETH
along with each Hyperliquid withdrawal if that's easier for your workflow).

---

## 3. How it works

```
┌─────────────┐     poll every N sec      ┌──────────────────┐
│  Monitor     │ ───────────────────────► │ Arbitrum RPC      │
│ (getLogs on  │ ◄─────────────────────── │ (USDC Transfer    │
│  USDC        │   Transfer logs to you   │  events)          │
│  contract)   │                          └──────────────────┘
└──────┬───────┘
       │ deposit confirmed (N blocks)
       ▼
┌─────────────┐   read current balance    ┌──────────────────┐
│  Forwarder   │ ───────────────────────► │ USDC contract      │
│ (signs w/    │   estimate gas, send tx  │ balanceOf/transfer │
│  local key)  │ ◄─────────────────────── │                    │
└──────┬───────┘                          └──────────────────┘
       │ success/failure
       ▼
┌─────────────┐
│ Notifications│  Telegram / Discord / Slack
└─────────────┘
```

- **`src/monitor`** — polls `Transfer` logs on the USDC contract, filtered
  to your wallet as the recipient, from the last-scanned block up to
  `latest - CONFIRMATIONS`. Polling (not raw WebSocket event listening) is
  the source of truth because it's idempotent and self-healing across
  restarts/dropped connections. An optional WebSocket subscription is used
  only to trigger an *earlier* poll for lower latency — it never bypasses
  the confirmation/dedup logic.
- **`src/transfer`** — reads the live on-chain USDC balance (not just the
  deposit amount, so the whole balance is always swept), estimates gas with
  a configurable safety buffer, signs and sends locally with the private
  key, and retries transient failures with fresh gas pricing.
- **`src/config`** — loads and *validates* every setting at startup
  (addresses checksummed, numbers parsed, private key format checked) so
  bad config fails immediately instead of causing a mistaken transfer.
- **`src/logger`** — structured logs to console + rotated files, with
  defense-in-depth redaction of anything that looks like a private key.
- **`src/utils`** — retry/backoff, address validation, JSON persistence for
  dedup + last-scanned-block, notification senders.
- **`src/index.js`** — wires it together, runs a `/health` and `/status`
  HTTP endpoint, and handles graceful shutdown (`SIGINT`/`SIGTERM`).

### Duplicate-processing protection

1. Every processed `Transfer` log (keyed by `txHash:logIndex`) is recorded
   in `data/processed.json`, so restarts don't reprocess old deposits.
2. Forwarding is gated by an in-memory mutex (`isForwarding`), so if
   multiple deposits land in the same poll cycle, only one forward
   transaction fires — and because it sweeps the *current balance*, it
   still captures all of them.
3. Because each forward reads the live balance right before sending, even
   an edge case that slipped past the mutex would find a zero balance and
   no-op instead of double-spending.

---

## 4. Project structure

```
arbitrum-usdc-forwarder/
├── src/
│   ├── index.js            # entry point, health server, shutdown
│   ├── config/index.js     # env loading + validation
│   ├── logger/index.js     # winston logger with redaction
│   ├── monitor/index.js    # deposit detection (polling + WS wake)
│   ├── transfer/index.js   # signing, gas estimation, sending, retries
│   └── utils/
│       ├── erc20Abi.js
│       ├── validators.js
│       ├── retry.js
│       ├── notifications.js
│       └── jsonStore.js
├── tests/
│   ├── validators.test.js
│   └── retry.test.js
├── deploy/systemd/usdc-forwarder.service
├── .env.example
├── ecosystem.config.js     # PM2 config
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

---

## 5. Local setup

### Prerequisites
- Node.js 18+ (20 recommended)
- An Arbitrum One RPC URL (Alchemy, Infura, QuickNode, or the public
  `https://arb1.arbitrum.io/rpc`)
- Your MetaMask wallet's private key
- The destination wallet address

### Install

```bash
git clone <this repo> arbitrum-usdc-forwarder
cd arbitrum-usdc-forwarder
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env` and fill in at minimum:
- `RPC_URL`
- `PRIVATE_KEY`
- `DESTINATION_ADDRESS`

Everything else has sensible defaults (see comments in `.env.example`).

### Run

```bash
npm start
```

You should see log lines confirming the wallet address being monitored, the
destination, and "Bot is live and monitoring for USDC deposits." Check
`http://localhost:3000/health` and `/status`.

### Run tests

```bash
npm test
```

---

## 6. Running with Docker

```bash
cp .env.example .env   # fill it in first
docker compose up -d --build
docker compose logs -f
```

The `./data` and `./logs` directories are bind-mounted so dedup state and
logs survive container rebuilds/restarts.

To stop:
```bash
docker compose down
```

---

## 7. Running with PM2

```bash
npm install -g pm2
cp .env.example .env   # fill it in first
pm2 start ecosystem.config.js
pm2 save
pm2 startup            # follow the printed instructions to enable boot-start
```

Useful commands:
```bash
pm2 logs arbitrum-usdc-forwarder
pm2 restart arbitrum-usdc-forwarder
pm2 stop arbitrum-usdc-forwarder
pm2 monit
```

---

## 8. Deploying to AWS EC2

1. **Launch an instance.** A small instance (e.g. `t3.micro`/`t4g.micro`)
   is plenty — this workload is I/O bound, not compute bound.
2. **Security group:** only open the port you need for the health check
   (3000, or put it behind a load balancer/ALB) and SSH (22, restricted to
   your IP). No inbound ports are required for the bot's core function.
3. **Install Node.js 20** (via `nvm` or the NodeSource repo).
4. **Copy the project** to the instance (`scp`/`git clone`) — do **not**
   commit `.env` to git; copy it separately over `scp` or paste it directly
   on the box.
5. **Install dependencies:** `npm install --omit=dev`
6. **Run it** with either:
   - **PM2** (see section 7) — simplest, good default choice, or
   - **systemd** — copy `deploy/systemd/usdc-forwarder.service` to
     `/etc/systemd/system/`, edit the `User`/`WorkingDirectory` paths, then:
     ```bash
     sudo systemctl daemon-reload
     sudo systemctl enable usdc-forwarder
     sudo systemctl start usdc-forwarder
     sudo systemctl status usdc-forwarder
     journalctl -u usdc-forwarder -f
     ```
   - **Docker** (see section 6) — if you'd rather manage it as a container;
     install Docker + Docker Compose on the instance first.
7. **Verify:** `curl http://localhost:3000/health` from the instance, and
   check logs for "Bot is live and monitoring for USDC deposits."

### Recommended: use AWS Secrets Manager instead of a plaintext `.env` in production

For a production deployment handling real funds, pull the private key from
**AWS Secrets Manager** or **SSM Parameter Store** at startup instead of
storing it in a plaintext `.env` file on disk. A minimal pattern:

```bash
# In your startup script, before launching the app:
export PRIVATE_KEY=$(aws secretsmanager get-secret-value \
  --secret-id usdc-forwarder/private-key \
  --query SecretString --output text)
```
The app reads `process.env.PRIVATE_KEY` either way, so this requires no
code changes — just don't write the resolved value back to disk.

---

## 9. Security recommendations

- **Use a dedicated wallet.** Don't reuse a wallet that holds other assets
  for this automation — limit blast radius if the host is ever compromised.
- **Keep the private key out of git and out of shell history.** Prefer
  Secrets Manager/SSM/Vault over a plaintext `.env` for anything beyond
  local testing.
- **Restrict EC2 access.** SSH key-only, security group locked to your IP,
  no unnecessary open ports.
- **Least-privilege IAM** if you do integrate Secrets Manager — the
  instance role should only be able to read that one secret.
- **Monitor the `/status` endpoint** and wire up the Telegram/Discord/Slack
  notifications so a failed forward doesn't go unnoticed.
- **Keep `MIN_ETH_RESERVE` realistic** and top up ETH proactively — a stuck
  bot with a full USDC balance and no gas is a silent failure mode.
- **Review confirmations vs. speed trade-off.** More confirmations = safer
  against reorgs, slightly slower to forward. Arbitrum finality is fast, so
  3–5 confirmations is a reasonable default.
- **Rotate the key** if you ever suspect the host was compromised, and
  sweep funds to a fresh wallet.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `[CONFIG] Missing required environment variable: X` | `.env` is missing that key — check `.env.example` |
| `RPC_URL points at chain X, but CHAIN_ID is configured as Y` | Your RPC endpoint isn't actually Arbitrum One — check the URL |
| Forward fails with "insufficient funds for gas" | Wallet has USDC but no ETH — send a small amount of ETH to it |
| Deposits detected but never forwarded | Check `/status` for `lastError`; check `logs/error.log`; verify `DESTINATION_ADDRESS` is correct |
| Bot restarts in a loop | Check `logs/error.log` or `pm2 logs` / `journalctl -u usdc-forwarder` for the startup error |
| Duplicate forwards | Shouldn't happen — but if `data/processed.json` was deleted while old deposits were still unconfirmed, a rescan could occur. Keep the `data/` directory persisted (Docker volume / don't delete on the host) |
| WebSocket keeps reconnecting | Non-fatal — polling is the source of truth. If it's noisy, leave `RPC_WS_URL` blank to disable it |

---

## 11. Future scalability improvements

- **Multi-wallet support:** generalize the monitor/forwarder to watch a
  list of source wallets, each forwarding to its own (or a shared)
  destination.
- **Database-backed state** (Postgres/SQLite) instead of JSON files if you
  need multi-instance deployment or richer querying/auditing of forward
  history.
- **Queue-based architecture** (SQS/BullMQ) to decouple detection from
  forwarding, enabling horizontal scaling and better retry/backoff
  observability at scale.
- **Metrics/observability:** export Prometheus metrics (deposits detected,
  forward latency, failure rate) alongside the existing `/status` endpoint.
- **Multi-sig or MPC destination flows** if the forwarded amounts grow
  large enough to want additional signing controls on the receiving side.
- **Automatic ETH gas top-up** from a separate funding wallet when the
  reserve drops below threshold, removing the manual top-up step entirely.
