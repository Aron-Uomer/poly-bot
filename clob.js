const db = require('./db');
require('dotenv').config();

// We dynamic import viem and clob-client-v2 because they might be installed as ES modules
let ClobClient = null;
let Side = null;
let OrderType = null;
let Chain = null;
let createWalletClient = null;
let http = null;
let privateKeyToAccount = null;

// Initialize CLOB client packages dynamically
async function initClobClient() {
  if (ClobClient) return true;
  
  try {
    const clobModule = await import('@polymarket/clob-client-v2');
    const viemAccountsModule = await import('viem/accounts');
    const viemModule = await import('viem');
    
    ClobClient = clobModule.ClobClient;
    Side = clobModule.Side;
    OrderType = clobModule.OrderType;
    Chain = clobModule.Chain;
    
    createWalletClient = viemModule.createWalletClient;
    http = viemModule.http;
    privateKeyToAccount = viemAccountsModule.privateKeyToAccount;
    return true;
  } catch (err) {
    db.addLog(`Failed to load @polymarket/clob-client-v2 or viem: ${err.message}. Live trading unavailable.`, 'error');
    return false;
  }
}

// Helper to resolve conditionId + outcome name to the official Polymarket CLOB tokenId
async function getClobTokenId(conditionId, outcomeName) {
  try {
    const url = `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Gamma API returned status ${res.status}`);
    }
    const markets = await res.json();
    
    if (!Array.isArray(markets) || markets.length === 0) {
      throw new Error(`No markets found in Gamma for conditionId ${conditionId}`);
    }
    
    const market = markets[0];
    
    // Parse clobTokenIds. It can be a stringified JSON array or a direct array
    let tokenIds = market.clobTokenIds;
    if (typeof tokenIds === 'string') {
      tokenIds = JSON.parse(tokenIds);
    }
    
    // Parse outcomes array
    let outcomes = market.outcomes;
    if (typeof outcomes === 'string') {
      outcomes = JSON.parse(outcomes);
    }
    
    if (!tokenIds || tokenIds.length === 0) {
      throw new Error(`Market has no clobTokenIds defined`);
    }
    
    // Find the index of the outcome (Yes/No) case-insensitive
    const targetIdx = outcomes.findIndex(out => out.toLowerCase() === outcomeName.toLowerCase());
    
    if (targetIdx === -1) {
      db.addLog(`Outcome "${outcomeName}" not explicitly found in market outcomes [${outcomes.join(', ')}]. Defaulting to index 0.`, 'warning');
      return tokenIds[0];
    }
    
    const tokenId = tokenIds[targetIdx];
    db.addLog(`Resolved outcome "${outcomeName}" in market "${market.title}" to CLOB TokenID: ${tokenId}`, 'info');
    return tokenId;
  } catch (err) {
    db.addLog(`Failed to resolve CLOB Token ID via Gamma API: ${err.message}`, 'error');
    return null;
  }
}

// Place a live order on Polymarket CLOB
async function placeLiveOrder(conditionId, outcomeName, side, price, size) {
  const initialized = await initClobClient();
  if (!initialized) {
    throw new Error("CLOB SDK packages not initialized.");
  }

  const pKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pKey || pKey.trim() === '') {
    throw new Error("POLYMARKET_PRIVATE_KEY missing in .env. Cannot execute live trades.");
  }

  // 1. Resolve Gamma Token ID
  const tokenId = await getClobTokenId(conditionId, outcomeName);
  if (!tokenId) {
    throw new Error(`Could not resolve CLOB Token ID for condition ${conditionId} and outcome ${outcomeName}`);
  }

  // 2. Set up viem wallet client
  const formattedKey = pKey.startsWith('0x') ? pKey : `0x${pKey}`;
  const account = privateKeyToAccount(formattedKey);
  const walletClient = createWalletClient({
    account,
    transport: http(process.env.POLYGON_RPC_URL || "https://polygon-rpc.com")
  });

  const host = "https://clob.polymarket.com";
  
  db.addLog(`Authenticating with Polymarket CLOB API at ${host}...`, 'info');
  
  // 3. Initialize authenticated CLOB client
  let client;
  try {
    // Check if we have pre-defined API keys in env
    const hasApiKeys = process.env.CLOB_API_KEY && process.env.CLOB_API_SECRET && process.env.CLOB_API_PASSPHRASE;
    
    if (hasApiKeys) {
      // Use existing credentials
      client = new ClobClient({
        host,
        chain: Chain.POLYGON,
        signer: walletClient,
        creds: {
          key: process.env.CLOB_API_KEY,
          secret: process.env.CLOB_API_SECRET,
          passphrase: process.env.CLOB_API_PASSPHRASE
        }
      });
    } else {
      // Derive/Create credentials on the fly using L1 signature
      db.addLog("API credentials not found in .env. Deriving new keys via EIP-712 wallet signature...", 'info');
      const baseClient = new ClobClient({
        host,
        chain: Chain.POLYGON,
        signer: walletClient
      });
      const creds = await baseClient.createOrDeriveApiKey();
      
      // Save credentials into active client
      client = new ClobClient({
        host,
        chain: Chain.POLYGON,
        signer: walletClient,
        creds
      });
      
      db.addLog(`Successfully derived Polymarket API credentials! Key: ${creds.key.substring(0, 8)}...`, 'success');
      db.addLog("Tip: Copy these credentials to your .env to skip EIP-712 signing on subsequent runs!", 'info');
      db.addLog(`CLOB_API_KEY=${creds.key}\nCLOB_API_SECRET=${creds.secret}\nCLOB_API_PASSPHRASE=${creds.passphrase}`, 'debug');
    }
  } catch (authErr) {
    db.addLog(`CLOB Authentication failed: ${authErr.message}`, 'error');
    throw authErr;
  }

  // 4. Round values to valid tick sizes (Polymarket price ticks are 0.01)
  const roundedPrice = parseFloat(price.toFixed(2));
  const roundedSize = parseFloat(size.toFixed(2)); // Round size as required

  if (roundedPrice <= 0 || roundedSize <= 0) {
    throw new Error(`Invalid order sizing post rounding. Price: ${roundedPrice}, Size: ${roundedSize}`);
  }

  const orderSide = side === 'BUY' ? Side.BUY : Side.SELL;

  db.addLog(`Submitting live GTC Limit ${side} order to CLOB: ${roundedSize} shares at $${roundedPrice.toFixed(2)}`, 'info');

  try {
    const response = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: roundedPrice,
        side: orderSide,
        size: roundedSize,
      },
      { tickSize: "0.01" },
      OrderType.GTC
    );
    
    if (response && response.success) {
      db.addLog(`[LIVE SUCCESS] Order posted successfully! Order ID: ${response.orderID}`, 'success');
      return response;
    } else {
      const errMsg = response?.errorMsg || JSON.stringify(response);
      throw new Error(`CLOB execution error: ${errMsg}`);
    }
  } catch (orderErr) {
    db.addLog(`Failed to post order to CLOB book: ${orderErr.message}`, 'error');
    throw orderErr;
  }
}

module.exports = {
  placeLiveOrder,
  getClobTokenId
};
