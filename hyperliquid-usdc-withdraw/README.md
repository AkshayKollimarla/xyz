# Hyperliquid USDC Withdraw

A small local-only UI that withdraws USDC **directly from your Hyperliquid
account to any destination address on Arbitrum**, in a single signed action —
no intermediate "forward from my own wallet" hop required.

## Why this exists

Hyperliquid's withdrawal action (`withdraw3`) takes an explicit `destination`
field that can be **any address**, not just the address of the account doing
the withdrawing. That means you don't need to withdraw to your own wallet and
then separately send an ERC-20 transfer to where you actually want the funds
— you can withdraw straight to the final destination.

## What you need

- Your Hyperliquid **master account** private key (the one behind the
  MetaMask wallet you log into Hyperliquid with). Withdrawals must be signed
  by the master account — an API/agent wallet cannot authorize them.
- The destination address you want the USDC sent to.

No Arbitrum RPC, ETH for gas, or separate forwarder bot is needed for this
step — Hyperliquid's bridge handles the on-chain side. There's a small
(~$1) withdrawal fee deducted automatically, and it takes a few minutes to
land on Arbitrum.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- `PRIVATE_KEY` — your Hyperliquid master account private key
- `DESTINATION_ADDRESS` — default destination (optional; can be overridden per-withdrawal in the UI)
- `EXTRA_PERP_DEXES` — optional, comma-separated HIP-3 dex names (e.g. `xyz`) if your account holds balance in one, shown as `Perps (<name>)` in the Hyperliquid frontend

## Run

```bash
npm start
```

Open `http://127.0.0.1:3001`. The server only ever binds to localhost — it
is never reachable from the network.

The page shows:
- Your account address, current withdrawable (Perps) balance, Spot USDC
  balance, and any HIP-3 dex balances listed in `EXTRA_PERP_DEXES`
- A form to withdraw a specific amount (or your entire balance, if left
  blank) to any destination address, with a confirmation prompt before
  submitting

Withdrawals only pull from the main **Perps** balance. Every withdrawal
automatically sweeps Spot USDC into Perps first (`usdClassTransfer`), and
sweeps any HIP-3 dex balance listed in `EXTRA_PERP_DEXES` into main Perps
too (`sendAsset`, dex-to-dex) — so a blank-amount withdrawal really does
move your entire account, no manual step needed.

## Security notes

- The private key is read once from `.env` on the server process and never
  leaves this machine — it isn't sent to the browser, logged, or transmitted
  anywhere except as a local signature over the withdrawal request.
- Never commit `.env` (it's already gitignored).
- Never expose this server beyond `127.0.0.1` / localhost.
- Use a dedicated wallet if you're at all uneasy about keeping this key on a
  machine long-term.
