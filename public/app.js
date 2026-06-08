// ==========================================================================
// POLYMARKET REPLICATOR - FRONTEND CONTROLLER
// ==========================================================================

let socket = null;
let reconnectTimer = null;
let isConnected = false;

const connectionBadge    = document.getElementById('connection-badge');
const profileBadge       = document.getElementById('profile-badge');
const profileLabel       = document.getElementById('profile-label');
const botToggleBtn       = document.getElementById('bot-toggle-btn');
const paperModeToggle    = document.getElementById('paper-mode-toggle');
const liveWarningBanner  = document.getElementById('live-warning-banner');
const resetSimBtn        = document.getElementById('reset-sim-btn');
const addWalletForm      = document.getElementById('add-wallet-form');
const walletsList        = document.getElementById('wallets-list');
const trackedCount       = document.getElementById('tracked-count');
const liveBalanceGroup   = document.getElementById('live-balance-form-group');
const liveBalanceInput   = document.getElementById('live-balance-input');
const setLiveBalanceBtn  = document.getElementById('set-live-balance-btn');

const positionsTableBody = document.getElementById('positions-table-body');
const positionsCount     = document.getElementById('positions-count');
const tradesTableBody    = document.getElementById('trades-table-body');
const tradesCount        = document.getElementById('trades-count');

const navVal         = document.getElementById('nav-val');
const cashVal        = document.getElementById('cash-val');
const cashModeSubtext = document.getElementById('cash-mode-subtext');
const positionsVal   = document.getElementById('positions-val');
const pnlVal         = document.getElementById('pnl-val');
const pnlPct         = document.getElementById('pnl-pct');
const pnlCard        = document.getElementById('pnl-card');
const realizedPnlVal = document.getElementById('realized-pnl-val');
const realizedPnlCard = document.getElementById('realized-pnl-card');

function connectWebSocket() {
  const protocol  = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socketUrl = `${protocol}//${window.location.host}`;
  socket = new WebSocket(socketUrl);

  socket.onopen = () => {
    isConnected = true;
    updateConnectionBadge(true);
    if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
  };

  socket.onclose = () => {
    isConnected = false;
    updateConnectionBadge(false);
    if (!reconnectTimer) reconnectTimer = setInterval(connectWebSocket, 4000);
  };

  socket.onerror = (err) => console.error("WebSocket error:", err);

  socket.onmessage = (event) => {
    try {
      const { type, data } = JSON.parse(event.data);
      if (['init','state_update','wallet_updated','trade_executed','bot_started','bot_stopped'].includes(type)) {
        renderFullState(data);
      }
    } catch (err) {
      console.error("Failed to parse WebSocket message:", err);
    }
  };
}

function updateConnectionBadge(online) {
  connectionBadge.className = `connection-status ${online ? 'online' : 'offline'}`;
  connectionBadge.querySelector('.status-label').innerText = online ? 'ONLINE' : 'DISCONNECTED';
}

function renderFullState(state) {
  const { config, trackedWallets, openPositions, tradeHistory, botActive } = state;

  // Bot toggle button
  if (botActive) {
    botToggleBtn.className = "btn btn-bot-status running";
    botToggleBtn.querySelector('span').innerText = "PAUSE ENGINE";
    botToggleBtn.querySelector('i').className = "fa-solid fa-pause";
  } else {
    botToggleBtn.className = "btn btn-bot-status paused";
    botToggleBtn.querySelector('span').innerText = "RUN ENGINE";
    botToggleBtn.querySelector('i').className = "fa-solid fa-play";
  }

  // Profile badge
  if (!config.paperTrading && config.proxyUsername) {
    profileBadge.style.display = 'flex';
    profileLabel.innerText = config.proxyUsername.startsWith('@')
      ? config.proxyUsername
      : `@${config.proxyUsername}`;
  } else {
    profileBadge.style.display = 'none';
  }

  // Paper/live mode UI
  paperModeToggle.checked = config.paperTrading;
  if (config.paperTrading) {
    liveWarningBanner.classList.add('hidden');
    liveBalanceGroup.classList.add('hidden');
    cashModeSubtext.innerText = "Simulated Balance";
    resetSimBtn.disabled = false;
    resetSimBtn.style.opacity = '';
    resetSimBtn.style.cursor = '';
  } else {
    liveWarningBanner.classList.remove('hidden');
    liveBalanceGroup.classList.remove('hidden');
    cashModeSubtext.innerText = "Live USDC Balance";
    resetSimBtn.disabled = true;
    resetSimBtn.style.opacity = '0.35';
    resetSimBtn.style.cursor = 'not-allowed';
    // Pre-fill the input with current saved balance
    if (liveBalanceInput && !liveBalanceInput.value) {
      liveBalanceInput.value = (config.realBalance || 0).toFixed(2);
    }
  }

  // Metrics
  const currentUSDC      = config.paperTrading ? config.simulationBalance : (config.realBalance || 0);
  const positionsValSum  = openPositions.reduce((s, p) => s + (p.shares * p.currentPrice), 0);
  const positionsCostBasis = openPositions.reduce((s, p) => s + (p.shares * p.avgPricePaid), 0);
  const totalNAV         = currentUSDC + positionsValSum;
  const unrealizedPnL    = positionsValSum - positionsCostBasis;
  const realizedPnL      = typeof config.totalRealizedPnL === 'number' ? config.totalRealizedPnL : 0;
  const startingBalance  = config.paperTrading
    ? (config.simulationStartingBalance || 1000)
    : (config.realStartingBalance || config.realBalance || 1);

  navVal.innerText      = `$${totalNAV.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  cashVal.innerText     = `$${currentUSDC.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  positionsVal.innerText = `$${positionsValSum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const unrealSign = unrealizedPnL >= 0 ? '+' : '';
  pnlVal.innerText = `${unrealSign}$${unrealizedPnL.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  pnlPct.innerText = `${unrealSign}${(startingBalance > 0 ? (unrealizedPnL / startingBalance) * 100 : 0).toFixed(2)}% of Capital`;
  pnlCard.className = `metric-card card-pnl${unrealizedPnL > 0 ? ' profit' : unrealizedPnL < 0 ? ' loss' : ''}`;

  const realSign = realizedPnL >= 0 ? '+' : '';
  realizedPnlVal.innerText = `${realSign}$${realizedPnL.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  realizedPnlCard.className = `metric-card card-pnl${realizedPnL > 0 ? ' profit' : realizedPnL < 0 ? ' loss' : ''}`;

  // Wallets list
  trackedCount.innerText = trackedWallets.length;
  if (trackedWallets.length === 0) {
    walletsList.innerHTML = `<div class="empty-state">No target wallets configured.</div>`;
  } else {
    walletsList.innerHTML = "";
    trackedWallets.forEach(wallet => {
      const row = document.createElement('div');
      row.className = "wallet-row";
      const lastCheckTime = wallet.lastChecked
        ? new Date(wallet.lastChecked).toLocaleTimeString()
        : "Never checked";
      row.innerHTML = `
        <div class="wallet-info">
          <span class="wallet-name">${escapeHtml(wallet.label)}</span>
          <span class="wallet-address-tag" title="${wallet.address}">${wallet.address.substring(0, 6)}...${wallet.address.substring(38)}</span>
          <span class="field-sub">Checked: ${lastCheckTime}</span>
        </div>
        <div class="wallet-actions">
          <span class="wallet-mult-badge">${wallet.multiplier}x Copy</span>
          <button class="btn-icon-danger delete-wallet-btn" data-address="${wallet.address}">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      `;
      walletsList.appendChild(row);
    });
    document.querySelectorAll('.delete-wallet-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteTrackedWallet(btn.getAttribute('data-address')));
    });
  }

  // Positions table
  positionsCount.innerText = `${openPositions.length} Positions`;
  if (openPositions.length === 0) {
    positionsTableBody.innerHTML = `<tr><td colspan="7" class="text-center empty-table">No open positions. Waiting for target wallet signals...</td></tr>`;
  } else {
    positionsTableBody.innerHTML = "";
    openPositions.forEach(pos => {
      const tr = document.createElement('tr');
      const totalCostBasis = pos.shares * pos.avgPricePaid;
      const totalExposure  = pos.shares * pos.currentPrice;
      const unrealPnl      = totalExposure - totalCostBasis;
      tr.innerHTML = `
        <td style="font-weight:600;">${escapeHtml(pos.marketTitle)}</td>
        <td><span class="side-badge ${pos.outcome.toLowerCase() === 'yes' ? 'buy' : 'sell'}">${escapeHtml(pos.outcome)}</span></td>
        <td class="text-right font-mono">${pos.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
        <td class="text-right font-mono">$${pos.avgPricePaid.toFixed(2)}</td>
        <td class="text-right font-mono">$${pos.currentPrice.toFixed(2)}</td>
        <td class="text-right font-mono" style="font-weight:600;">$${totalExposure.toFixed(2)}</td>
        <td class="text-right"><span class="pnl-pill ${unrealPnl >= 0 ? 'profit' : 'loss'}">${unrealPnl >= 0 ? '+' : ''}$${unrealPnl.toFixed(2)}</span></td>
      `;
      positionsTableBody.appendChild(tr);
    });
  }

  // Trades table
  tradesCount.innerText = `${tradeHistory.length} Executions`;
  if (tradeHistory.length === 0) {
    tradesTableBody.innerHTML = `<tr><td colspan="11" class="text-center empty-table">Ledger is empty. No copy trades executed yet.</td></tr>`;
  } else {
    tradesTableBody.innerHTML = "";
    tradeHistory.forEach(trade => {
      const tr = document.createElement('tr');
      const pnlCell = (trade.side === 'SELL' && trade.realizedPnL != null)
        ? `<span class="pnl-pill ${trade.realizedPnL >= 0 ? 'profit' : 'loss'}">${trade.realizedPnL >= 0 ? '+' : ''}$${trade.realizedPnL.toFixed(2)}</span>`
        : `<span class="text-muted">—</span>`;
      tr.innerHTML = `
        <td class="font-mono text-muted">${new Date(trade.timestamp).toLocaleTimeString()}</td>
        <td><div style="display:flex;flex-direction:column;"><strong>${escapeHtml(trade.trackedWalletLabel)}</strong><span class="font-mono text-muted" style="font-size:10px;">${trade.trackedWallet.substring(0, 6)}...</span></div></td>
        <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(trade.marketTitle)}</td>
        <td><span class="side-badge ${trade.outcome.toLowerCase() === 'yes' ? 'buy' : 'sell'}">${escapeHtml(trade.outcome)}</span></td>
        <td><span class="side-badge ${trade.side === 'BUY' ? 'buy' : 'sell'}">${trade.side}</span></td>
        <td class="text-right font-mono text-muted">$${trade.targetTradeSize.toFixed(2)}</td>
        <td class="text-right font-mono" style="font-weight:600;">$${trade.ourTradeSize.toFixed(2)}</td>
        <td class="text-right font-mono">$${trade.executionPrice.toFixed(2)}</td>
        <td class="text-right font-mono">${trade.shares.toFixed(2)}</td>
        <td class="text-right">${pnlCell}</td>
        <td><span class="status-pill success">FILLED</span></td>
      `;
      tradesTableBody.appendChild(tr);
    });
  }
}

// --- EVENT LISTENERS ---

botToggleBtn.addEventListener('click', async () => {
  const isRunning = botToggleBtn.className.includes('running');
  try {
    await fetch(isRunning ? '/api/bot/stop' : '/api/bot/start', { method: 'POST' });
  } catch (err) {
    console.error(`Bot toggle failed: ${err.message}`);
  }
});

paperModeToggle.addEventListener('change', async () => {
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperTrading: paperModeToggle.checked })
    });
  } catch (err) {
    console.error(`Mode switch failed: ${err.message}`);
  }
});

// Set live balance manually
setLiveBalanceBtn.addEventListener('click', async () => {
  const val = parseFloat(liveBalanceInput.value);
  if (isNaN(val) || val < 0) {
    alert('Please enter a valid balance amount.');
    return;
  }
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realBalance: val, realStartingBalance: val })
    });
    const data = await res.json();
    if (data.success) {
      console.log(`[SUCCESS] Live balance set to $${val.toFixed(2)}`);
      liveBalanceInput.value = '';
    } else {
      alert(`Failed to set balance: ${data.error}`);
    }
  } catch (err) {
    console.error(`Set balance failed: ${err.message}`);
  }
});

resetSimBtn.addEventListener('click', async () => {
  if (!confirm("Reset simulation? This wipes all virtual positions and trades.")) return;
  try {
    await fetch('/api/simulation/reset', { method: 'POST' });
  } catch (err) {
    console.error(`Reset failed: ${err.message}`);
  }
});

addWalletForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const address    = document.getElementById('wallet-address').value.trim();
  const label      = document.getElementById('wallet-label').value.trim();
  const multiplier = parseFloat(document.getElementById('wallet-multiplier').value) || 1.0;
  try {
    const res  = await fetch('/api/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, label, multiplier })
    });
    const data = await res.json();
    if (data.success) {
      addWalletForm.reset();
      document.getElementById('wallet-multiplier').value = "1.0";
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (err) {
    console.error(`Add wallet failed: ${err.message}`);
  }
});

async function deleteTrackedWallet(address) {
  if (!confirm(`Remove wallet ${address}?`)) return;
  try {
    await fetch(`/api/wallets/${encodeURIComponent(address)}`, { method: 'DELETE' });
  } catch (err) {
    console.error(`Delete wallet failed: ${err.message}`);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

connectWebSocket();