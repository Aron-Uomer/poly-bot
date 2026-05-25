const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

// Initialize database with default template if not exists
function initDb() {
  if (!fs.existsSync(DB_PATH)) {
    const defaultTemplate = {
      config: {
        isRunning: true,
        paperTrading: true,
        simulationBalance: 1000.0,
        simulationStartingBalance: 1000.0,
        realBalance: 0.0,
        totalRealizedPnL: 0.0
      },
      trackedWallets: [
        {
          address: "0xd3c9f52fde3ad0d7f573efb1c09b8b3dbef72990",
          label: "Whale Alpha (Elections)",
          multiplier: 1.0,
          addedAt: new Date().toISOString(),
          lastChecked: null,
          lastProcessedTradeId: null
        },
        {
          address: "0x534e3a479ff73a9e334df9c252ef7806509618a8",
          label: "Whale Beta (Macro/Crypto)",
          multiplier: 1.0,
          addedAt: new Date().toISOString(),
          lastChecked: null,
          lastProcessedTradeId: null
        }
      ],
      openPositions: [],
      tradeHistory: [],
      logs: []
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultTemplate, null, 2), 'utf-8');
  }
}

// Read database
function readDb() {
  initDb();
  try {
    const data = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error("Error reading database:", err);
    // If corruption occurs, return a blank template
    return { config: {}, trackedWallets: [], openPositions: [], tradeHistory: [], logs: [] };
  }
}

// Save database
function saveDb(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error("Error writing database:", err);
    return false;
  }
}

// Log message helper
function addLog(message, type = 'info') {
  const db = readDb();
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, message, type };
  
  db.logs.push(logEntry);
  
  // Keep only the last 150 log entries
  if (db.logs.length > 150) {
    db.logs.shift();
  }
  
  saveDb(db);
  console.log(`[${type.toUpperCase()}] ${message}`);
  return logEntry;
}

// Update database config
function updateConfig(newConfig) {
  const db = readDb();
  db.config = { ...db.config, ...newConfig };
  saveDb(db);
  addLog(`Configuration updated: ${JSON.stringify(newConfig)}`, 'system');
}

// Track/Add new wallet
function addTrackedWallet(address, label, multiplier = 1.0) {
  const db = readDb();
  const normalizedAddress = address.trim().toLowerCase();
  
  if (!normalizedAddress.startsWith('0x') || normalizedAddress.length !== 42) {
    addLog(`Failed to add wallet: Invalid address format "${address}"`, 'error');
    throw new Error("Invalid wallet address. Must be a 42-character Hex string starting with 0x.");
  }
  
  const existing = db.trackedWallets.find(w => w.address === normalizedAddress);
  if (existing) {
    addLog(`Wallet already tracked: ${normalizedAddress}`, 'warning');
    return existing;
  }
  
  const newWallet = {
    address: normalizedAddress,
    label: label || `Tracked Wallet ${normalizedAddress.substring(0, 6)}`,
    multiplier: parseFloat(multiplier) || 1.0,
    addedAt: new Date().toISOString(),
    lastChecked: null,
    lastProcessedTradeId: null
  };
  
  db.trackedWallets.push(newWallet);
  saveDb(db);
  addLog(`Successfully added wallet: ${newWallet.label} (${newWallet.address})`, 'system');
  return newWallet;
}

// Remove tracked wallet
function removeTrackedWallet(address) {
  const db = readDb();
  const normalizedAddress = address.trim().toLowerCase();
  
  const initialLength = db.trackedWallets.length;
  db.trackedWallets = db.trackedWallets.filter(w => w.address !== normalizedAddress);
  
  if (db.trackedWallets.length === initialLength) {
    addLog(`Wallet not found for deletion: ${normalizedAddress}`, 'warning');
    return false;
  }
  
  saveDb(db);
  addLog(`Successfully removed wallet: ${normalizedAddress}`, 'system');
  return true;
}

// Update a specific wallet's last processed state
function updateWalletProcessedState(address, lastProcessedTradeId) {
  const db = readDb();
  const normalizedAddress = address.trim().toLowerCase();
  const wallet = db.trackedWallets.find(w => w.address === normalizedAddress);
  
  if (wallet) {
    wallet.lastProcessedTradeId = lastProcessedTradeId;
    wallet.lastChecked = new Date().toISOString();
    saveDb(db);
  }
}

// Execute a paper/simulation trade and update balances and positions
function executeSimulatedTrade(trade) {
  const db = readDb();
  const isPaper = db.config.paperTrading;
  
  if (!isPaper) {
    addLog("Real trading not implemented, skipping simulated execution logic.", "warning");
    return false;
  }
  
  const { 
    trackedWallet, 
    marketTitle, 
    marketConditionId,
    tokenID, 
    outcome, 
    side, 
    executionPrice, 
    shares, 
    ourTradeSize 
  } = trade;

  const cost = parseFloat(ourTradeSize); // USDC amount spent
  const shareCount = parseFloat(shares);
  const price = parseFloat(executionPrice);
  
  // Declare PnL tracking variables before the BUY/SELL branches
  // so they are guaranteed to be populated when the tradeRecord is built.
  let tradeRealizedPnL = null;
  let tradeRevenue = null;
  
  if (side === 'BUY') {
    // Check if we have enough simulated balance
    if (db.config.simulationBalance < cost) {
      addLog(`[SIM] Insufficient virtual balance to execute buy of ${shareCount} shares (${cost.toFixed(2)} USDC requested, ${db.config.simulationBalance.toFixed(2)} USDC available)`, 'error');
      return false;
    }
    
    // Deduct from simulated balance
    db.config.simulationBalance -= cost;
    
    // Check if we already have a position in this specific token ID
    let position = db.openPositions.find(p => p.tokenID === tokenID);
    if (!position) {
      position = {
        id: `pos_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        marketConditionId,
        marketTitle,
        outcome,
        tokenID,
        shares: 0,
        avgPricePaid: 0,
        currentPrice: price,
        value: 0,
        unrealizedPnL: 0,
        trackedWallet
      };
      db.openPositions.push(position);
    }
    
    // Calculate new average price and update share count
    const totalShares = position.shares + shareCount;
    const totalCostBasis = (position.shares * position.avgPricePaid) + cost;
    position.avgPricePaid = totalCostBasis / totalShares;
    position.shares = totalShares;
    position.currentPrice = price;
    position.value = totalShares * price;
    position.unrealizedPnL = position.value - totalCostBasis;
    
    addLog(`[SIM SUCCESS] Bought ${shareCount.toFixed(2)} shares of "${marketTitle}" (${outcome}) at $${price.toFixed(2)} each. Cost: $${cost.toFixed(2)} USDC.`, 'success');
  } else if (side === 'SELL') {
    // Check if we hold a position in this token
    let position = db.openPositions.find(p => p.tokenID === tokenID);
    if (!position || position.shares <= 0) {
      addLog(`[SIM] Attempted to copy SELL trade of "${marketTitle}" (${outcome}), but we do not hold an open position!`, 'warning');
      return false;
    }
    
    // How many shares are we selling?
    // In our copy engine, shares sold is a percentage of our existing shares
    const sellShares = Math.min(position.shares, shareCount);
    const revenue = sellShares * price;
    const costBasisReleased = sellShares * position.avgPricePaid;
    const realizedPnL = revenue - costBasisReleased;
    
    // Capture PnL values for the trade history record
    tradeRealizedPnL = realizedPnL;
    tradeRevenue = revenue;
    
    // Accumulate into the persistent running total
    if (typeof db.config.totalRealizedPnL !== 'number') db.config.totalRealizedPnL = 0;
    db.config.totalRealizedPnL += realizedPnL;
    
    // Add revenue back to simulated balance
    db.config.simulationBalance += revenue;
    
    // Update position
    position.shares -= sellShares;
    position.value = position.shares * price;
    position.unrealizedPnL = position.shares * (price - position.avgPricePaid);
    
    const pnlSign = realizedPnL >= 0 ? '+' : '';
    addLog(`[SIM SUCCESS] Sold ${sellShares.toFixed(2)} shares of "${marketTitle}" (${outcome}) at $${price.toFixed(2)} each. Received: $${revenue.toFixed(2)} USDC. Realized PnL: ${pnlSign}$${realizedPnL.toFixed(2)} USDC.`, 'success');
    
    // Clean up empty position
    if (position.shares <= 0.01) {
      db.openPositions = db.openPositions.filter(p => p.tokenID !== tokenID);
      addLog(`[SIM] Position in "${marketTitle}" (${outcome}) fully closed.`, 'info');
    }
  }
  
  // Record trade in history — built AFTER the BUY/SELL blocks so all
  // computed values (tradeRealizedPnL, tradeRevenue) are already populated.
  const tradeRecord = {
    id: `trd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    trackedWallet,
    trackedWalletLabel: db.trackedWallets.find(w => w.address === trackedWallet)?.label || "Unknown Wallet",
    marketTitle,
    outcome,
    side,
    targetTradeSize: trade.targetTradeSize,
    targetPortfolioValue: trade.targetPortfolioValue,
    ourTradeSize: cost,
    executionPrice: price,
    shares: shareCount,
    mode: "PAPER",
    status: "SUCCESS",
    // Realized P&L is only available on SELL trades
    realizedPnL: tradeRealizedPnL,
    revenue: tradeRevenue
  };
  
  db.tradeHistory.unshift(tradeRecord);
  
  // Limit trade history to 200 records
  if (db.tradeHistory.length > 200) {
    db.tradeHistory.pop();
  }
  
  saveDb(db);
  return true;
}

// Reset paper trading balance and positions to initial state
function resetSimulation() {
  const db = readDb();
  const startingVal = parseFloat(process.env.SIMULATION_STARTING_BALANCE) || 1000.0;
  db.config.simulationBalance = startingVal;
  db.config.simulationStartingBalance = startingVal;
  db.config.totalRealizedPnL = 0.0;
  db.openPositions = [];
  db.tradeHistory = [];
  
  saveDb(db);
  addLog("Simulation state reset successfully. Balance restored, all positions and history wiped.", "system");
}

function updatePositionPrices(priceUpdates) {
  const db = readDb();
  let updated = false;
  
  for (const pos of db.openPositions) {
    if (priceUpdates[pos.tokenID] !== undefined) {
      const newPrice = priceUpdates[pos.tokenID];
      if (pos.currentPrice !== newPrice) {
        pos.currentPrice = newPrice;
        pos.value = pos.shares * newPrice;
        pos.unrealizedPnL = pos.value - (pos.shares * pos.avgPricePaid);
        updated = true;
      }
    }
  }
  
  if (updated) {
    saveDb(db);
  }
  return updated;
}

module.exports = {
  readDb,
  saveDb,
  addLog,
  updateConfig,
  addTrackedWallet,
  removeTrackedWallet,
  updateWalletProcessedState,
  executeSimulatedTrade,
  resetSimulation,
  updatePositionPrices
};
