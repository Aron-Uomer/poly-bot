const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracked_wallets (
      address                  TEXT PRIMARY KEY,
      label                    TEXT NOT NULL,
      multiplier               NUMERIC(10, 4) NOT NULL DEFAULT 1.0,
      added_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_checked             TIMESTAMPTZ,
      last_processed_trade_id  TEXT
    );

    CREATE TABLE IF NOT EXISTS open_positions (
      id                  TEXT PRIMARY KEY,
      market_condition_id TEXT,
      market_title        TEXT,
      outcome             TEXT,
      token_id            TEXT UNIQUE NOT NULL,
      shares              NUMERIC(20, 8) NOT NULL DEFAULT 0,
      avg_price_paid      NUMERIC(20, 8) NOT NULL DEFAULT 0,
      current_price       NUMERIC(20, 8) NOT NULL DEFAULT 0,
      value               NUMERIC(20, 8) NOT NULL DEFAULT 0,
      unrealized_pnl      NUMERIC(20, 8) NOT NULL DEFAULT 0,
      tracked_wallet      TEXT
    );

    CREATE TABLE IF NOT EXISTS trade_history (
      id                     TEXT PRIMARY KEY,
      timestamp              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tracked_wallet         TEXT,
      tracked_wallet_label   TEXT,
      market_title           TEXT,
      outcome                TEXT,
      side                   TEXT,
      target_trade_size      NUMERIC(20, 8),
      target_portfolio_value NUMERIC(20, 8),
      our_trade_size         NUMERIC(20, 8),
      execution_price        NUMERIC(20, 8),
      shares                 NUMERIC(20, 8),
      mode                   TEXT,
      status                 TEXT,
      realized_pnl           NUMERIC(20, 8),
      revenue                NUMERIC(20, 8)
    );
  `);

  await pool.query(`
    INSERT INTO config (key, value) VALUES
      ('isRunning',                 'true'),
      ('paperTrading',              'true'),
      ('simulationBalance',         '1000.0'),
      ('simulationStartingBalance', '1000.0'),
      ('realBalance',               '0.0'),
      ('realBalanceManual',         'false'),
      ('totalRealizedPnL',          '0.0')
    ON CONFLICT (key) DO NOTHING;
  `);
}

// Assemble full state object — mirrors the old readDb() shape
async function readDb() {
  const [cfgRes, walletsRes, posRes, histRes] = await Promise.all([
    pool.query('SELECT key, value FROM config'),
    pool.query('SELECT * FROM tracked_wallets ORDER BY added_at ASC'),
    pool.query('SELECT * FROM open_positions'),
    pool.query('SELECT * FROM trade_history ORDER BY timestamp DESC LIMIT 200'),
  ]);

  const config = Object.fromEntries(cfgRes.rows.map(r => [r.key, r.value]));

  const trackedWallets = walletsRes.rows.map(w => ({
    address:               w.address,
    label:                 w.label,
    multiplier:            parseFloat(w.multiplier),
    addedAt:               w.added_at,
    lastChecked:           w.last_checked,
    lastProcessedTradeId:  w.last_processed_trade_id
  }));

  const openPositions = posRes.rows.map(p => ({
    id:                 p.id,
    marketConditionId:  p.market_condition_id,
    marketTitle:        p.market_title,
    outcome:            p.outcome,
    tokenID:            p.token_id,
    shares:             parseFloat(p.shares),
    avgPricePaid:       parseFloat(p.avg_price_paid),
    currentPrice:       parseFloat(p.current_price),
    value:              parseFloat(p.value),
    unrealizedPnL:      parseFloat(p.unrealized_pnl),
    trackedWallet:      p.tracked_wallet
  }));

  const tradeHistory = histRes.rows.map(t => ({
    id:                   t.id,
    timestamp:            t.timestamp,
    trackedWallet:        t.tracked_wallet,
    trackedWalletLabel:   t.tracked_wallet_label,
    marketTitle:          t.market_title,
    outcome:              t.outcome,
    side:                 t.side,
    targetTradeSize:      parseFloat(t.target_trade_size),
    targetPortfolioValue: parseFloat(t.target_portfolio_value),
    ourTradeSize:         parseFloat(t.our_trade_size),
    executionPrice:       parseFloat(t.execution_price),
    shares:               parseFloat(t.shares),
    mode:                 t.mode,
    status:               t.status,
    realizedPnL:          t.realized_pnl !== null ? parseFloat(t.realized_pnl) : null,
    revenue:              t.revenue !== null ? parseFloat(t.revenue) : null
  }));

  return { config, trackedWallets, openPositions, tradeHistory, livePositions: [] };
}

function addLog(message, type = 'info') {
  console.log(`[${type.toUpperCase()}] ${message}`);
  return { timestamp: new Date().toISOString(), message, type };
}

async function updateConfig(newConfig) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(newConfig)) {
      await client.query(
        `INSERT INTO config (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function addTrackedWallet(address, label, multiplier = 1.0) {
  const normalizedAddress = address.trim().toLowerCase();

  if (!normalizedAddress.startsWith('0x') || normalizedAddress.length !== 42) {
    addLog(`Failed to add wallet: Invalid address format "${address}"`, 'error');
    throw new Error('Invalid wallet address. Must be a 42-character hex string starting with 0x.');
  }

  const { rows } = await pool.query(
    'SELECT * FROM tracked_wallets WHERE address = $1',
    [normalizedAddress]
  );
  if (rows.length) {
    addLog(`Wallet already tracked: ${normalizedAddress}`, 'warning');
    return {
      address: rows[0].address,
      label: rows[0].label,
      multiplier: parseFloat(rows[0].multiplier),
      addedAt: rows[0].added_at,
      lastChecked: rows[0].last_checked,
      lastProcessedTradeId: rows[0].last_processed_trade_id
    };
  }

  const walletLabel = label || `Tracked Wallet ${normalizedAddress.substring(0, 6)}`;
  const { rows: inserted } = await pool.query(
    `INSERT INTO tracked_wallets (address, label, multiplier)
     VALUES ($1, $2, $3) RETURNING *`,
    [normalizedAddress, walletLabel, parseFloat(multiplier) || 1.0]
  );

  addLog(`Successfully added wallet: ${walletLabel} (${normalizedAddress})`, 'system');
  return {
    address:              inserted[0].address,
    label:                inserted[0].label,
    multiplier:           parseFloat(inserted[0].multiplier),
    addedAt:              inserted[0].added_at,
    lastChecked:          inserted[0].last_checked,
    lastProcessedTradeId: inserted[0].last_processed_trade_id
  };
}

async function removeTrackedWallet(address) {
  const normalizedAddress = address.trim().toLowerCase();
  const { rowCount } = await pool.query(
    'DELETE FROM tracked_wallets WHERE address = $1',
    [normalizedAddress]
  );
  if (rowCount === 0) {
    addLog(`Wallet not found for deletion: ${normalizedAddress}`, 'warning');
    return false;
  }
  addLog(`Successfully removed wallet: ${normalizedAddress}`, 'system');
  return true;
}

async function updateWalletProcessedState(address, lastProcessedTradeId) {
  const normalizedAddress = address.trim().toLowerCase();
  await pool.query(
    `UPDATE tracked_wallets
     SET last_processed_trade_id = $1, last_checked = NOW()
     WHERE address = $2`,
    [lastProcessedTradeId, normalizedAddress]
  );
}

async function executeSimulatedTrade(trade) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cfgRes = await client.query('SELECT key, value FROM config');
    const cfg = Object.fromEntries(cfgRes.rows.map(r => [r.key, r.value]));
    const isPaper = cfg.paperTrading === true || cfg.paperTrading === 'true';

    const {
      trackedWallet, marketTitle, marketConditionId,
      tokenID, outcome, side, executionPrice, shares, ourTradeSize
    } = trade;

    const cost       = parseFloat(ourTradeSize);
    const shareCount = parseFloat(shares);
    const price      = parseFloat(executionPrice);

    let tradeRealizedPnL = null;
    let tradeRevenue     = null;

    if (isPaper) {
      let simBalance = parseFloat(cfg.simulationBalance);

      if (side === 'BUY') {
        if (simBalance < cost) {
          addLog(`[SIM] Insufficient balance: need $${cost.toFixed(2)}, have $${simBalance.toFixed(2)}`, 'error');
          await client.query('ROLLBACK');
          return false;
        }

        simBalance -= cost;

        const posRes = await client.query(
          'SELECT * FROM open_positions WHERE token_id = $1 FOR UPDATE', [tokenID]
        );

        if (posRes.rows.length === 0) {
          const posId = `pos_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          await client.query(
            `INSERT INTO open_positions
               (id, market_condition_id, market_title, outcome, token_id,
                shares, avg_price_paid, current_price, value, unrealized_pnl, tracked_wallet)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [posId, marketConditionId, marketTitle, outcome, tokenID,
             shareCount, price, price, shareCount * price,
             shareCount * price - cost, trackedWallet]
          );
        } else {
          const pos      = posRes.rows[0];
          const prevShares = parseFloat(pos.shares);
          const prevAvg    = parseFloat(pos.avg_price_paid);
          const totalShares    = prevShares + shareCount;
          const totalCostBasis = prevShares * prevAvg + cost;
          const newAvg         = totalCostBasis / totalShares;
          const newValue       = totalShares * price;
          const newUnrealized  = newValue - totalCostBasis;
          await client.query(
            `UPDATE open_positions
             SET shares=$1, avg_price_paid=$2, current_price=$3, value=$4, unrealized_pnl=$5
             WHERE token_id=$6`,
            [totalShares, newAvg, price, newValue, newUnrealized, tokenID]
          );
        }

        await setConfigNumTx(client, 'simulationBalance', simBalance);

      } else if (side === 'SELL') {
        const posRes = await client.query(
          'SELECT * FROM open_positions WHERE token_id = $1 FOR UPDATE', [tokenID]
        );

        if (posRes.rows.length === 0 || parseFloat(posRes.rows[0].shares) <= 0) {
          addLog(`[SIM] No open position to sell for "${marketTitle}"`, 'warning');
          await client.query('ROLLBACK');
          return false;
        }

        const pos        = posRes.rows[0];
        const sellShares = Math.min(parseFloat(pos.shares), shareCount);
        const revenue    = sellShares * price;
        const costBasisReleased = sellShares * parseFloat(pos.avg_price_paid);
        const realizedPnL = revenue - costBasisReleased;

        tradeRealizedPnL = realizedPnL;
        tradeRevenue     = revenue;

        const totalRealizedPnL = parseFloat(cfg.totalRealizedPnL || 0) + realizedPnL;
        simBalance += revenue;

        await setConfigNumTx(client, 'simulationBalance', simBalance);
        await setConfigNumTx(client, 'totalRealizedPnL', totalRealizedPnL);

        const remainingShares = parseFloat(pos.shares) - sellShares;
        if (remainingShares <= 0.01) {
          await client.query('DELETE FROM open_positions WHERE token_id = $1', [tokenID]);
        } else {
          const newValue      = remainingShares * price;
          const newUnrealized = remainingShares * (price - parseFloat(pos.avg_price_paid));
          await client.query(
            `UPDATE open_positions
             SET shares=$1, current_price=$2, value=$3, unrealized_pnl=$4
             WHERE token_id=$5`,
            [remainingShares, price, newValue, newUnrealized, tokenID]
          );
        }
      }
    }

    const walletRes = await client.query(
      'SELECT label FROM tracked_wallets WHERE address = $1', [trackedWallet]
    );
    const walletLabel = walletRes.rows[0]?.label || 'Unknown Wallet';

    const tradeId = `trd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await client.query(
      `INSERT INTO trade_history
         (id, timestamp, tracked_wallet, tracked_wallet_label, market_title,
          outcome, side, target_trade_size, target_portfolio_value, our_trade_size,
          execution_price, shares, mode, status, realized_pnl, revenue)
       VALUES ($1,NOW(),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [tradeId, trackedWallet, walletLabel, marketTitle, outcome, side,
       trade.targetTradeSize ?? null, trade.targetPortfolioValue ?? null,
       cost, price, shareCount,
       isPaper ? 'PAPER' : 'LIVE', 'SUCCESS',
       tradeRealizedPnL, tradeRevenue]
    );

    await client.query(`
      DELETE FROM trade_history
      WHERE id IN (
        SELECT id FROM trade_history ORDER BY timestamp DESC OFFSET 200
      )
    `);

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    addLog(`executeSimulatedTrade failed: ${err.message}`, 'error');
    throw err;
  } finally {
    client.release();
  }
}

async function resetSimulation() {
  const startingVal = parseFloat(process.env.SIMULATION_STARTING_BALANCE) || 1000.0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setConfigNumTx(client, 'simulationBalance', startingVal);
    await setConfigNumTx(client, 'simulationStartingBalance', startingVal);
    await setConfigNumTx(client, 'totalRealizedPnL', 0.0);
    await client.query('DELETE FROM open_positions');
    await client.query('DELETE FROM trade_history');
    await client.query('COMMIT');
    addLog('Simulation reset. Balance restored, positions and history wiped.', 'system');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updatePositionPrices(priceUpdates) {
  const entries = Object.entries(priceUpdates);
  if (!entries.length) return false;

  const client = await pool.connect();
  let updated = false;
  try {
    await client.query('BEGIN');
    for (const [tokenID, newPrice] of entries) {
      const res = await client.query(
        'SELECT shares, avg_price_paid, current_price FROM open_positions WHERE token_id = $1 FOR UPDATE',
        [tokenID]
      );
      if (!res.rows.length) continue;
      const pos = res.rows[0];
      if (parseFloat(pos.current_price) === newPrice) continue;
      const shares        = parseFloat(pos.shares);
      const newValue      = shares * newPrice;
      const newUnrealized = newValue - shares * parseFloat(pos.avg_price_paid);
      await client.query(
        `UPDATE open_positions
         SET current_price=$1, value=$2, unrealized_pnl=$3
         WHERE token_id=$4`,
        [newPrice, newValue, newUnrealized, tokenID]
      );
      updated = true;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return updated;
}

async function setConfigNumTx(client, key, num) {
  await client.query(
    `INSERT INTO config (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(num)]
  );
}

module.exports = {
  initDb,
  readDb,
  addLog,
  updateConfig,
  addTrackedWallet,
  removeTrackedWallet,
  updateWalletProcessedState,
  executeSimulatedTrade,
  resetSimulation,
  updatePositionPrices
};