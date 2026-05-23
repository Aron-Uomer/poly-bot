const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const dotenv = require('dotenv');
const db = require('./db');
const bot = require('./bot');

// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket connections hub
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  
  // Send the complete current database state to the newly connected dashboard
  const currentState = db.readDb();
  currentState.botActive = bot.isBotActive();
  ws.send(JSON.stringify({
    type: 'init',
    data: currentState
  }));
  
  db.addLog("Control panel dashboard connected via WebSockets.", "system");
  broadcast('state_update', currentState);

  ws.on('close', () => {
    clients.delete(ws);
    db.addLog("Control panel dashboard disconnected.", "system");
  });
});

// Broadcast helper to stream real-time updates to all connected dashboards
function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Hook the bot engine broadcast mechanism to stream live copy events
bot.setBroadcastCallback(({ type, data }) => {
  broadcast(type, data);
});

// --- HTTP REST API ENDPOINTS ---

// Get current state
app.get('/api/state', (req, res) => {
  const state = db.readDb();
  state.botActive = bot.isBotActive();
  res.json(state);
});

// Start copy trading bot
app.post('/api/bot/start', (req, res) => {
  try {
    bot.startCopyTradingBot();
    res.json({ success: true, message: "Bot started successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stop/Pause copy trading bot
app.post('/api/bot/stop', (req, res) => {
  try {
    bot.stopCopyTradingBot();
    res.json({ success: true, message: "Bot paused successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add a tracked wallet
app.post('/api/wallets', (req, res) => {
  const { address, label, multiplier } = req.body;
  if (!address) {
    return res.status(400).json({ success: false, error: "Wallet address is required." });
  }
  
  try {
    const newWallet = db.addTrackedWallet(address, label, multiplier);
    broadcast('state_update', db.readDb());
    res.json({ success: true, wallet: newWallet });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Remove a tracked wallet
app.delete('/api/wallets', (req, res) => {
  const { address } = req.body;
  if (!address) {
    return res.status(400).json({ success: false, error: "Wallet address is required." });
  }
  
  const success = db.removeTrackedWallet(address);
  if (success) {
    broadcast('state_update', db.readDb());
    res.json({ success: true, message: "Wallet successfully removed." });
  } else {
    res.status(404).json({ success: false, error: "Wallet address not found." });
  }
});

// Update global configuration
app.post('/api/config', (req, res) => {
  const { paperTrading, multiplier, simulationBalance } = req.body;
  const updates = {};
  
  if (paperTrading !== undefined) {
    updates.paperTrading = !!paperTrading;
  }
  if (simulationBalance !== undefined) {
    const balanceVal = parseFloat(simulationBalance);
    updates.simulationBalance = balanceVal;
    updates.simulationStartingBalance = balanceVal;
  }
  
  try {
    db.updateConfig(updates);
    broadcast('state_update', db.readDb());
    res.json({ success: true, config: db.readDb().config });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- TEST / DEBUG ENDPOINTS ---

// Inject a fake trade signal to test the full paper trading pipeline
// POST /api/test/inject-trade
// Body: { walletAddress, side, conditionId, outcome, title, price, usdcSize, shares, transactionHash }
app.post('/api/test/inject-trade', async (req, res) => {
  const currentDb = db.readDb();
  const { walletAddress, side, conditionId, outcome, title, price, usdcSize, shares, transactionHash } = req.body;

  // Defaults for easy testing
  const fakeActivity = {
    conditionId:      conditionId      || 'test-condition-' + Date.now(),
    side:             (side || 'BUY').toUpperCase(),
    outcome:          outcome          || 'Yes',
    title:            title            || 'Test Market: Will Bitcoin reach $120k?',
    price:            parseFloat(price)            || 0.65,
    usdcSize:         parseFloat(usdcSize)         || 1000,
    size:             parseFloat(shares)           || (parseFloat(usdcSize) / parseFloat(price)) || 1538.46,
    transactionHash:  transactionHash  || '0xtest_' + Date.now()
  };

  // Find the target wallet to copy from
  const targetAddress = walletAddress || (currentDb.trackedWallets[0] && currentDb.trackedWallets[0].address);
  const targetWallet  = currentDb.trackedWallets.find(w => w.address?.toLowerCase() === targetAddress?.toLowerCase());

  if (!targetWallet) {
    return res.status(400).json({
      success: false,
      error: 'No tracked wallet found. Add a wallet first via /api/wallets, or pass walletAddress in the body.',
      trackedWallets: currentDb.trackedWallets.map(w => w.address)
    });
  }

  db.addLog(`[TEST INJECT] Injecting fake ${fakeActivity.side} trade for wallet "${targetWallet.label}" in "${fakeActivity.title}"...`, 'system');

  try {
    // Run through the full processCopiedTrade pipeline
    const botModule = require('./bot');
    // processCopiedTrade is internal — we call it via a small shim
    await botModule._testInjectTrade(targetWallet, fakeActivity);

    const updatedDb = db.readDb();
    broadcast('state_update', updatedDb);
    res.json({
      success: true,
      message: `Test ${fakeActivity.side} trade injected successfully through the paper trading engine.`,
      injectedActivity: fakeActivity,
      state: updatedDb
    });
  } catch (err) {
    db.addLog(`[TEST INJECT ERROR] ${err.message}`, 'error');
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset simulation state
app.post('/api/simulation/reset', (req, res) => {
  try {
    db.resetSimulation();
    broadcast('state_update', db.readDb());
    res.json({ success: true, message: "Simulation reset complete." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fallback to serve static index.html for UI SPA routing
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Express + WebSocket HTTP Server
server.listen(PORT, () => {
  db.addLog(`Dashboard web server listening on http://localhost:${PORT}`, 'system');
  
  // Auto-resume copy trading on startup if configured to run
  const initialDb = db.readDb();
  if (initialDb.config.isRunning) {
    db.addLog("Auto-resume enabled. Initializing copy trading bot loop...", "system");
    bot.startCopyTradingBot();
  } else {
    db.addLog("Bot currently paused. Activate it via the Web Control Panel dashboard.", "system");
  }
});
