// ==========================================================================
// POLYMARKET REPLICATOR - FRONTEND CONTROLLER
// Handles WebSockets, UI Interactions, and State Rendering
// ==========================================================================

let socket = null;
let reconnectTimer = null;
let isConnected = false;

// DOM Elements Reference
const connectionBadge = document.getElementById('connection-badge');
const botToggleBtn = document.getElementById('bot-toggle-btn');
const paperModeToggle = document.getElementById('paper-mode-toggle');
const liveWarningBanner = document.getElementById('live-warning-banner');
const resetSimBtn = document.getElementById('reset-sim-btn');
const addWalletForm = document.getElementById('add-wallet-form');
const walletsList = document.getElementById('wallets-list');
const trackedCount = document.getElementById('tracked-count');

// Tables
const positionsTableBody = document.getElementById('positions-table-body');
const positionsCount = document.getElementById('positions-count');
const tradesTableBody = document.getElementById('trades-table-body');
const tradesCount = document.getElementById('trades-count');

// Metric Elements
const navVal = document.getElementById('nav-val');
const cashVal = document.getElementById('cash-val');
const cashModeSubtext = document.getElementById('cash-mode-subtext');
const positionsVal = document.getElementById('positions-val');
const pnlVal = document.getElementById('pnl-val');
const pnlPct = document.getElementById('pnl-pct');
const pnlCard = document.getElementById('pnl-card');

// Console Log Elements
const consoleLogs = document.getElementById('console-logs');
const clearConsoleBtn = document.getElementById('clear-console-btn');
const autoscrollToggle = document.getElementById('autoscroll-toggle');

// Initialize WebSockets
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socketUrl = `${protocol}//${window.location.host}`;
  
  socket = new WebSocket(socketUrl);

  socket.onopen = () => {
    isConnected = true;
    updateConnectionBadge(true);
    addLocalConsoleLog("[SYSTEM] Connection to Polymarket Replicator server established.", "success");
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  };

  socket.onclose = () => {
    isConnected = false;
    updateConnectionBadge(false);
    addLocalConsoleLog("[SYSTEM] Connection lost. Attempting to reconnect in 4 seconds...", "error");
    
    // Trigger reconnection loop if not already scheduled
    if (!reconnectTimer) {
      reconnectTimer = setInterval(connectWebSocket, 4000);
    }
  };

  socket.onerror = (err) => {
    console.error("WebSocket Exception:", err);
  };

  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      const { type, data } = message;

      switch (type) {
        case 'init':
          renderFullState(data);
          renderLogs(data.logs);
          break;
        case 'state_update':
        case 'wallet_updated':
        case 'trade_executed':
        case 'bot_started':
        case 'bot_stopped':
          renderFullState(data);
          // When these engine actions happen, sync new log state
          if (data.logs) {
            renderLogs(data.logs);
          }
          break;
        default:
          console.warn("Unhandled WebSocket event type:", type);
      }
    } catch (err) {
      console.error("Failed to parse WebSocket message:", err);
    }
  };
}

// Update connection status UI
function updateConnectionBadge(online) {
  if (online) {
    connectionBadge.className = "connection-status online";
    connectionBadge.querySelector('.status-label').innerText = "ONLINE";
  } else {
    connectionBadge.className = "connection-status offline";
    connectionBadge.querySelector('.status-label').innerText = "DISCONNECTED";
  }
}

// Append log helper
function addLocalConsoleLog(message, type = 'info') {
  const logDiv = document.createElement('div');
  logDiv.className = `log-line ${type}`;
  
  const timestamp = new Date().toLocaleTimeString();
  logDiv.innerText = `[${timestamp}] ${message}`;
  
  consoleLogs.appendChild(logDiv);
  
  // Truncate logs displayed in UI to last 150
  if (consoleLogs.childElementCount > 150) {
    consoleLogs.removeChild(consoleLogs.firstChild);
  }
  
  if (autoscrollToggle.checked) {
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
  }
}

// Render historical logs array on connection
function renderLogs(logs) {
  if (!logs || !Array.isArray(logs)) return;
  consoleLogs.innerHTML = "";
  
  logs.forEach(log => {
    const logDiv = document.createElement('div');
    logDiv.className = `log-line ${log.type}`;
    const time = new Date(log.timestamp).toLocaleTimeString();
    logDiv.innerText = `[${time}] ${log.message}`;
    consoleLogs.appendChild(logDiv);
  });
  
  if (autoscrollToggle.checked) {
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
  }
}

// Global UI Rendering mapping state database
function renderFullState(state) {
  const { config, trackedWallets, openPositions, tradeHistory, botActive } = state;
  
  // 1. Render Bot Status Toggle button
  if (botActive) {
    botToggleBtn.className = "btn btn-bot-status running";
    botToggleBtn.querySelector('span').innerText = "PAUSE ENGINE";
    botToggleBtn.querySelector('i').className = "fa-solid fa-pause";
  } else {
    botToggleBtn.className = "btn btn-bot-status paused";
    botToggleBtn.querySelector('span').innerText = "RUN ENGINE";
    botToggleBtn.querySelector('i').className = "fa-solid fa-play";
  }

  // 2. Render Settings Panel State
  paperModeToggle.checked = config.paperTrading;
  if (config.paperTrading) {
    liveWarningBanner.classList.add('hidden');
    cashModeSubtext.innerText = "Simulated Balance";
  } else {
    liveWarningBanner.classList.remove('hidden');
    cashModeSubtext.innerText = "Real EOA USDC";
  }

  // 3. Calculate and Render Key Metrics
  const currentUSDC = config.paperTrading ? config.simulationBalance : config.realBalance;
  const positionsValSum = openPositions.reduce((sum, pos) => sum + (pos.shares * pos.currentPrice), 0);
  const totalNAV = currentUSDC + positionsValSum;
  
  // Simulated initial balance is defaulted or configured in env
  const startingBalance = 1000.0; // Standard reference
  const absolutePnL = totalNAV - startingBalance;
  const percentPnL = startingBalance > 0 ? (absolutePnL / startingBalance) * 100 : 0;

  navVal.innerText = `$${totalNAV.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  cashVal.innerText = `$${currentUSDC.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  positionsVal.innerText = `$${positionsValSum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  
  pnlVal.innerText = `${absolutePnL >= 0 ? '+' : ''}$${absolutePnL.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  pnlPct.innerText = `${absolutePnL >= 0 ? '+' : ''}${percentPnL.toFixed(2)}% Overall`;

  // Dynamic PnL Colors
  if (absolutePnL > 0) {
    pnlCard.className = "metric-card card-pnl profit";
  } else if (absolutePnL < 0) {
    pnlCard.className = "metric-card card-pnl loss";
  } else {
    pnlCard.className = "metric-card card-pnl";
  }

  // 4. Render Tracked Wallets Manager
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

    // Attach deletion handlers to the trash buttons
    document.querySelectorAll('.delete-wallet-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const address = btn.getAttribute('data-address');
        deleteTrackedWallet(address);
      });
    });
  }

  // 5. Render Open Positions Table
  positionsCount.innerText = `${openPositions.length} Positions`;
  if (openPositions.length === 0) {
    positionsTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center empty-table">No open positions. Waiting for target wallet signals...</td>
      </tr>
    `;
  } else {
    positionsTableBody.innerHTML = "";
    openPositions.forEach(pos => {
      const tr = document.createElement('tr');
      const totalCostBasis = pos.shares * pos.avgPricePaid;
      const totalExposure = pos.shares * pos.currentPrice;
      const unrealizedPnl = totalExposure - totalCostBasis;
      
      tr.innerHTML = `
        <td style="font-weight: 600;">${escapeHtml(pos.marketTitle)}</td>
        <td>
          <span class="side-badge ${pos.outcome.toLowerCase() === 'yes' ? 'buy' : 'sell'}">
            ${escapeHtml(pos.outcome)}
          </span>
        </td>
        <td class="text-right font-mono">${pos.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
        <td class="text-right font-mono">$${pos.avgPricePaid.toFixed(2)}</td>
        <td class="text-right font-mono">$${pos.currentPrice.toFixed(2)}</td>
        <td class="text-right font-mono" style="font-weight: 600;">$${totalExposure.toFixed(2)}</td>
        <td class="text-right">
          <span class="pnl-pill ${unrealizedPnl >= 0 ? 'profit' : 'loss'}">
            ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)}
          </span>
        </td>
      `;
      positionsTableBody.appendChild(tr);
    });
  }

  // 6. Render Trade History Ledger Table
  tradesCount.innerText = `${tradeHistory.length} Executions`;
  if (tradeHistory.length === 0) {
    tradesTableBody.innerHTML = `
      <tr>
        <td colspan="10" class="text-center empty-table">Ledger is empty. No copy trades executed yet.</td>
      </tr>
    `;
  } else {
    tradesTableBody.innerHTML = "";
    tradeHistory.forEach(trade => {
      const tr = document.createElement('tr');
      const time = new Date(trade.timestamp).toLocaleTimeString();
      
      tr.innerHTML = `
        <td class="font-mono text-muted">${time}</td>
        <td>
          <div style="display: flex; flex-direction: column;">
            <strong>${escapeHtml(trade.trackedWalletLabel)}</strong>
            <span class="font-mono text-muted" style="font-size: 10px;">${trade.trackedWallet.substring(0, 6)}...</span>
          </div>
        </td>
        <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${escapeHtml(trade.marketTitle)}
        </td>
        <td>
          <span class="side-badge ${trade.outcome.toLowerCase() === 'yes' ? 'buy' : 'sell'}">
            ${escapeHtml(trade.outcome)}
          </span>
        </td>
        <td>
          <span class="side-badge ${trade.side === 'BUY' ? 'buy' : 'sell'}">${trade.side}</span>
        </td>
        <td class="text-right font-mono text-muted">$${trade.targetTradeSize.toFixed(2)}</td>
        <td class="text-right font-mono" style="font-weight: 600;">$${trade.ourTradeSize.toFixed(2)}</td>
        <td class="text-right font-mono">$${trade.executionPrice.toFixed(2)}</td>
        <td class="text-right font-mono">${trade.shares.toFixed(2)}</td>
        <td>
          <span class="status-pill success">FILLED</span>
        </td>
      `;
      tradesTableBody.appendChild(tr);
    });
  }
}

// --- CONTROLLER HTTP API TRIGGERS ---

// Toggle Bot Status Start/Stop
botToggleBtn.addEventListener('click', async () => {
  const isRunning = botToggleBtn.className.includes('running');
  const endpoint = isRunning ? '/api/bot/stop' : '/api/bot/start';
  
  try {
    const res = await fetch(endpoint, { method: 'POST' });
    const data = await res.json();
    if (!data.success) {
      addLocalConsoleLog(`[ERROR] Failed to alter bot state: ${data.error}`, 'error');
    }
  } catch (err) {
    addLocalConsoleLog(`[ERROR] API communication failure: ${err.message}`, 'error');
  }
});

// Toggle Paper vs Live Mode
paperModeToggle.addEventListener('change', async () => {
  const isPaper = paperModeToggle.checked;
  
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperTrading: isPaper })
    });
    const data = await res.json();
    if (!data.success) {
      addLocalConsoleLog(`[ERROR] Failed to switch mode: ${data.error}`, 'error');
    }
  } catch (err) {
    addLocalConsoleLog(`[ERROR] API config transmission failure: ${err.message}`, 'error');
  }
});

// Reset simulation capital
resetSimBtn.addEventListener('click', async () => {
  if (!confirm("Are you absolutely sure you want to reset simulation? This wipes virtual positions and trades.")) return;
  
  try {
    const res = await fetch('/api/simulation/reset', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      addLocalConsoleLog("[SYSTEM] Virtual copy-trading database reset successfully.", "success");
    } else {
      addLocalConsoleLog(`[ERROR] Reset API returned error: ${data.error}`, 'error');
    }
  } catch (err) {
    addLocalConsoleLog(`[ERROR] Failed to reset simulation: ${err.message}`, 'error');
  }
});

// Add Target Wallet
addWalletForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const address = document.getElementById('wallet-address').value.trim();
  const label = document.getElementById('wallet-label').value.trim();
  const multiplier = parseFloat(document.getElementById('wallet-multiplier').value) || 1.0;
  
  try {
    const res = await fetch('/api/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, label, multiplier })
    });
    const data = await res.json();
    
    if (data.success) {
      addWalletForm.reset();
      document.getElementById('wallet-multiplier').value = "1.0"; // Restore default
      addLocalConsoleLog(`[SUCCESS] Added target wallet: ${data.wallet.label} (${data.wallet.address})`, 'success');
    } else {
      alert(`Error: ${data.error}`);
      addLocalConsoleLog(`[ERROR] Failed to add wallet: ${data.error}`, 'error');
    }
  } catch (err) {
    addLocalConsoleLog(`[ERROR] Failed to connect to add wallet endpoint: ${err.message}`, 'error');
  }
});

// Remove Tracked Target Wallet
async function deleteTrackedWallet(address) {
  if (!confirm(`Remove target address ${address} from tracking?`)) return;
  
  try {
    const res = await fetch('/api/wallets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address })
    });
    const data = await res.json();
    
    if (data.success) {
      addLocalConsoleLog(`[SYSTEM] Target wallet removed from database: ${address}`, 'success');
    } else {
      addLocalConsoleLog(`[ERROR] Failed to remove wallet: ${data.error}`, 'error');
    }
  } catch (err) {
    addLocalConsoleLog(`[ERROR] Failed to connect to delete wallet endpoint: ${err.message}`, 'error');
  }
}

// Clear Terminal logs
clearConsoleBtn.addEventListener('click', () => {
  consoleLogs.innerHTML = "";
  addLocalConsoleLog("[SYSTEM] UI console log buffer cleared.", "info");
});

// Utility to escape HTML and prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Start WebSocket Connection on page load
connectWebSocket();
