/**
 * RentAByte – app.js
 * Handles:
 *   - MetaMask wallet connection (ethers.js v6)
 *   - Polygon Amoy Testnet transaction sending
 *   - Backend API calls
 *   - UI state management
 */

// ── Configuration ────────────────────────────────────────────────────────────

const API_BASE = (window.RENTABYTE_API_BASE || "").replace(/\/$/, "");

// Replace with your deployed contract address after running `npx hardhat run`
const CONTRACT_ADDRESS = window.RENTABYTE_CONTRACT || "";

// Polygon Amoy Testnet parameters
const AMOY_CHAIN_ID     = "0x13882";   // 80002 in hex
const AMOY_CHAIN_NAME   = "Polygon Amoy Testnet";
const AMOY_RPC_URL      = "https://rpc-amoy.polygon.technology";
const AMOY_BLOCK_EXPLORER = "https://amoy.polygonscan.com";
const AMOY_CURRENCY     = { name: "POL", symbol: "POL", decimals: 18 };

// Pricing: must match backend .env  POL_PER_100MB
const POL_PER_100MB = 0.001;

// Minimal ABI – only the payForStorage function we need
const CONTRACT_ABI = [
  {
    "inputs": [{"internalType": "uint256", "name": "storageMB", "type": "uint256"}],
    "name": "payForStorage",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "uint256", "name": "storageMB", "type": "uint256"}],
    "name": "requiredPayment",
    "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
    "stateMutability": "view",
    "type": "function"
  }
];

// ── App State ────────────────────────────────────────────────────────────────

const State = {
  walletAddress: null,
  provider: null,
  signer: null,
  storagePool: null,
  activeTxHash: null,   // last successful payment tx
};

// ── Utilities ────────────────────────────────────────────────────────────────

function shortAddr(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function bytesToMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function polRequired(mb) {
  return ((mb / 100) * POL_PER_100MB).toFixed(4);
}

function showToast(msg, type = "info") {
  // Simple alert fallback – replace with a toast library for polish
  console.log(`[${type.toUpperCase()}] ${msg}`);
  // Create a temporary DOM toast
  const el = document.createElement("div");
  el.className = `alert alert-${type}`;
  el.style.cssText = "position:fixed;top:1rem;right:1rem;z-index:9999;max-width:380px;animation:fadeIn .3s";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

async function apiCall(method, path, body = null) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "API error");
  return data;
}

// ── MetaMask / Wallet ────────────────────────────────────────────────────────

async function ensureAmoyNetwork() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: AMOY_CHAIN_ID }],
    });
  } catch (switchError) {
    // Chain not added yet – add it
    if (switchError.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: AMOY_CHAIN_ID,
          chainName: AMOY_CHAIN_NAME,
          rpcUrls: [AMOY_RPC_URL],
          nativeCurrency: AMOY_CURRENCY,
          blockExplorerUrls: [AMOY_BLOCK_EXPLORER],
        }],
      });
    } else {
      throw switchError;
    }
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    showToast("MetaMask not found. Please install it.", "error");
    return null;
  }

  try {
    await ensureAmoyNetwork();

    // ethers v6 uses BrowserProvider
    State.provider = new ethers.BrowserProvider(window.ethereum);
    await State.provider.send("eth_requestAccounts", []);
    State.signer = await State.provider.getSigner();
    State.walletAddress = await State.signer.getAddress();

    // Register with backend
    await apiCall("POST", "/connect-wallet", { wallet_address: State.walletAddress });

    updateWalletUI();
    showToast(`Wallet connected: ${shortAddr(State.walletAddress)}`, "success");
    return State.walletAddress;
  } catch (err) {
    showToast("Wallet connection failed: " + err.message, "error");
    return null;
  }
}

function updateWalletUI() {
  // Update all elements with [data-wallet-address]
  document.querySelectorAll("[data-wallet-address]").forEach(el => {
    el.textContent = State.walletAddress ? shortAddr(State.walletAddress) : "Not connected";
  });

  // Show/hide wallet-gated sections
  document.querySelectorAll("[data-requires-wallet]").forEach(el => {
    el.style.display = State.walletAddress ? "" : "none";
  });

  // Update connect button
  const btn = document.getElementById("btn-connect-wallet");
  if (btn) {
    if (State.walletAddress) {
      btn.innerHTML = `<span class="wallet-dot"></span> ${shortAddr(State.walletAddress)}`;
      btn.className = "wallet-chip";
    } else {
      btn.textContent = "Connect MetaMask";
      btn.className = "btn btn-primary";
    }
  }
}

// ── Blockchain Payment ───────────────────────────────────────────────────────

/**
 * Send a payment transaction for storage via the smart contract.
 * Falls back to a plain ETH transfer to the platform wallet if no
 * contract address is configured.
 *
 * @param {number} storageMB  Amount of storage to purchase in MB.
 * @returns {string} Transaction hash.
 */
async function payForStorage(storageMB) {
  if (!State.signer) throw new Error("Wallet not connected.");

  const polAmount = polRequired(storageMB);
  const valueWei  = ethers.parseEther(polAmount);

  let tx;
  if (CONTRACT_ADDRESS) {
    // Use the deployed smart contract
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, State.signer);
    tx = await contract.payForStorage(storageMB, { value: valueWei });
  } else {
    // Direct transfer to platform wallet (simpler demo fallback)
    const PLATFORM_WALLET = window.RENTABYTE_PLATFORM_WALLET || "";
    if (!PLATFORM_WALLET) throw new Error("Set RENTABYTE_CONTRACT or RENTABYTE_PLATFORM_WALLET.");
    tx = await State.signer.sendTransaction({
      to: PLATFORM_WALLET,
      value: valueWei,
    });
  }

  showToast("Transaction sent! Waiting for confirmation…", "info");
  const receipt = await tx.wait(1);   // wait for 1 confirmation
  showToast(`Payment confirmed! Tx: ${shortAddr(receipt.hash)}`, "success");
  return receipt.hash;
}

// ── Storage Pool ─────────────────────────────────────────────────────────────

async function loadStoragePool() {
  try {
    const pool = await apiCall("GET", "/storage-pool");
    State.storagePool = pool;
    renderPoolStats(pool);
    return pool;
  } catch (err) {
    console.error("Failed to load pool:", err);
  }
}

function renderPoolStats(pool) {
  const usedMB = pool.total_storage_mb - pool.available_storage_mb;
  const pct     = pool.total_storage_mb
    ? Math.round((usedMB / pool.total_storage_mb) * 100)
    : 0;

  const targets = {
    "pool-total":     `${pool.total_storage_mb} MB`,
    "pool-available": `${pool.available_storage_mb} MB`,
    "pool-nodes":     pool.node_count,
    "pool-price":     `${pool.price_per_100mb_pol} POL / 100 MB`,
    "pool-used-pct":  `${pct}%`,
  };

  Object.entries(targets).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  });

  const fill = document.getElementById("pool-progress-fill");
  if (fill) fill.style.width = `${pct}%`;
}

// ── Dropbox Connect ──────────────────────────────────────────────────────────

async function connectDropbox(token) {
  if (!State.walletAddress) {
    showToast("Connect your wallet first.", "warn");
    return;
  }
  const data = await apiCall("POST", "/connect-dropbox", {
    wallet_address: State.walletAddress,
    dropbox_token: token,
  });
  showToast(data.message, "success");
  return data;
}

// ── Storage Registration (Seller) ────────────────────────────────────────────

async function registerStorage(storageMB) {
  if (!State.walletAddress) {
    showToast("Connect your wallet first.", "warn");
    return;
  }
  const data = await apiCall("POST", "/register-storage", {
    wallet_address: State.walletAddress,
    storage_mb: parseInt(storageMB, 10),
  });
  showToast(
    `Registered ${data.registered_mb} MB (node #${data.node_id}). Reward sent: ${data.reward_pol} POL`,
    "success"
  );
  if (data.reward_tx_hash) {
    console.log("Seller reward tx:", data.reward_tx_hash);
  }
  await loadStoragePool();
  return data;
}

// ── Storage Purchase (Buyer) ─────────────────────────────────────────────────

async function requestStorage(storageMB) {
  if (!State.walletAddress) {
    showToast("Connect your wallet first.", "warn");
    return;
  }

  try {
    showToast(`Sending ${polRequired(storageMB)} POL for ${storageMB} MB…`, "info");
    const txHash = await payForStorage(parseInt(storageMB, 10));

    // Tell backend to verify and allocate
    const data = await apiCall("POST", "/request-storage", {
      wallet_address: State.walletAddress,
      storage_mb: parseInt(storageMB, 10),
      tx_hash: txHash,
    });

    State.activeTxHash = txHash;
    showToast(data.message, "success");
    await loadStoragePool();
    return { txHash, data };
  } catch (err) {
    showToast("Storage request failed: " + err.message, "error");
    throw err;
  }
}

// ── File Upload ──────────────────────────────────────────────────────────────

async function uploadFile(file, txHash) {
  if (!State.walletAddress) throw new Error("Wallet not connected.");
  if (!txHash) throw new Error("No active storage allocation. Request storage first.");

  const formData = new FormData();
  formData.append("file", file);

  const url = `${API_BASE}/upload-file?wallet_address=${encodeURIComponent(State.walletAddress)}&tx_hash=${encodeURIComponent(txHash)}`;
  const res  = await fetch(url, { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Upload failed");
  return data;
}

// ── File Download ─────────────────────────────────────────────────────────────

async function downloadFile(fileId, fileName) {
  const url = `${API_BASE}/download-file/${fileId}?wallet_address=${encodeURIComponent(State.walletAddress || "")}`;
  const res  = await fetch(url);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Download failed");
  }
  const blob    = await res.blob();
  const anchor  = document.createElement("a");
  anchor.href   = URL.createObjectURL(blob);
  anchor.download = fileName || fileId;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

// ── File List ────────────────────────────────────────────────────────────────

async function loadFileList() {
  if (!State.walletAddress) return [];
  const data = await apiCall("GET", `/files?wallet_address=${encodeURIComponent(State.walletAddress)}`);
  return data.files || [];
}

// ── Handle account / chain changes ──────────────────────────────────────────

if (window.ethereum) {
  window.ethereum.on("accountsChanged", (accounts) => {
    if (accounts.length === 0) {
      State.walletAddress = null;
      State.signer = null;
      updateWalletUI();
    } else {
      // Re-connect with new account
      connectWallet();
    }
  });

  window.ethereum.on("chainChanged", () => window.location.reload());
}

// ── Expose globals for inline handlers ───────────────────────────────────────

window.RentAByte = {
  State,
  connectWallet,
  connectDropbox,
  registerStorage,
  requestStorage,
  uploadFile,
  downloadFile,
  loadStoragePool,
  loadFileList,
  shortAddr,
  polRequired,
  showToast,
};
