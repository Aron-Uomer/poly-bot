const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const path     = require('path');
const dotenv   = require('dotenv');
const db       = require('./db');
const bot      = require('./bot');

dotenv.config();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();

function getState() {
  const state = db.readDb();
  state.botActive = bot.isBotActive();
  if (state.config && !state.config.paperTrading) {
    state.openPositions = state.livePositions || [];
  }
  return state;
}

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data: { ...getState(), ...data, botActive: bot.isBotActive() } });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', data: getState() }));
  db.addLog("Dashboard connected.", "system");
  ws.on('close', () => {
    clients.delete(ws);
    db.addLog("Dashboard disconnected.", "system");
  });
});

bot.setBroadcastCallback(({ type, data }) => broadcast(type, data));

// --- API ROUTES ---

app.get('/api/state', (req, res) => res.json(getState()));

app.post('/api/bot/start', (req, res) => {
  try {
    bot.startCopyTradingBot();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/bot/stop', async (req, res) => {
  try {
    await bot.stopCopyTradingBot();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/wallets', (req, res) => {
  const { address, label, multiplier } = req.body;
  if (!address) return res.status(400).json({ success: false, error: "Address required." });
  try {
    const newWallet = db.addTrackedWallet(address, label, multiplier);
    broadcast('state_update', {});
    res.json({ success: true, wallet: newWallet });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/wallets/:address', (req, res) => {
  const address = req.params.address;
  if (!address) return res.status(400).json({ success: false, error: "Address required." });
  const success = db.removeTrackedWallet(address);
  if (success) {
    broadcast('state_update', {});
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: "Wallet not found." });
  }
});

app.post('/api/config', (req, res) => {
  const { paperTrading, simulationBalance, realBalance, realStartingBalance } = req.body;
  const updates = {};
  if (paperTrading !== undefined) updates.paperTrading = !!paperTrading;
  if (simulationBalance !== undefined) {
    const val = parseFloat(simulationBalance);
    updates.simulationBalance         = val;
    updates.simulationStartingBalance = val;
  }
  if (realBalance !== undefined)         updates.realBalance         = parseFloat(realBalance);
  if (realStartingBalance !== undefined) updates.realStartingBalance = parseFloat(realStartingBalance);
  try {
    db.updateConfig(updates);
    broadcast('state_update', {});
    res.json({ success: true, config: db.readDb().config });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/test/inject-trade', async (req, res) => {
  const currentDb = db.readDb();
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

  if (!targetWallet) {
    return res.status(400).json({ success: false, error: 'No tracked wallet found.' });
  }

  try {
    await bot._testInjectTrade(targetWallet, fakeActivity);
    broadcast('state_update', {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/simulation/reset', (req, res) => {
  try {
    db.resetSimulation();
    broadcast('state_update', {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/debug/derive', async (req, res) => {
  try {
    const clobModule = await import('@polymarket/clob-client-v2');
    const viemAccountsModule = await import('viem/accounts');
    const viemModule = await import('viem');

    const ClobClient = clobModule.ClobClient;
    const Chain = clobModule.Chain;
    const createWalletClient = viemModule.createWalletClient;
    const http = viemModule.http;
    const mnemonicToAccount = viemAccountsModule.mnemonicToAccount;

    const pKey = process.env.POLYMARKET_PRIVATE_KEY.trim().replace(/,/g, ' ');
    const account = mnemonicToAccount(pKey);
    const walletClient = createWalletClient({
      account,
      transport: http("https://polygon-bor-rpc.publicnode.com")
    });

    const baseClient = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer: walletClient
    });
    const creds = await baseClient.createOrDeriveApiKey();

    const authClient = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer: walletClient,
      creds: {
        key: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase
      }
    });

    const balanceData = await authClient.getBalanceAllowance({ asset_type: 'COLLATERAL' });

    res.json({
      eoa: account.address,
      derivedKey: creds.key,
      balanceData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- STARTUP ---
server.listen(PORT, async () => {
  db.addLog(`Server listening on http://localhost:${PORT}`, 'system');
  await bot.refreshLiveBalance();
  const initialDb = db.readDb();
  if (initialDb.config.isRunning) {
    db.addLog("Auto-resuming bot...", "system");
    bot.startCopyTradingBot();
  } else {
    db.addLog("Bot paused. Start via dashboard.", "system");
  }
});