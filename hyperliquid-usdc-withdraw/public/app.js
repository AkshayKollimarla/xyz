const el = (id) => document.getElementById(id);
function log(msg, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el('log').appendChild(line);
  el('log').scrollTop = el('log').scrollHeight;
}

let lastStatus = null;

function setStatusBox(elOrContainer, state, message, append) {
  const box = append ? document.createElement('div') : elOrContainer;
  box.className = 'status-box status-' + state;
  const icon = { pending: '⏳', ok: '✅', err: '❌', warn: '⚠️' }[state] || '';
  box.innerHTML = `${icon} ${message}`;
  box.style.display = 'block';
  if (append) elOrContainer.appendChild(box);
  return box;
}

// Independently verifies (via a direct Arbitrum on-chain check, not just
// "Hyperliquid accepted the request") whether a withdrawal has actually
// landed, and updates the given status box as it goes.
async function pollArrival({ destination, fromBlock, statusBox, label }) {
  const maxAttempts = 40; // ~10 minutes at 15s intervals — generous over the ~5 min typical time
  const intervalMs = 15000;
  const prefix = label ? `${label}: ` : '';

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      const res = await fetch(`/api/withdraw-arrival?destination=${encodeURIComponent(destination)}&fromBlock=${fromBlock}`);
      const data = await res.json();
      if (data.error) {
        setStatusBox(statusBox, 'err', `${prefix}Arrival check failed: ${data.error}`);
        return;
      }
      if (data.found) {
        setStatusBox(
          statusBox, 'ok',
          `${prefix}Confirmed arrived on Arbitrum: ${data.amount} USDC — ` +
          `<a href="https://arbiscan.io/tx/${data.txHash}" target="_blank" rel="noopener">${data.txHash.slice(0, 10)}…</a>`
        );
        return;
      }
    } catch (e) {
      // transient network error — keep polling, don't give up on one blip
    }
  }
  setStatusBox(statusBox, 'warn', `${prefix}Not yet detected on Arbitrum after ~10 minutes. Check the destination address on Arbiscan manually.`);
}

function accountTotal(acc) {
  let total = Number(acc.perpWithdrawable) + Number(acc.spotUsdc);
  (acc.extraPerpDexes || []).forEach((d) => {
    if (!d.error) total += Number(d.withdrawable);
  });
  return total;
}

async function refresh() {
  el('accountsBlock').textContent = 'Loading account status…';
  try {
    const res = await fetch('/api/status');
    if (res.status === 401) { showLogin('Session expired — please log in again.'); return; }
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    lastStatus = data;

    let html = '';
    data.accounts.forEach((acc, i) => {
      html += `<div class="account-block"><h2>${acc.id}</h2>`;
      html += `<div class="balances">`;
      html += `Withdrawable (Perps): <span class="val">${acc.perpWithdrawable} USDC</span><br>`;
      html += `Spot balance: <span class="val">${acc.spotUsdc} USDC</span>`;
      (acc.extraPerpDexes || []).forEach((d) => {
        html += d.error
          ? `<br>Perps (${d.name}): <span class="val" style="color:var(--danger);">error — ${d.error}</span>`
          : `<br>Perps (${d.name}): <span class="val">${d.withdrawable} USDC</span>`;
      });
      html += `</div>`;
      html += `<div class="addr">Account: ${acc.address}</div>`;
      if (Number(acc.spotUsdc) > 0) {
        html += `<div class="spot-note">Has ${acc.spotUsdc} USDC in Spot — swept into Perps automatically on withdraw.</div>`;
      }
      html += `</div>`;
    });
    el('accountsBlock').innerHTML = html;

    const accountSelect = el('withdrawAccount');
    const prevSelected = accountSelect.value;
    accountSelect.innerHTML = data.accounts
      .map((acc) => `<option value="${acc.id}">${acc.id} (${acc.address.slice(0, 6)}…${acc.address.slice(-4)})</option>`)
      .join('');
    if (data.accounts.some((a) => a.id === prevSelected)) {
      accountSelect.value = prevSelected;
    }

    if (data.defaultDestination) {
      if (!el('destAddr').value) el('destAddr').value = data.defaultDestination;
      if (!el('flattenDestAddr').value) el('flattenDestAddr').value = data.defaultDestination;
    }

    el('flattenAllCard').style.display = data.accounts.length > 0 ? 'block' : 'none';

    await loadPositions();
  } catch (e) {
    el('accountsBlock').textContent = 'Failed to load status: ' + e.message;
  }
}

async function loadPositions() {
  const card = el('positionsCard');
  const previews = await fetch('/api/positions-all').then((r) => r.json());
  if (previews.error) {
    card.style.display = 'block';
    card.innerHTML = `<span style="color:var(--danger);">Failed to load positions: ${previews.error}</span>`;
    return;
  }

  const withPositions = previews.filter((p) => !p.error && p.positions && p.positions.length > 0);
  if (withPositions.length === 0) {
    card.style.display = 'none';
    card.innerHTML = '';
    return;
  }

  let html = '';
  withPositions.forEach((preview) => {
    const dexLabel = preview.dex || 'main';
    html += `<div style="margin-bottom:8px;"><b>Open Positions — ${preview.accountId} (${dexLabel})</b></div>`;
    preview.positions.forEach((p) => {
      const pnlColor = Number(p.unrealizedPnl) < 0 ? 'var(--danger)' : 'var(--ok)';
      html +=
        `<div style="font-size:13px; margin-bottom:4px;">` +
        `${p.coin} — ${p.side} ${Math.abs(Number(p.size))} @ ${p.entryPx}, value $${Number(p.positionValue).toFixed(2)}, ` +
        `uPnL <span style="color:${pnlColor};">$${Number(p.unrealizedPnl).toFixed(2)}</span></div>`;
    });
    html +=
      `<div style="font-size:13px; margin:6px 0;">Total unrealized P&amp;L: ` +
      `<span style="color:${Number(preview.totalUnrealizedPnl) < 0 ? 'var(--danger)' : 'var(--ok)'};">$${Number(preview.totalUnrealizedPnl).toFixed(2)}</span></div>` +
      `<button class="danger btn-flat-all" data-dex="${preview.dex}" data-account="${preview.accountId}">Flat Positions (${preview.accountId} / ${dexLabel})</button>`;
  });

  card.style.display = 'block';
  card.innerHTML = html;
  card.querySelectorAll('.btn-flat-all').forEach((btn) => {
    btn.addEventListener('click', () => flatAllPositions(btn.dataset.account, btn.dataset.dex));
  });
}

async function flatAllPositions(account, dex) {
  const preview = await fetch(`/api/positions?dex=${encodeURIComponent(dex)}&account=${encodeURIComponent(account)}`).then((r) => r.json());
  if (preview.error) { alert('Failed to load positions: ' + preview.error); return; }
  if (!preview.positions.length) { alert('No open positions on ' + dex + '.'); return; }

  const lines = preview.positions
    .map((p) => `  ${p.coin}: close ${p.side} ${Math.abs(Number(p.size))} (uPnL $${Number(p.unrealizedPnl).toFixed(2)})`)
    .join('\n');
  const confirmMsg =
    `This will place reduce-only market orders to CLOSE ALL open positions for ${account} on "${dex || 'main'}":\n\n${lines}\n\n` +
    `Total unrealized P&L to be realized: $${Number(preview.totalUnrealizedPnl).toFixed(2)}\n\n` +
    `This is irreversible and executes real trades. Type CLOSE (all caps) to confirm:`;
  const typed = window.prompt(confirmMsg);
  if (typed !== 'CLOSE') {
    log('Flat cancelled (confirmation text did not match).', 'warn');
    return;
  }

  log(`Closing all positions for ${account} on ${dex || 'main'}...`);
  try {
    const res = await fetch('/api/close-positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dex, account }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    log(`Close orders submitted for ${account}/${dex || 'main'}: ${data.closed.length} order(s).`, 'ok');
    if (data.fullyClosed) {
      log(`Confirmed fully closed (re-checked live position state).`, 'ok');
    } else {
      const remainingLines = data.remainingPositions
        .map((p) => `${p.coin}: ${p.side} ${Math.abs(Number(p.size))}`)
        .join(', ');
      log(`NOT fully closed after retries — still open: ${remainingLines}`, 'err');
    }
    await refresh();
  } catch (e) {
    log('Error closing positions: ' + e.message, 'err');
  }
}

el('btnRefresh').addEventListener('click', refresh);

el('btnFlattenAll').addEventListener('click', async () => {
  const destination = el('flattenDestAddr').value.trim();
  if (!destination) { alert('Enter a destination address.'); return; }
  if (!lastStatus) { alert('Status not loaded yet — click Refresh first.'); return; }

  const positionsPreview = await fetch('/api/positions-all').then((r) => r.json());
  const withPositions = Array.isArray(positionsPreview) ? positionsPreview.filter((p) => !p.error && p.positions.length > 0) : [];

  let positionLines = 'None.';
  if (withPositions.length > 0) {
    positionLines = withPositions
      .map((preview) =>
        `  ${preview.accountId} (${preview.dex || 'main'}): ${preview.positions.length} position(s), uPnL $${Number(preview.totalUnrealizedPnl).toFixed(2)}`
      )
      .join('\n');
  }

  const accountLines = lastStatus.accounts
    .map((acc) => `  ${acc.id} (${acc.address}): ~${accountTotal(acc).toFixed(2)} USDC total`)
    .join('\n');

  const confirmMsg =
    `This will, for EVERY configured account:\n` +
    `1. Close ALL open positions (realizing P&L)\n` +
    `2. Sweep Spot + any HIP-3 dex balance into Perps\n` +
    `3. Withdraw the entire resulting balance to:\n   ${destination}\n\n` +
    `Positions to close:\n${positionLines}\n\n` +
    `Approximate balances (before closing) per account:\n${accountLines}\n\n` +
    `This is irreversible and executes real trades and transfers. Type FLATTEN ALL (all caps) to confirm:`;
  const typed = window.prompt(confirmMsg);
  if (typed !== 'FLATTEN ALL') {
    log('Flatten-all cancelled (confirmation text did not match).', 'warn');
    return;
  }

  const statusContainer = el('flattenStatus');
  statusContainer.innerHTML = '';
  const overallBox = setStatusBox(statusContainer, 'pending', 'Closing positions and withdrawing on all accounts...', true);

  el('btnFlattenAll').disabled = true;
  try {
    log('Closing all positions on all accounts...');
    const res = await fetch('/api/close-all-and-withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    overallBox.remove();

    data.closeResults.forEach((r) => {
      log(`Closed ${r.closed.length} position(s) for ${r.accountId} on ${r.dex || 'main'} — fully closed: ${r.fullyClosed}.`, r.fullyClosed ? 'ok' : 'err');
    });

    if (data.incompleteCloses && data.incompleteCloses.length > 0) {
      const lines = data.incompleteCloses
        .map((r) => {
          const remaining = r.remainingPositions.map((p) => `${p.coin} ${p.side} ${Math.abs(Number(p.size))}`).join(', ');
          return `${r.accountId} (${r.dex || 'main'}): ${remaining}`;
        })
        .join('<br>');
      setStatusBox(statusContainer, 'err', `Some positions did NOT fully close after retries — still open:<br>${lines}`, true);
    }

    data.withdrawResults.forEach((r) => {
      log(`Withdrew ${r.amount} USDC from ${r.accountId} to ${r.destination}.`, 'ok');
      const box = setStatusBox(
        statusContainer, 'pending',
        `${r.accountId}: accepted by Hyperliquid — ${r.amount} USDC to ${r.destination}. Verifying arrival on Arbitrum (~5 min)...`,
        true
      );
      pollArrival({ destination: r.destination, fromBlock: r.arbitrumFromBlock, statusBox: box, label: r.accountId });
    });
    log('All withdrawals submitted.', 'warn');
    await refresh();
  } catch (e) {
    log('Error in flatten-all: ' + e.message, 'err');
    setStatusBox(overallBox, 'err', 'Flatten-all failed: ' + e.message);
  } finally {
    el('btnFlattenAll').disabled = false;
  }
});

el('btnWithdraw').addEventListener('click', async () => {
  const account = el('withdrawAccount').value;
  const destination = el('destAddr').value.trim();
  const amount = el('amount').value.trim();

  if (!account) { alert('No account selected — click Refresh first.'); return; }
  if (!destination) { alert('Enter a destination address.'); return; }

  let amountLabel = amount;
  if (!amountLabel) {
    const acc = lastStatus && lastStatus.accounts.find((a) => a.id === account);
    amountLabel = `${account}'s entire balance (~${acc ? accountTotal(acc).toFixed(2) : '?'} USDC, across Spot/Perps/any HIP-3 dexes)`;
  }
  const confirmMsg =
    `Withdraw ${amountLabel} from Hyperliquid (${account})\n` +
    `To: ${destination}\n\n` +
    `This is irreversible. Continue?`;
  if (!window.confirm(confirmMsg)) return;

  const statusBox = el('withdrawStatus');
  el('btnWithdraw').disabled = true;
  setStatusBox(statusBox, 'pending', `Submitting withdrawal (${account})...`);
  try {
    log(`Submitting withdrawal (${account})...`);
    const res = await fetch('/api/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination, amount: amount || undefined, account }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.movedFromSpot && Number(data.movedFromSpot) > 0) {
      log(`Swept ${data.movedFromSpot} USDC from Spot into Perps first.`, 'ok');
    }
    Object.entries(data.movedFromDexes || {}).forEach(([dex, amt]) => {
      log(`Swept ${amt} USDC from Perps (${dex}) into main Perps first.`, 'ok');
    });
    log(`Withdrawal submitted: ${data.amount} USDC to ${data.destination}`, 'ok');
    setStatusBox(statusBox, 'pending', `Accepted by Hyperliquid: ${data.amount} USDC to ${data.destination}. Verifying arrival on Arbitrum (~5 min)...`);
    await refresh();
    pollArrival({ destination: data.destination, fromBlock: data.arbitrumFromBlock, statusBox });
  } catch (e) {
    log('Error: ' + e.message, 'err');
    setStatusBox(statusBox, 'err', 'Withdrawal failed: ' + e.message);
  } finally {
    el('btnWithdraw').disabled = false;
  }
});

function showApp() {
  el('loginOverlay').classList.add('hidden');
  el('appWrap').classList.remove('hidden');
  refresh();
}

function showLogin(message) {
  el('appWrap').classList.add('hidden');
  el('loginOverlay').classList.remove('hidden');
  el('loginError').textContent = message || '';
  el('loginPassword').value = '';
  el('loginPassword').focus();
}

async function attemptLogin() {
  const password = el('loginPassword').value;
  el('btnLogin').disabled = true;
  el('loginError').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Login failed');
    showApp();
  } catch (e) {
    el('loginError').textContent = e.message;
    el('loginPassword').value = '';
    el('loginPassword').focus();
  } finally {
    el('btnLogin').disabled = false;
  }
}

el('btnLogin').addEventListener('click', attemptLogin);
el('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptLogin(); });

el('btnLogout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

(async function bootstrap() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();
    if (data.authenticated) {
      showApp();
    } else {
      showLogin();
    }
  } catch (e) {
    showLogin('Could not reach the server: ' + e.message);
  }
})();
