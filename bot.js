const ethers = require('ethers');
const db = require('./db');
const clob = require('./clob');
require('dotenv').config();

const USDCE_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

let botIntervalId = null;
let isBotProcessing = false;
let wsBroadcastCallback = null;

// Set up dynamic WS broadcasting callback
function setBroadcastCallback(callback) {
  wsBroadcastCallback = callback;
}

// Broadcast updates to front-end dashboard
function broadcast(type, data) {
  if (wsBroadcastCallback) {
    wsBroadcastCallback({ type, data });
  }
}

// Fetch on-chain USDC.e balance on Polygon
async function getTargetWalletUSDCBalance(address) {
  const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(USDCE_ADDRESS, ERC20_ABI, provider);
    const balance = await contract.balanceOf(address);
    const formatted = parseFloat(ethers.formatUnits(balance, 6));
    return formatted;
  } catch (err) {
    db.addLog(`Failed to query on-chain USDC balance for ${address}: ${err.message}. Defaulting to 0.`, 'warning');
    return 0;
  }
}

// Fetch target wallet portfolio value from Polymarket API
async function getTargetPortfolioValue(address, fallback = 0) {
  try {
    const url = `https://data-api.polymarket.com/value?user=${address}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      throw new Error(`Data API returned status ${res.status}`);
    }
    const data = await res.json();
    
    // API returns [{"user":"0x...", "value": 123.45}] or {"totalValue": 123.45}
    let rawVal = 0;
    if (Array.isArray(data) && data.length > 0) {
      rawVal = data[0].value !== undefined ? data[0].value : data[0].totalValue;
    } else if (data) {
      rawVal = data.value !== undefined ? data.value : data.totalValue;
    }
    const value = parseFloat(rawVal) || 0;
    return value;
  } catch (err) {
    db.addLog(`Failed to fetch portfolio value for ${address}: ${err.message}. Using fallback $${fallback}.`, 'warning');
    return fallback;
  }
}

// Fetch target wallet's current positions to determine sell percentages
async function getTargetPositionSize(address, conditionId, outcome) {
  try {
    const url = `https://data-api.polymarket.com/positions?user=${address}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Data API positions returned status ${res.status}`);
    }
    const positions = await res.json();
    
    // Find matching position by conditionId and outcome
    // We check both standard and nested fields for maximum API response resilience
    const match = positions.find(pos => 
      pos.conditionId?.toLowerCase() === conditionId?.toLowerCase() &&
      (pos.outcome?.toLowerCase() === outcome?.toLowerCase() || pos.token?.outcome?.toLowerCase() === outcome?.toLowerCase())
    );
    
    if (match) {
      const sizeVal = match.size !== undefined ? match.size : (match.position?.size !== undefined ? match.position.size : match.amount);
      return parseFloat(sizeVal) || 0;
    }
    return 0;
  } catch (err) {
    db.addLog(`Failed to fetch positions for ${address}: ${err.message}`, 'warning');
    return null; // Return null to indicate API error
  }
}

// Process a detected trade activity from a tracked wallet
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
    transactionHash
  } = activity;

  const targetTradeUSDC = parseFloat(targetUsdcSize) || 0;
  const price = parseFloat(executionPrice) || 0;
  const shares = parseFloat(targetShares) || 0;
  
  if (targetTradeUSDC <= 0 || price <= 0 || shares <= 0) {
    db.addLog(`Skipping trade for ${wallet.label}: Invalid size or price parameters.`, 'warning');
    return;
  }

  db.addLog(`[COPY SIGNAL] Detected ${side} trade by ${wallet.label} in "${marketTitle}" (${outcome}) at $${price.toFixed(2)}`, 'info');

  // Step 1: Calculate Target Portfolio Value
  // Use the trade size itself as a fallback floor so ratio math still works when the API is down
  const targetPositionsVal = await getTargetPortfolioValue(wallet.address, targetTradeUSDC * 10);
  const targetUsdcVal = await getTargetWalletUSDCBalance(wallet.address);
  let targetTotalPortfolio = targetPositionsVal + targetUsdcVal;
  
  // Guard against API lag where total portfolio is less than the trade itself
  if (targetTotalPortfolio < targetTradeUSDC) {
    targetTotalPortfolio = targetTradeUSDC * 1.05; 
  }
  
  // Step 2: Compute Proportional Ratio (R)
  const R = targetTradeUSDC / targetTotalPortfolio;
  db.addLog(`Target Total Value: $${targetTotalPortfolio.toFixed(2)} USDC | Target Trade Size: $${targetTradeUSDC.toFixed(2)} USDC | Allocation Ratio: ${(R * 100).toFixed(4)}%`, 'info');

  // Step 3: Compute Our Portfolio Value
  let ourTotalPortfolio = 0;
  let ourUsdcBalance = 0;
  
  if (isPaper) {
    ourUsdcBalance = currentDb.config.simulationBalance;
    const positionsValue = currentDb.openPositions.reduce((sum, pos) => sum + (pos.shares * pos.currentPrice), 0);
    ourTotalPortfolio = ourUsdcBalance + positionsValue;
  } else {
    // Live mode: Query our real wallet on-chain USDC balance
    const myAddress = process.env.POLYMARKET_PROXY_ADDRESS;
    if (myAddress && myAddress.startsWith('0x')) {
      ourUsdcBalance = await getTargetWalletUSDCBalance(myAddress);
      try {
        const myPositionsVal = await getTargetPortfolioValue(myAddress);
        ourTotalPortfolio = ourUsdcBalance + myPositionsVal;
      } catch (err) {
        ourTotalPortfolio = ourUsdcBalance;
      }
    } else {
      ourUsdcBalance = currentDb.config.realBalance || 0.0;
      ourTotalPortfolio = ourUsdcBalance;
    }
  }
  
  if (ourTotalPortfolio <= 0) {
    db.addLog(`Cannot copy trade: Our total portfolio value is $0.00.`, 'error');
    return;
  }

  // Step 4: Perform Proportional Sizing
  if (side === 'BUY') {
    // Scale trade size by target ratio * our portfolio * custom wallet multiplier
    let ourTradeSize = R * ourTotalPortfolio * wallet.multiplier;
    
    // Ensure we don't exceed our available cash balance
    if (ourTradeSize > ourUsdcBalance) {
      ourTradeSize = ourUsdcBalance;
    }
    
    // Enforce Polymarket minimum trade size of $1.00 USDC
    if (ourTradeSize < 1.0) {
      db.addLog(`Calculated buy size ($${ourTradeSize.toFixed(2)}) is below the $1.00 USDC minimum threshold. Skipping copy trade.`, 'warning');
      return;
    }

    const ourShares = ourTradeSize / price;

    db.addLog(`[CALCULATED BUY] Scaling trade: Target spent ${R.toFixed(4) * 100}% of portfolio. Our Port: $${ourTotalPortfolio.toFixed(2)} | Target: $${targetTotalPortfolio.toFixed(2)} | We will spend: $${ourTradeSize.toFixed(2)} USDC to buy ${ourShares.toFixed(2)} shares.`, 'info');

    if (isPaper) {
      // Execute paper trade
      const success = db.executeSimulatedTrade({
        trackedWallet: wallet.address,
        marketTitle,
        marketConditionId: conditionId,
        tokenID: conditionId + "_" + outcome.toLowerCase(), // Virtual tokenId
        outcome,
        side: 'BUY',
        executionPrice: price,
        shares: ourShares,
        ourTradeSize: ourTradeSize,
        targetTradeSize: targetTradeUSDC,
        targetPortfolioValue: targetTotalPortfolio
      });
      
      if (success) {
        broadcast('trade_executed', db.readDb());
      }
    } else {
      // Live Trading Execution (Requires Polymarket CLOB integration)
      db.addLog(`[LIVE MODE] Initiating live copy buy for ${ourShares.toFixed(2)} shares at $${price.toFixed(2)}...`, 'info');
      try {
        const orderResp = await clob.placeLiveOrder(conditionId, outcome, 'BUY', price, ourShares);
        db.addLog(`[LIVE SUCCESS] Order posted to book. Order ID: ${orderResp.orderID}`, 'success');
        
        // Record live trade locally to sync positions
        db.executeSimulatedTrade({
          trackedWallet: wallet.address,
          marketTitle,
          marketConditionId: conditionId,
          tokenID: conditionId + "_" + outcome.toLowerCase(),
          outcome,
          side: 'BUY',
          executionPrice: price,
          shares: ourShares,
          ourTradeSize: ourTradeSize,
          targetTradeSize: targetTradeUSDC,
          targetPortfolioValue: targetTotalPortfolio
        });
        broadcast('trade_executed', db.readDb());
      } catch (err) {
        db.addLog(`[LIVE ERROR] Live order failed: ${err.message}`, 'error');
      }
    }

  } else if (side === 'SELL') {
    // Exits are sized by percentage of target's position liquidated, ensuring synchronization!
    const targetRemainingShares = await getTargetPositionSize(wallet.address, conditionId, outcome);
    let sellFraction = 1.0; // Default to 100% exit if target position lookup fails or returns 0
    
    if (targetRemainingShares !== null && targetRemainingShares > 0) {
      const targetPreviousShares = targetRemainingShares + shares;
      sellFraction = shares / targetPreviousShares;
      if (sellFraction > 1.0) sellFraction = 1.0;
    } else if (targetRemainingShares === 0) {
      // Target fully exited their position
      sellFraction = 1.0;
    }
    
    db.addLog(`Target sold ${(sellFraction * 100).toFixed(2)}% of their active position shares (${shares.toFixed(2)} of ${(targetRemainingShares + shares).toFixed(2)} shares)`, 'info');

    // Retrieve our open position in this token
    const tokenID = conditionId + "_" + outcome.toLowerCase();
    const ourPosition = currentDb.openPositions.find(p => p.tokenID === tokenID);
    
    if (!ourPosition || ourPosition.shares <= 0) {
      db.addLog(`[SKIP SELL] Target sold shares of "${marketTitle}" (${outcome}), but we do not hold a position in this asset. Skipping.`, 'info');
      return;
    }

    const ourSharesToSell = ourPosition.shares * sellFraction;
    const ourEstimatedRevenue = ourSharesToSell * price;

    if (ourSharesToSell <= 0.05) {
      db.addLog(`Calculated sell size (${ourSharesToSell.toFixed(2)} shares) is too negligible. Skipping sell copy.`, 'warning');
      return;
    }

    db.addLog(`[CALCULATED SELL] Scaling sell: We hold ${ourPosition.shares.toFixed(2)} shares. We will sell ${ourSharesToSell.toFixed(2)} shares (${(sellFraction * 100).toFixed(2)}%) for an estimated $${ourEstimatedRevenue.toFixed(2)} USDC.`, 'info');

    if (isPaper) {
      const success = db.executeSimulatedTrade({
        trackedWallet: wallet.address,
        marketTitle,
        marketConditionId: conditionId,
        tokenID,
        outcome,
        side: 'SELL',
        executionPrice: price,
        shares: ourSharesToSell,
        ourTradeSize: ourEstimatedRevenue, // We store the revenue as the trade size for sells
        targetTradeSize: targetTradeUSDC,
        targetPortfolioValue: targetTotalPortfolio
      });
      
      if (success) {
        broadcast('trade_executed', db.readDb());
      }
    } else {
      // Live Trading Execution (Requires Polymarket CLOB integration)
      db.addLog(`[LIVE MODE] Initiating live copy sell for ${ourSharesToSell.toFixed(2)} shares at $${price.toFixed(2)}...`, 'info');
      try {
        const orderResp = await clob.placeLiveOrder(conditionId, outcome, 'SELL', price, ourSharesToSell);
        db.addLog(`[LIVE SUCCESS] Order posted to book. Order ID: ${orderResp.orderID}`, 'success');
        
        // Record live sell locally to sync positions
        db.executeSimulatedTrade({
          trackedWallet: wallet.address,
          marketTitle,
          marketConditionId: conditionId,
          tokenID,
          outcome,
          side: 'SELL',
          executionPrice: price,
          shares: ourSharesToSell,
          ourTradeSize: ourEstimatedRevenue,
          targetTradeSize: targetTradeUSDC,
          targetPortfolioValue: targetTotalPortfolio
        });
        broadcast('trade_executed', db.readDb());
      } catch (err) {
        db.addLog(`[LIVE ERROR] Live order failed: ${err.message}`, 'error');
      }
    }
  }
}

// Sync open position prices from Polymarket
async function syncPrices() {
  const currentDb = db.readDb();
  if (currentDb.openPositions.length === 0) return;
  
  const conditionIds = [...new Set(currentDb.openPositions.map(p => p.marketConditionId))];
  const priceUpdates = {};

  await Promise.all(conditionIds.map(async (cid) => {
    try {
      const url = `https://gamma-api.polymarket.com/markets?condition_id=${cid}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const markets = await res.json();
      if (!markets || markets.length === 0) return;
      
      const market = markets[0];
      let outcomes = market.outcomes;
      if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes);
      let outcomePrices = market.outcomePrices;
      if (typeof outcomePrices === 'string') outcomePrices = JSON.parse(outcomePrices);
      
      outcomes.forEach((out, idx) => {
        const tokenID = cid + "_" + out.toLowerCase();
        priceUpdates[tokenID] = parseFloat(outcomePrices[idx]);
      });
    } catch (err) {
      // ignore silently to not spam logs
    }
  }));

  const updated = db.updatePositionPrices(priceUpdates);
  if (updated) {
    broadcast('state_update', db.readDb());
  }
}

// Single step execution of the polling loop
async function runBotCycle() {
  if (isBotProcessing) return;
  isBotProcessing = true;

  try {
    await syncPrices();
    
    const currentDb = db.readDb();
    if (!currentDb.config.isRunning) {
      isBotProcessing = false;
      return;
    }

    const wallets = currentDb.trackedWallets;
    if (wallets.length === 0) {
      isBotProcessing = false;
      return;
    }

    // Process each wallet sequentially to avoid overloading RPC/APIs
    for (const wallet of wallets) {
      // db.addLog(`Polling wallet: ${wallet.label} (${wallet.address})...`, 'debug');
      
      try {
        const url = `https://data-api.polymarket.com/activity?user=${wallet.address}&type=TRADE&limit=5`;
        const pollController = new AbortController();
        const pollTimeout = setTimeout(() => pollController.abort(), 7000);
        const res = await fetch(url, { signal: pollController.signal });
        clearTimeout(pollTimeout);
        
        if (!res.ok) {
          db.addLog(`Failed to query Polymarket Data API for ${wallet.label}: HTTP ${res.status}`, 'warning');
          continue;
        }
        
        const activities = await res.json();
        
        if (!Array.isArray(activities) || activities.length === 0) {
          // Update checked timestamp and save
          db.updateWalletProcessedState(wallet.address, wallet.lastProcessedTradeId);
          continue;
        }

        // Sort chronologically (oldest first) so we process trades in exact order
        // Polymarket activity returns newest first, so we reverse it
        const chronologicalActivities = [...activities].reverse();

        // If this is the FIRST time we poll this wallet (lastProcessedTradeId is null)
        // initialize it with the ID of the latest trade so we do not copy historical actions!
        if (!wallet.lastProcessedTradeId) {
          const latestActivity = activities[0]; // Newest
          const initialId = latestActivity.transactionHash + "_" + latestActivity.conditionId + "_" + latestActivity.side;
          db.updateWalletProcessedState(wallet.address, initialId);
          db.addLog(`Initialized copy trading tracker for ${wallet.label}. Set checkpoint to latest trade: ${initialId}. Only subsequent trades will be copied.`, 'system');
          broadcast('wallet_updated', db.readDb());
          continue;
        }

        let foundCheckpoint = false;
        let newTradesToProcess = [];

        // Identify trades occurring after the last checkpoint
        for (const act of chronologicalActivities) {
          const currentTradeId = act.transactionHash + "_" + act.conditionId + "_" + act.side;
          
          if (foundCheckpoint) {
            newTradesToProcess.push(act);
          } else if (currentTradeId === wallet.lastProcessedTradeId) {
            foundCheckpoint = true;
          }
        }

        // If checkpoint was not found in the fetched window (e.g. they traded a lot since we last checked)
        // fallback to processing the most recent trade, or clear the queue
        if (!foundCheckpoint && chronologicalActivities.length > 0) {
          // For safety, let's establish a new checkpoint and process only the single newest trade
          const latestActivity = activities[0]; // Newest
          const newCheckpoint = latestActivity.transactionHash + "_" + latestActivity.conditionId + "_" + latestActivity.side;
          db.updateWalletProcessedState(wallet.address, newCheckpoint);
          db.addLog(`Checkpoint lost for ${wallet.label} (too many transactions since last poll). Established new checkpoint at: ${newCheckpoint}.`, 'warning');
          broadcast('wallet_updated', db.readDb());
          continue;
        }

        // Execute copy trades in sequential order
        for (const newTrade of newTradesToProcess) {
          const tradeId = newTrade.transactionHash + "_" + newTrade.conditionId + "_" + newTrade.side;
          
          try {
            await processCopiedTrade(wallet, newTrade);
            // Update checkpoint *immediately* after a trade to prevent double-processing on failure
            db.updateWalletProcessedState(wallet.address, tradeId);
            broadcast('wallet_updated', db.readDb());
          } catch (tradeErr) {
            db.addLog(`Failed to copy trade ${tradeId} for ${wallet.label}: ${tradeErr.message}`, 'error');
          }
        }

        // If there were no new trades, still update last checked timestamp
        if (newTradesToProcess.length === 0) {
          db.updateWalletProcessedState(wallet.address, wallet.lastProcessedTradeId);
        }

      } catch (walletErr) {
        db.addLog(`Error polling ${wallet.label}: ${walletErr.message}`, 'error');
      }
    }
  } catch (err) {
    db.addLog(`Copy trading cycle exception: ${err.message}`, 'error');
  } finally {
    isBotProcessing = false;
  }
}

// Start the copy trading bot scheduler
function startCopyTradingBot() {
  if (botIntervalId) return;
  
  const currentDb = db.readDb();
  db.updateConfig({ isRunning: true });
  db.addLog("Copy trading bot engine STARTED.", "system");
  
  const intervalMs = parseInt(process.env.POLL_INTERVAL_MS) || 8000;
  
  // Run instantly on startup
  runBotCycle();
  
  // Schedule recurring polls
  botIntervalId = setInterval(runBotCycle, intervalMs);
  broadcast('bot_started', db.readDb());
}

// Stop the copy trading bot scheduler
function stopCopyTradingBot() {
  if (!botIntervalId) return;
  
  clearInterval(botIntervalId);
  botIntervalId = null;
  
  db.updateConfig({ isRunning: false });
  db.addLog("Copy trading bot engine PAUSED.", "system");
  broadcast('bot_stopped', db.readDb());
}

// Check if bot is active
function isBotActive() {
  return botIntervalId !== null;
}

// Exposed for test injection via /api/test/inject-trade
async function _testInjectTrade(wallet, activity) {
  return processCopiedTrade(wallet, activity);
}

module.exports = {
  startCopyTradingBot,
  stopCopyTradingBot,
  isBotActive,
  setBroadcastCallback,
  _testInjectTrade
};
