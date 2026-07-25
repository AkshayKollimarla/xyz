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
- `PRIVATE_KEY_2` — optional, a second account's master private key. If set, its balance/positions show alongside the first, and both withdraw to the same `DESTINATION_ADDRESS`.
- `DESTINATION_ADDRESS` — default destination (optional; can be overridden per-withdrawal in the UI)
- `EXTRA_PERP_DEXES` — optional, comma-separated HIP-3 dex names (e.g. `xyz`) if either account holds balance in one, shown as `Perps (<name>)` in the Hyperliquid frontend

**Real values go in `.env` only — never in `.env.example`.** `.env` is
gitignored; `.env.example` is committed to the repo, so a real key typed
into it risks getting pushed.

## Run

```bash
npm start
```

Open `http://127.0.0.1:3001`. The server only ever binds to localhost — it
is never reachable from the network.

The page shows, per configured account:
- Address, current withdrawable (Perps) balance, Spot USDC balance, and any
  HIP-3 dex balances listed in `EXTRA_PERP_DEXES`
- A manual withdraw form for account 1 (specific amount, or your entire
  balance if left blank), with a confirmation prompt before submitting
- If any account has open positions, a combined **Flat All Positions (All
  Accounts) & Withdraw Everything** action (see below)

Withdrawals only pull from the main **Perps** balance. Every withdrawal
automatically sweeps Spot USDC into Perps first (`usdClassTransfer`), and
sweeps any HIP-3 dex balance listed in `EXTRA_PERP_DEXES` into main Perps
too (`sendAsset`, dex-to-dex) — so a blank-amount withdrawal really does
move your entire account, no manual step needed.

Note: a dex's balance can only be swept if it's actually **withdrawable**.
Margin backing open positions on that dex is not — see below.

## Closing positions (freeing locked margin)

If a HIP-3 dex has open positions, part of its balance is locked as margin
and won't show up as withdrawable (or move in a sweep) until those
positions are closed. When any `EXTRA_PERP_DEXES` dex has open positions,
the page shows an "Open Positions" panel with each position's side, size,
entry price, and unrealized P&L, plus a **Flat All Positions** button per
dex.

Clicking it does **not** close anything immediately — it shows every
position that will be closed and the total P&L that will be realized, and
requires typing `CLOSE` into a prompt to proceed. Confirming places
reduce-only IOC (immediate-or-cancel) orders at a slippage-padded price for
each position, which closes them and frees their margin back into that
dex's withdrawable balance. It does not withdraw anything itself — run a
withdrawal afterward to move the newly-freed balance out.

## Flat all positions & withdraw everything (both accounts)

When any configured account has open positions, the page shows a combined
action: for **every** account, it closes all open positions, sweeps Spot +
any HIP-3 dex balance into Perps, then withdraws the entire resulting
balance — all to the **same destination address** you enter.

This is the most consequential action in the tool (real trades on
potentially two accounts, plus two withdrawals), so it requires typing the
literal phrase `FLATTEN ALL` into a prompt that lists every position to be
closed and each account's approximate balance before it does anything.

## Withdrawal confirmation

Hyperliquid accepting a `withdraw3` action only means the *request* was
valid — the actual funds take a few minutes to bridge to Arbitrum. Every
withdrawal (manual or via Flat All) is followed by an independent, direct
Arbitrum check: after submitting, the tool records the current Arbitrum
block, then polls every 15s for an incoming USDC transfer to the
destination address on or after that block.

A status box shows the live state:
- **Pending** (blue) — accepted by Hyperliquid, waiting for it to land
- **Confirmed** (green) — found on-chain, with the amount and a direct
  Arbiscan link to the transaction
- **Failed** (red) — the withdrawal request itself was rejected, with the
  actual error message
- **Not yet detected** (yellow) — after ~10 minutes of polling with no
  match; not necessarily a failure, just slower than usual — check
  Arbiscan directly

This check is real (queries Arbitrum's chain, not just re-reading
Hyperliquid's own response), so "Confirmed" here means the money is
actually sitting at the destination address, verified independently of
Hyperliquid.

## Security notes

- The private key is read once from `.env` on the server process and never
  leaves this machine — it isn't sent to the browser, logged, or transmitted
  anywhere except as a local signature over the withdrawal request.
- Never commit `.env` (it's already gitignored).
- Never expose this server beyond `127.0.0.1` / localhost.
- Use a dedicated wallet if you're at all uneasy about keeping this key on a
  machine long-term.
