const ethers = require('ethers');
const db = require('./db');
const clob = require('./clob');
require('dotenv').config();

const USDCE_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_ADDRESS  = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)"
];

let botIntervalId    = null;
let isBotProcessing  = false;
let wsBroadcastCallback = null;

function setBroadcastCallback(callback) {
  wsBroadcastCallback = callback;
}

function broadcast(type, data) {
  if (wsBroadcastCallback) wsBroadcastCallback({ type, data });
}

const FALLBACK_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.llamarpc.com",
  "https://polygon.drpc.org",
  "https://rpc-mainnet.matic.quiknode.pro",
  "https://polygon-rpc.com",
  process.env.POLYGON_RPC_URL,
].filter(Boolean);

async function getOnChainUSDCBalance(address) {
  for (const rpcUrl of FALLBACK_RPCS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      provider._getConnection().timeout = 5000;
      const usdcContract  = new ethers.Contract(USDC_ADDRESS,  ERC20_ABI, provider);
      const usdceContract = new ethers.Contract(USDCE_ADDRESS, ERC20_ABI, provider);
      const [usdcBal, usdceBal] = await Promise.all([
        usdcContract.balanceOf(address),
        usdceContract.balanceOf(address),
      ]);
      const total = parseFloat(ethers.formatUnits(usdcBal, 6))
                  + parseFloat(ethers.formatUnits(usdceBal, 6));
      return total;
    } catch (err) {
      // Try next RPC silently
    }
  }
  return 0;
}

async function getTargetPortfolioValue(address, fallback = 0) {
  try {
    const url = `https://data-api.polymarket.com/value?user=${address}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Data API returned status ${res.status}`);
    const data = await res.json();
    let rawVal = 0;
    if (Array.isArray(data) && data.length > 0) {
      rawVal = data[0].value !== undefined ? data[0].value : data[0].totalValue;
    } else if (data) {
      rawVal = data.value !== undefined ? data.value : data.totalValue;
    }
    return parseFloat(rawVal) || 0;
  } catch (err) {
    return fallback;
  }
}

async function getTargetPositionSize(address, conditionId, outcome) {
  try {
    const url = `https://data-api.polymarket.com/positions?user=${address}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Data API positions returned status ${res.status}`);
    const positions = await res.json();
    const match = positions.find(pos =>
      pos.conditionId?.toLowerCase() === conditionId?.toLowerCase() &&
      (pos.outcome?.toLowerCase() === outcome?.toLowerCase() ||
       pos.token?.outcome?.toLowerCase() === outcome?.toLowerCase())
    );
    if (match) {
      const sizeVal = match.size !== undefined
        ? match.size
        : (match.position?.size !== undefined ? match.position.size : match.amount);
      return parseFloat(sizeVal) || 0;
    }
    return 0;
  } catch (err) {
    return null;
  }
}

async function processCopiedTrade(wallet, activity) {
  const currentDb = db.readDb();
  const isPaper = currentDb.config.paperTrading;

  const {
    conditionId,
    side,
    size: targetShares,
    usdcSize: targetUsdcSize,
    price: executionPrice,
    outcome,
    title: marketTitle,
  } = activity;

  const targetTradeUSDC = parseFloat(targetUsdcSize) || 0;
  const price           = parseFloat(executionPrice)  || 0;
  const shares          = parseFloat(targetShares)    || 0;

  if (targetTradeUSDC <= 0 || price <= 0 || shares <= 0) return;

  // For SELL — silently skip if we don't hold the position
  if (side === 'SELL') {
    const tokenID   = conditionId + "_" + outcome.toLowerCase();
    const positions = isPaper ? currentDb.openPositions : (currentDb.livePositions || []);
    const ourPosition = positions.find(p => p.tokenID === tokenID);
    if (!ourPosition || ourPosition.shares <= 0) return;
  }

  // Step 1: Target portfolio value
  const targetPositionsVal = await getTargetPortfolioValue(wallet.address, targetTradeUSDC * 10);
  const targetUsdcVal      = await getOnChainUSDCBalance(wallet.address);
  let targetTotalPortfolio = targetPositionsVal + targetUsdcVal;
  if (targetTotalPortfolio < targetTradeUSDC) {
    targetTotalPortfolio = targetTradeUSDC * 1.05;
  }

  // Step 2: Proportional ratio
  const R = targetTradeUSDC / targetTotalPortfolio;

  // Step 3: Our portfolio value
  let ourTotalPortfolio = 0;
  let ourUsdcBalance    = 0;

  if (isPaper) {
    ourUsdcBalance    = currentDb.config.simulationBalance || 0;
    const posValue    = currentDb.openPositions.reduce((s, p) => s + (p.shares * p.currentPrice), 0);
    ourTotalPortfolio = ourUsdcBalance + posValue;
  } else {
    ourUsdcBalance    = currentDb.config.realBalance || 0;
    ourTotalPortfolio = ourUsdcBalance;
  }

  if (ourTotalPortfolio <= 0) {
    db.addLog(`Cannot copy trade: Balance is $0.00. Set your live balance via the dashboard.`, 'error');
    return;
  }

  // Step 4: Size and execute
  if (side === 'BUY') {
    let ourTradeSize = R * ourTotalPortfolio * wallet.multiplier;
    if (ourTradeSize > ourUsdcBalance) ourTradeSize = ourUsdcBalance;
    if (ourTradeSize < 1.0) return;

    const ourShares = ourTradeSize / price;

    if (isPaper) {
      const success = db.executeSimulatedTrade({
        trackedWallet: wallet.address, marketTitle,
        marketConditionId: conditionId,
        tokenID: conditionId + "_" + outcome.toLowerCase(),
        outcome, side: 'BUY', executionPrice: price,
        shares: ourShares, ourTradeSize,
        targetTradeSize: targetTradeUSDC,
        targetPortfolioValue: targetTotalPortfolio
      });
      if (success) {
        db.addLog(`[BUY] "${marketTitle}" (${outcome}) — ${ourShares.toFixed(2)} shares at $${price.toFixed(2)} | Spent: $${ourTradeSize.toFixed(2)}`, 'success');
        broadcast('trade_executed', db.readDb());
      }
    } else {
      try {
        const orderResp = await clob.placeLiveOrder(conditionId, outcome, 'BUY', price, ourShares);
        const freshDb = db.readDb();
        const balanceAfterBuy = Math.max((freshDb.config.realBalance || 0) - ourTradeSize, 0);
        db.updateConfig({ realBalance: balanceAfterBuy, realBalanceManual: true });
        db.addLog(`[BUY] "${marketTitle}" (${outcome}) — ${ourShares.toFixed(2)} shares at $${price.toFixed(2)} | Spent: $${ourTradeSize.toFixed(2)} | Balance: $${balanceAfterBuy.toFixed(2)}`, 'success');
        db.executeSimulatedTrade({
          trackedWallet: wallet.address, marketTitle,
          marketConditionId: conditionId,
          tokenID: conditionId + "_" + outcome.toLowerCase(),
          outcome, side: 'BUY', executionPrice: price,
          shares: ourShares, ourTradeSize,
          targetTradeSize: targetTradeUSDC,
          targetPortfolioValue: targetTotalPortfolio
        });
        broadcast('trade_executed', db.readDb());
      } catch (err) {
        db.addLog(`[BUY FAILED] "${marketTitle}" (${outcome}) — ${err.message}`, 'error');
      }
    }

  } else if (side === 'SELL') {
    const tokenID     = conditionId + "_" + outcome.toLowerCase();
    const positions   = isPaper ? currentDb.openPositions : (currentDb.livePositions || []);
    const ourPosition = positions.find(p => p.tokenID === tokenID);

    const targetRemainingShares = await getTargetPositionSize(wallet.address, conditionId, outcome);
    let sellFraction = 1.0;
    if (targetRemainingShares !== null && targetRemainingShares > 0) {
      sellFraction = Math.min(shares / (targetRemainingShares + shares), 1.0);
    }

    const ourSharesToSell     = ourPosition.shares * sellFraction;
    const ourEstimatedRevenue = ourSharesToSell * price;

    if (ourSharesToSell <= 0.05) return;

    if (isPaper) {
      const success = db.executeSimulatedTrade({
        trackedWallet: wallet.address, marketTitle,
        marketConditionId: conditionId, tokenID, outcome,
        side: 'SELL', executionPrice: price,
        shares: ourSharesToSell, ourTradeSize: ourEstimatedRevenue,
        targetTradeSize: targetTradeUSDC,
        targetPortfolioValue: targetTotalPortfolio
      });
      if (success) {
        db.addLog(`[SELL] "${marketTitle}" (${outcome}) — ${ourSharesToSell.toFixed(2)} shares at $${price.toFixed(2)} | Revenue: $${ourEstimatedRevenue.toFixed(2)}`, 'success');
        broadcast('trade_executed', db.readDb());
      }
    } else {
      try {
        const orderResp = await clob.placeLiveOrder(conditionId, outcome, 'SELL', price, ourSharesToSell);
        const freshDb = db.readDb();
        const balanceAfterSell = (freshDb.config.realBalance || 0) + ourEstimatedRevenue;
        db.updateConfig({ realBalance: balanceAfterSell, realBalanceManual: true });
        db.addLog(`[SELL] "${marketTitle}" (${outcome}) — ${ourSharesToSell.toFixed(2)} shares at $${price.toFixed(2)} | Revenue: $${ourEstimatedRevenue.toFixed(2)} | Balance: $${balanceAfterSell.toFixed(2)}`, 'success');
        db.executeSimulatedTrade({
          trackedWallet: wallet.address, marketTitle,
          marketConditionId: conditionId, tokenID, outcome,
          side: 'SELL', executionPrice: price,
          shares: ourSharesToSell, ourTradeSize: ourEstimatedRevenue,
          targetTradeSize: targetTradeUSDC,
          targetPortfolioValue: targetTotalPortfolio
        });
        broadcast('trade_executed', db.readDb());
      } catch (err) {
        db.addLog(`[SELL FAILED] "${marketTitle}" (${outcome}) — ${err.message}`, 'error');
      }
    }
  }
}

async function syncPrices() {
  const currentDb = db.readDb();
  if (!currentDb.config.paperTrading) return;
  if (currentDb.openPositions.length === 0) return;

  const conditionIds = [...new Set(currentDb.openPositions.map(p => p.marketConditionId))];
  const priceUpdates = {};

  await Promise.all(conditionIds.map(async (cid) => {
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${cid}`);
      if (!res.ok) return;
      const markets = await res.json();
      if (!markets || markets.length === 0) return;
      const market = markets[0];
      let outcomes      = market.outcomes;
      let outcomePrices = market.outcomePrices;
      if (typeof outcomes === 'string')      outcomes      = JSON.parse(outcomes);
      if (typeof outcomePrices === 'string') outcomePrices = JSON.parse(outcomePrices);
      outcomes.forEach((out, idx) => {
        priceUpdates[cid + "_" + out.toLowerCase()] = parseFloat(outcomePrices[idx]);
      });
    } catch (err) { /* ignore */ }
  }));

  const updated = db.updatePositionPrices(priceUpdates);
  if (updated) broadcast('state_update', db.readDb());
}

async function refreshLiveBalance() {
  const currentDb = db.readDb();
  if (currentDb.config.paperTrading) return;

  const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS?.trim();
  if (!proxyAddress || !proxyAddress.startsWith('0x')) return;

  try {
    let changed = false;

    if (currentDb.config.realBalanceManual) {
      // Manual mode — only update positions display, never touch balance
      try {
        const controller = new AbortController();
        const timeout    = setTimeout(() => controller.abort(), 4000);
        const posRes     = await fetch(
          `https://data-api.polymarket.com/positions?user=${proxyAddress}`,
          { signal: controller.signal }
        );
        clearTimeout(timeout);
        if (posRes.ok) {
          const rawPositions = await posRes.json();
          if (Array.isArray(rawPositions)) {
            const mappedPositions = rawPositions
              .filter(pos => !pos.redeemable && parseFloat(pos.currentValue) > 0)
              .map(pos => ({
                id:                `live_${pos.conditionId}_${pos.outcome?.toLowerCase()}`,
                marketConditionId: pos.conditionId,
                marketTitle:       pos.title || pos.slug || "Unknown Market",
                outcome:           pos.outcome || "Yes",
                tokenID:           pos.conditionId + "_" + (pos.outcome || "yes").toLowerCase(),
                shares:            parseFloat(pos.size)         || 0,
                avgPricePaid:      parseFloat(pos.avgPrice)     || 0,
                currentPrice:      parseFloat(pos.curPrice)     || 0,
                value:             parseFloat(pos.currentValue) || 0,
                unrealizedPnL:     (parseFloat(pos.currentValue) || 0) - (parseFloat(pos.initialValue) || 0),
                trackedWallet:     pos.proxyWallet || proxyAddress
              }));
            const oldStr = JSON.stringify(currentDb.livePositions || []);
            const newStr = JSON.stringify(mappedPositions);
            if (oldStr !== newStr) {
              currentDb.livePositions = mappedPositions;
              db.saveDb(currentDb);
              broadcast('state_update', db.readDb());
            }
          }
        }
      } catch (posErr) { /* silent */ }
      return;
    }

    // Auto-fetch balance
    let liveBalance = 0;
    try {
      liveBalance = await clob.getBalance();
      if (liveBalance === 0) throw new Error("CLOB returned zero balance");
      db.addLog(`CLOB balance: $${liveBalance.toFixed(2)} USDC`, 'info');
    } catch (e) {
      try {
        liveBalance = await getTargetPortfolioValue(proxyAddress, 0);
      } catch (e2) { /* silent */ }
    }

    if (liveBalance !== currentDb.config.realBalance) {
      currentDb.config.realBalance = liveBalance;
      changed = true;
    }

    try {
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 4000);
      const posRes     = await fetch(
        `https://data-api.polymarket.com/positions?user=${proxyAddress}`,
        { signal: controller.signal }
      );
      clearTimeout(timeout);
      if (posRes.ok) {
        const rawPositions = await posRes.json();
        if (Array.isArray(rawPositions)) {
          const mappedPositions = rawPositions
            .filter(pos => !pos.redeemable && parseFloat(pos.currentValue) > 0)
            .map(pos => ({
              id:                `live_${pos.conditionId}_${pos.outcome?.toLowerCase()}`,
              marketConditionId: pos.conditionId,
              marketTitle:       pos.title || pos.slug || "Unknown Market",
              outcome:           pos.outcome || "Yes",
              tokenID:           pos.conditionId + "_" + (pos.outcome || "yes").toLowerCase(),
              shares:            parseFloat(pos.size)         || 0,
              avgPricePaid:      parseFloat(pos.avgPrice)     || 0,
              currentPrice:      parseFloat(pos.curPrice)     || 0,
              value:             parseFloat(pos.currentValue) || 0,
              unrealizedPnL:     (parseFloat(pos.currentValue) || 0) - (parseFloat(pos.initialValue) || 0),
              trackedWallet:     pos.proxyWallet || proxyAddress
            }));
          const oldStr = JSON.stringify(currentDb.livePositions || []);
          const newStr = JSON.stringify(mappedPositions);
          if (oldStr !== newStr) {
            currentDb.livePositions = mappedPositions;
            changed = true;
          }
        }
      }
    } catch (posErr) { /* silent */ }

    if (changed) {
      db.saveDb(currentDb);
      broadcast('state_update', db.readDb());
    }
  } catch (err) {
    db.addLog(`Failed to refresh live balance: ${err.message}`, 'error');
  }
}

async function runBotCycle() {
  if (isBotProcessing) return;
  isBotProcessing = true;

  try {
    await syncPrices();
    await refreshLiveBalance();

    const currentDb = db.readDb();
    if (!currentDb.config.isRunning) return;

    const wallets = currentDb.trackedWallets;
    if (wallets.length === 0) return;

    for (const wallet of wallets) {
      try {
        const pollController = new AbortController();
        const pollTimeout    = setTimeout(() => pollController.abort(), 7000);
        const res = await fetch(
          `https://data-api.polymarket.com/activity?user=${wallet.address}&type=TRADE&limit=10`,
          { signal: pollController.signal }
        );
        clearTimeout(pollTimeout);

        if (!res.ok) continue;

        const activities = await res.json();
        if (!Array.isArray(activities) || activities.length === 0) {
          db.updateWalletProcessedState(wallet.address, wallet.lastProcessedTradeId);
          continue;
        }

        const chronologicalActivities = [...activities].reverse();

        if (!wallet.lastProcessedTradeId) {
          const latest    = activities[0];
          const initialId = latest.transactionHash + "_" + latest.conditionId + "_" + latest.side;
          db.updateWalletProcessedState(wallet.address, initialId);
          db.addLog(`Watching ${wallet.label} — checkpoint set.`, 'system');
          broadcast('wallet_updated', db.readDb());
          continue;
        }

        let foundCheckpoint    = false;
        let newTradesToProcess = [];

        for (const act of chronologicalActivities) {
          const id = act.transactionHash + "_" + act.conditionId + "_" + act.side;
          if (foundCheckpoint) {
            newTradesToProcess.push(act);
          } else if (id === wallet.lastProcessedTradeId) {
            foundCheckpoint = true;
          }
        }

        if (!foundCheckpoint && chronologicalActivities.length > 0) {
          const latest        = activities[0];
          const newCheckpoint = latest.transactionHash + "_" + latest.conditionId + "_" + latest.side;
          db.updateWalletProcessedState(wallet.address, newCheckpoint);
          continue;
        }

        for (const newTrade of newTradesToProcess) {
          const tradeId = newTrade.transactionHash + "_" + newTrade.conditionId + "_" + newTrade.side;
          try {
            // Advance checkpoint FIRST so skipped trades never replay
            db.updateWalletProcessedState(wallet.address, tradeId);
            await processCopiedTrade(wallet, newTrade);
            broadcast('wallet_updated', db.readDb());
          } catch (tradeErr) {
            db.addLog(`Trade copy failed for ${wallet.label}: ${tradeErr.message}`, 'error');
          }
        }

        if (newTradesToProcess.length === 0) {
          db.updateWalletProcessedState(wallet.address, wallet.lastProcessedTradeId);
        }

      } catch (walletErr) {
        db.addLog(`Error polling ${wallet.label}: ${walletErr.message}`, 'error');
      }
    }
  } catch (err) {
    db.addLog(`Bot cycle exception: ${err.message}`, 'error');
  } finally {
    isBotProcessing = false;
  }
}

function startCopyTradingBot() {
  if (botIntervalId) return;
  db.updateConfig({ isRunning: true });
  db.addLog("Copy trading bot engine STARTED.", "system");
  const intervalMs = parseInt(process.env.POLL_INTERVAL_MS) || 8000;
  runBotCycle();
  botIntervalId = setInterval(runBotCycle, intervalMs);
  broadcast('bot_started', db.readDb());
}

async function stopCopyTradingBot() {
  if (!botIntervalId) return;
  clearInterval(botIntervalId);
  botIntervalId = null;
  db.updateConfig({ isRunning: false });
  db.addLog("Copy trading bot engine PAUSED.", "system");
  await refreshLiveBalance();
  broadcast('bot_stopped', db.readDb());
}

function isBotActive() {
  return botIntervalId !== null;
}

async function _testInjectTrade(wallet, activity) {
  return processCopiedTrade(wallet, activity);
}

module.exports = {
  startCopyTradingBot,
  stopCopyTradingBot,
  isBotActive,
  setBroadcastCallback,
  refreshLiveBalance,
  _testInjectTrade
};