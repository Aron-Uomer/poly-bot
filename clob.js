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
let mnemonicToAccount = null;
let cachedSignatureType = null;
let patched = false;

// Initialize CLOB client packages dynamically
async function initClobClient() {
  if (ClobClient && patched) return true;
  
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
    mnemonicToAccount   = viemAccountsModule.mnemonicToAccount;

    // Apply monkey-patches to ClobClient to support funderAddress correctly
    if (!patched && ClobClient) {
      const { createL1Headers } = clobModule;

      // 1. Patch createApiKey to register keys under the proxy/funder address
      ClobClient.prototype.createApiKey = async function(nonce) {
        this.canL1Auth();
        const endpoint = `${this.host}/auth/api-key`;
        const headers = await createL1Headers(
          this.signer, 
          this.chainId, 
          nonce, 
          this.useServerTime ? await this.getServerTime() : undefined,
          this.funderAddress
        );
        return await this.post(endpoint, { headers }).then((apiKeyRaw) => {
          return {
            key: apiKeyRaw.apiKey,
            secret: apiKeyRaw.secret,
            passphrase: apiKeyRaw.passphrase
          };
        });
      };

      // 2. Patch deriveApiKey to retrieve keys registered under the proxy/funder address
      ClobClient.prototype.deriveApiKey = async function(nonce) {
        this.canL1Auth();
        const endpoint = `${this.host}/auth/derive-api-key`;
        const headers = await createL1Headers(
          this.signer, 
          this.chainId, 
          nonce, 
          this.useServerTime ? await this.getServerTime() : undefined,
          this.funderAddress
        );
        return await this.get(endpoint, { headers }).then((apiKeyRaw) => {
          return {
            key: apiKeyRaw.apiKey,
            secret: apiKeyRaw.secret,
            passphrase: apiKeyRaw.passphrase
          };
        });
      };

      // 3. Patch request handlers to inject funderAddress as POLY_ADDRESS in all L2 request headers
      const originalGet = ClobClient.prototype.get;
      ClobClient.prototype.get = async function(endpoint, options, skipThrow) {
        if (this.funderAddress && options && options.headers) {
          options.headers.POLY_ADDRESS = this.funderAddress;
        }
        return await originalGet.call(this, endpoint, options, skipThrow);
      };

      const originalPost = ClobClient.prototype.post;
      ClobClient.prototype.post = async function(endpoint, options, skipThrow) {
        if (this.funderAddress && options && options.headers) {
          options.headers.POLY_ADDRESS = this.funderAddress;
        }
        return await originalPost.call(this, endpoint, options, skipThrow);
      };

      const originalDel = ClobClient.prototype.del;
      ClobClient.prototype.del = async function(endpoint, options, skipThrow) {
        if (this.funderAddress && options && options.headers) {
          options.headers.POLY_ADDRESS = this.funderAddress;
        }
        return await originalDel.call(this, endpoint, options, skipThrow);
      };

      patched = true;
      db.addLog("Successfully patched CLOB SDK ClobClient to support proxy wallets and fix L1/L2 asymmetry.", "info");
    }

    return true;
  } catch (err) {
    db.addLog(`Failed to load @polymarket/clob-client-v2 or viem: ${err.message}. Live trading unavailable.`, 'error');
    return false;
  }
}

// Resolve POLYMARKET_PRIVATE_KEY to a viem account regardless of whether it is
// a raw hex private key or a BIP-39 mnemonic phrase (with spaces or commas).
function resolveAccount(pKey) {
  if (!pKey || pKey.trim() === '') throw new Error("POLYMARKET_PRIVATE_KEY missing in .env.");
  const clean = pKey.trim();
  // Mnemonic: contains at least one space or comma-separated word
  if (clean.includes(' ') || clean.includes(',')) {
    const phrase = clean.replace(/,/g, ' ').replace(/\s+/g, ' ');
    return mnemonicToAccount(phrase);
  }
  // Raw hex private key
  const formattedKey = clean.startsWith('0x') ? clean : `0x${clean}`;
  return privateKeyToAccount(formattedKey);
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

  // 2. Set up viem wallet client (handles both hex keys and mnemonic phrases)
  const account = resolveAccount(pKey);
  const walletClient = createWalletClient({
    account,
    transport: http(process.env.POLYGON_RPC_URL || "https://polygon-rpc.com")
  });

  const client = await createAuthenticatedClobClient(walletClient);

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

// Helper to create and authenticate CLOB client with support for proxy wallets and auto-detecting signature type
async function createAuthenticatedClobClient(walletClient) {
  const host = "https://clob.polymarket.com";
  // Use the proxy wallet address — this is where your Polymarket funds live
  const funderAddress = process.env.POLYMARKET_PROXY_ADDRESS?.trim() || null;

  if (process.env.POLYMARKET_SIGNATURE_TYPE !== undefined && process.env.POLYMARKET_SIGNATURE_TYPE !== "") {
    const sigType = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE);
    return await initClientWithParams(host, walletClient, funderAddress, sigType);
  }

  if (!funderAddress || !funderAddress.startsWith('0x')) {
    return await initClientWithParams(host, walletClient, null, 0);
  }

  if (cachedSignatureType !== null) {
    try {
      return await initClientWithParams(host, walletClient, funderAddress, cachedSignatureType);
    } catch (err) {
      db.addLog(`Cached signature type ${cachedSignatureType} failed, re-detecting...`, 'warning');
      cachedSignatureType = null;
    }
  }

  const candidates = [3, 1, 2];
  let lastError = null;

  for (const sigType of candidates) {
    try {
      db.addLog(`Trying signature type ${sigType} with proxy ${funderAddress}...`, 'info');
      const client = await initClientWithParams(host, walletClient, funderAddress, sigType);
      const balanceData = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      db.addLog(`Auth success with signature type ${sigType}! Balance: ${JSON.stringify(balanceData)}`, 'success');
      cachedSignatureType = sigType;
      return client;
    } catch (err) {
      db.addLog(`Signature type ${sigType} failed: ${err.message}`, 'warning');
      lastError = err;
    }
  }

  // Final fallback — EOA only
  try {
    db.addLog(`Falling back to EOA-only auth...`, 'warning');
    const client = await initClientWithParams(host, walletClient, null, 0);
    cachedSignatureType = 0;
    return client;
  } catch (err) {
    throw new Error(`All auth methods failed. Last error: ${lastError?.message || err.message}`);
  }
}

async function initClientWithParams(host, walletClient, funderAddress, signatureType) {
  const config = {
    host,
    chain: Chain.POLYGON,
    signer: walletClient,
  };
  
  if (funderAddress) {
    config.funderAddress = funderAddress;
    config.signatureType = signatureType;
  }

  const hasApiKeys = process.env.CLOB_API_KEY && process.env.CLOB_API_SECRET && process.env.CLOB_API_PASSPHRASE;
  
  if (hasApiKeys) {
    config.creds = {
      key: process.env.CLOB_API_KEY,
      secret: process.env.CLOB_API_SECRET,
      passphrase: process.env.CLOB_API_PASSPHRASE
    };
    return new ClobClient(config);
  } else {
    // Derive API keys using a plain EOA client (no funderAddress) to avoid EIP-1271 signing issues.
    // The Polymarket SDK cannot derive proxy-registered API keys automatically — but EOA-derived
    // keys still work: our monkey-patch forces POLY_ADDRESS=proxyAddress in every request header,
    // so the server looks up the proxy's balance even though auth was established via EOA keys.
    const eoaClient = new ClobClient({
      host,
      chain: Chain.POLYGON,
      signer: walletClient
      // No funderAddress — EOA signs for itself
    });
    const creds = await eoaClient.createOrDeriveApiKey();
    if (!creds || !creds.secret) {
      throw new Error('Failed to derive API key credentials from EOA. Secret is empty.');
    }
    db.addLog(`Derived EOA API creds successfully. Key: ${creds.key?.substring(0, 8)}...`, 'info');
    // Build the actual client with proxy config + EOA-derived creds
    return new ClobClient({ ...config, creds });
  }
}

// Fetch authenticated USDC balance from the Polymarket CLOB API
async function getBalance() {
  const initialized = await initClobClient();
  if (!initialized) throw new Error("CLOB SDK not initialized.");

  const pKey = process.env.POLYMARKET_PRIVATE_KEY;
  const account = resolveAccount(pKey);
  const walletClient = createWalletClient({
    account,
    transport: http(process.env.POLYGON_RPC_URL || "https://polygon-rpc.com")
  });

  const funderAddress = process.env.POLYMARKET_PROXY_ADDRESS?.trim();
  db.addLog(`getBalance: signer EOA=${account.address}, proxy=${funderAddress || 'none'}`, 'info');

  const client = await createAuthenticatedClobClient(walletClient);
  const balanceData = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
  db.addLog(`Raw CLOB balanceData: ${JSON.stringify(balanceData)}`, 'info');
  return parseFloat(balanceData.balance) || 0;
}


module.exports = {
  placeLiveOrder,
  getClobTokenId,
  getBalance
};
