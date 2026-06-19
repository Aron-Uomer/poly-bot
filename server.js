const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const dotenv    = require('dotenv');
const db        = require('./db');
const bot       = require('./bot');

dotenv.config();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();

async function getState() {
  const state = await db.readDb();
  state.botActive = bot.isBotActive();
  if (state.config && (state.config.paperTrading === false || state.config.paperTrading === 'false')) {
    state.openPositions = bot.getLivePositions();
  }
  return state;
}

async function broadcast(type, data) {
  try {
    const state   = await getState();
    const payload = JSON.stringify({ type, data: { ...state, ...data, botActive: bot.isBotActive() } });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  } catch (err) {
    db.addLog(`Broadcast error: ${err.message}`, 'error');
  }
}

wss.on('connection', async (ws) => {
  clients.add(ws);
  try {
    ws.send(JSON.stringify({ type: 'init', data: await getState() }));
  } catch (err) {
    db.addLog(`WS init error: ${err.message}`, 'error');
  }
  ws.on('close', () => clients.delete(ws));
});

bot.setBroadcastCallback(({ type, data }) => broadcast(type, data));

// --- API ROUTES ---

app.get('/api/state', async (req, res) => {
  try { res.json(await getState()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bot/start', (req, res) => {
  try { bot.startCopyTradingBot(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bot/stop', async (req, res) => {
  try { await bot.stopCopyTradingBot(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/wallets', async (req, res) => {
  const { address, label, multiplier } = req.body;
  if (!address) return res.status(400).json({ success: false, error: "Address required." });
  try {
    const newWallet = await db.addTrackedWallet(address, label, multiplier);
    await broadcast('state_update', {});
    res.json({ success: true, wallet: newWallet });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/wallets/:address', async (req, res) => {
  const { address } = req.params;
  if (!address) return res.status(400).json({ success: false, error: "Address required." });
  try {
    const success = await db.removeTrackedWallet(address);
    if (success) { await broadcast('state_update', {}); res.json({ success: true }); }
    else res.status(404).json({ success: false, error: "Wallet not found." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/config', async (req, res) => {
  const { paperTrading, simulationBalance, realBalance, realStartingBalance } = req.body;
  const updates = {};
  if (paperTrading !== undefined) updates.paperTrading = !!paperTrading;
  if (simulationBalance !== undefined) {
    const val = parseFloat(simulationBalance);
    updates.simulationBalance         = val;
    updates.simulationStartingBalance = val;
  }
  if (realBalance !== undefined) {
    updates.realBalance       = parseFloat(realBalance);
    updates.realBalanceManual = true;
  }
  if (realStartingBalance !== undefined) updates.realStartingBalance = parseFloat(realStartingBalance);
  try {
    await db.updateConfig(updates);
    await broadcast('state_update', {});
    const state = await getState();
    res.json({ success: true, config: state.config });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/test/inject-trade', async (req, res) => {
  const currentDb = await db.readDb();
  const { walletAddress, side, conditionId, outcome, title, price, usdcSize, shares, transactionHash } = req.body;

  const fakeActivity = {
    conditionId:     conditionId     || 'test-condition-' + Date.now(),
    side:            (side || 'BUY').toUpperCase(),
    outcome:         outcome         || 'Yes',
    title:           title           || 'Test Market: Will Bitcoin reach $120k?',
    price:           parseFloat(price)    || 0.65,
    usdcSize:        parseFloat(usdcSize) || 1000,
    size:            parseFloat(shares)   || 1538.46,
    transactionHash: transactionHash || '0xtest_' + Date.now()
  };

  const targetAddress = walletAddress || currentDb.trackedWallets[0]?.address;
  const targetWallet  = currentDb.trackedWallets.find(w => w.address?.toLowerCase() === targetAddress?.toLowerCase());

  if (!targetWallet) return res.status(400).json({ success: false, error: 'No tracked wallet found.' });

  try {
    await bot._testInjectTrade(targetWallet, fakeActivity);
    await broadcast('state_update', {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/simulation/reset', async (req, res) => {
  try {
    await db.resetSimulation();
    await broadcast('state_update', {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- STARTUP ---
server.listen(PORT, async () => {
  db.addLog(`Server listening on http://localhost:${PORT}`, 'system');
  try {
    await db.initDb();
    db.addLog('PostgreSQL connected and schema ready.', 'system');
  } catch (err) {
    console.error('FULL ERROR:', err);
    db.addLog(`Database init failed: ${err.message || err.toString()}`, 'error');
    process.exit(1);
  }

  await bot.refreshLiveBalance();

  const initialDb = await db.readDb();
  const isRunning = initialDb.config.isRunning === true || initialDb.config.isRunning === 'true';
  if (isRunning) {
    db.addLog("Auto-resuming bot...", "system");
    bot.startCopyTradingBot();
  } else {
    db.addLog("Bot paused. Start via dashboard.", "system");
  }
});