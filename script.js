/* ============================================================
   CONFIG — edit these for your deployment
   ============================================================ */

// Paste your deployed contract addresses here, or use the
// "Contract settings" panel on the page to set them at runtime.
let CONTRACT_ADDRESS = "";   // ProofPayRewards
let REGISTRY_ADDRESS = "";   // EmployeeRegistry

// Backend API base URL — when served from server.js this is the same origin.
// Change to e.g. "http://localhost:3000" if you open index.html directly as a file.
const API_BASE = (location.protocol === 'file:') ? 'http://localhost:3000' : '';

// Employee metrics keyed by UPPERCASE companyId — fetched from backend on load.
// Used to supply work-metric context to the AI feedback prompt.
let employeeMetrics = {};
fetch(`${API_BASE}/employee-metrics.json`)
  .then(r => r.json())
  .then(data => { employeeMetrics = data; })
  .catch(() => {});

const REWARDS_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function scores(address) view returns (uint256)",
  "function canClaim(address) view returns (bool)",
  "function nextClaimTime(address) view returns (uint256)",
  "function previewReward(address) view returns (uint256)",
  "function claim()",
  "event Claimed(address indexed employee, uint256 score, uint256 rewardAmount)"
];

const REGISTRY_ABI = [
  "function checkLogin(string companyId, string name, address wallet) view returns (uint8 status)",
  "function getEmployee(string companyId) view returns (string name, address wallet, bool exists)"
];

const SEPOLIA_CHAIN_ID = '0xaa36a7';

/* ============================================================
   STATE
   ============================================================ */
let provider, signer, userAddress, contract, registryContract, decimals = 18;
let currentEmployee = null;

const el = id => document.getElementById(id);

/* ============================================================
   SCREEN SWITCHING
   ============================================================ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  el(id).classList.add('active');
  // Top wallet button only opens MetaMask for cross-checking once the user
  // is past login, on the dashboard — not on the login page.
  el('topWalletBtn').disabled = (id !== 'dashboardScreen');
}

/* ============================================================
   CONTRACT ADDRESS SETTINGS
   ============================================================ */
el('saveAddrBtn').addEventListener('click', () => {
  const rewardsVal  = el('contractAddr').value.trim();
  const registryVal = el('registryAddr').value.trim();

  if (rewardsVal && window.ethers && ethers.isAddress(rewardsVal)) {
    CONTRACT_ADDRESS = rewardsVal;
    el('contractAddr').style.borderColor = 'var(--ok)';
  } else {
    el('contractAddr').style.borderColor = 'var(--err)';
  }

  if (registryVal && window.ethers && ethers.isAddress(registryVal)) {
    REGISTRY_ADDRESS = registryVal;
    el('registryAddr').style.borderColor = 'var(--ok)';
  } else {
    el('registryAddr').style.borderColor = 'var(--err)';
  }
});

/* ============================================================
   WALLET CONNECT & ADDRESS HANDLING
   ============================================================ */
function setWalletNote(text, kind) {
  const n = el('walletNote');
  if (!n) return;
  n.textContent = text;
  n.className   = 'wallet-note' + (kind ? ' ' + kind : '');
}

async function requestMetaMaskAccount() {
  if (!window.ethereum) return null;
  // 1. Try currently connected accounts first (no popup needed)
  try {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (accounts && accounts.length > 0) return accounts[0];
  } catch (e) {}
  
  // 2. Fall back to direct property if available
  if (window.ethereum.selectedAddress) {
    return window.ethereum.selectedAddress;
  }

  // 3. Request account connection popup
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (accounts && accounts.length > 0) return accounts[0];
  } catch (e) {}

  return null;
}

// Automatically check if MetaMask is already connected on load
async function autoDetectWallet() {
  if (!window.ethereum) return;
  try {
    const account = await requestMetaMaskAccount();
    if (account && ethers.isAddress(account)) {
      userAddress = account;
      el('topWalletBtn').textContent = account.slice(0, 6) + '…' + account.slice(-4);
      if (!el('walletInput').value.trim()) {
        el('walletInput').value = account;
        setWalletNote('MetaMask wallet auto-detected.', 'ok');
      }
      checkLoginReady();
    }
  } catch (e) {}
}
window.addEventListener('DOMContentLoaded', autoDetectWallet);

// Connect button handler
el('connectBtn').addEventListener('click', async () => {
  const typed = el('walletInput').value.trim();

  // 1. If MetaMask is installed, try getting account
  if (window.ethereum) {
    try {
      setWalletNote('Connecting to MetaMask…', '');
      const account = await requestMetaMaskAccount();

      if (account && ethers.isAddress(account)) {
        userAddress = account;
        el('walletInput').value = account;
        setWalletNote('Wallet connected via MetaMask.', 'ok');
        el('topWalletBtn').textContent = account.slice(0, 6) + '…' + account.slice(-4);
        try {
          provider = new ethers.BrowserProvider(window.ethereum, 'any');
          signer   = await provider.getSigner(account);
        } catch (e) {
          signer = null;
        }
        checkLoginReady();
        return;
      }
    } catch (e) {
      console.warn('MetaMask connect failed:', e);
    }
  }

  // 2. Check if typed address in box is valid
  if (typed && ethers.isAddress(typed)) {
    userAddress = typed;
    setWalletNote('Using typed wallet address.', 'ok');
    el('topWalletBtn').textContent = typed.slice(0, 6) + '…' + typed.slice(-4);
    checkLoginReady();
    return;
  }

  // 3. Auto-suggest address from CSV if Company ID is typed
  const cid = el('idInput').value.trim().toUpperCase();
  if (cid && employeeMetrics[cid] && employeeMetrics[cid].wallet) {
    const csvWallet = employeeMetrics[cid].wallet;
    if (ethers.isAddress(csvWallet)) {
      userAddress = csvWallet;
      el('walletInput').value = csvWallet;
      setWalletNote('Filled wallet address registered for this Company ID.', 'ok');
      el('topWalletBtn').textContent = csvWallet.slice(0, 6) + '…' + csvWallet.slice(-4);
      checkLoginReady();
      return;
    }
  }

  if (!window.ethereum) {
    setWalletNote('MetaMask not detected. Paste a valid 42-character wallet address (0x...).', 'error');
  } else {
    setWalletNote('Please approve connection in MetaMask or paste your 0x... wallet address.', 'error');
  }
});

// Auto-detect when user types or pastes a valid wallet address
el('walletInput').addEventListener('input', () => {
  const typed = el('walletInput').value.trim();
  if (typed && ethers.isAddress(typed)) {
    userAddress = typed;
    setWalletNote('Wallet address valid.', 'ok');
    el('topWalletBtn').textContent = typed.slice(0, 6) + '…' + typed.slice(-4);
  } else if (typed) {
    userAddress = null;
    setWalletNote(`Invalid address (${typed.length}/42 chars). Must start with 0x...`, 'error');
    el('topWalletBtn').textContent = 'not connected';
  } else {
    userAddress = null;
    setWalletNote('', '');
    el('topWalletBtn').textContent = 'not connected';
  }
  checkLoginReady();
});

// When Company ID is entered, auto-suggest the registered wallet address if box is empty
el('idInput').addEventListener('change', () => {
  const cid = el('idInput').value.trim().toUpperCase();
  if (cid && employeeMetrics[cid] && employeeMetrics[cid].wallet && !el('walletInput').value.trim()) {
    const w = employeeMetrics[cid].wallet;
    if (ethers.isAddress(w)) {
      userAddress = w;
      el('walletInput').value = w;
      setWalletNote('Auto-filled registered wallet address from CSV.', 'ok');
      el('topWalletBtn').textContent = w.slice(0, 6) + '…' + w.slice(-4);
      checkLoginReady();
    }
  }
});

// Top navbar wallet button: re-connects MetaMask
el('topWalletBtn').addEventListener('click', async () => {
  if (el('topWalletBtn').disabled) return;
  if (!window.ethereum) return;
  try {
    const account = await requestMetaMaskAccount();
    if (account && ethers.isAddress(account)) {
      userAddress = account;
      el('walletInput').value = account;
      el('topWalletBtn').textContent = account.slice(0, 6) + '…' + account.slice(-4);
      checkLoginReady();
    }
  } catch (e) { /* user cancelled */ }
});

function checkLoginReady() {
  const nameOk   = el('nameInput').value.trim().length > 0;
  const idOk     = el('idInput').value.trim().length > 0;
  const rawW     = el('walletInput').value.trim();
  const walletOk = (userAddress && ethers.isAddress(userAddress)) || (rawW && ethers.isAddress(rawW));
  
  if (walletOk && !userAddress) {
    userAddress = rawW;
  }

  const isReady = nameOk && idOk && walletOk;
  el('loginBtn').disabled = !isReady;
}

el('nameInput').addEventListener('input', checkLoginReady);
el('idInput').addEventListener('input', checkLoginReady);

// Update avatar initials live as the user types their name
el('nameInput').addEventListener('input', () => {
  const v = el('nameInput').value.trim();
  el('avatarInitials').textContent = v ? initials(v) : '--';
});

function initials(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

/* ============================================================
   LOGIN VALIDATION
   ============================================================ */
function setLoginMsg(text, kind) {
  const m = el('loginMsg');
  if (!m) return;
  m.textContent = text;
  m.className   = 'form-msg' + (kind ? ' ' + kind : '');
}

async function findEmployee(name, companyId, wallet) {
  // status: 0 = not found, 1 = name mismatch, 2 = wallet mismatch, 3 = ok
  const status = await registryContract.checkLogin(companyId, name, wallet);

  if (status === 0 || status === 0n) {
    return { ok: false, message: `Employee record not found on-chain for ID "${companyId}".` };
  }
  if (status === 1 || status === 1n) {
    return { ok: false, message: 'Name does not match the registered Company ID.' };
  }
  if (status === 2 || status === 2n) {
    return { ok: false, message: 'Wallet address does not match the registered Company ID.' };
  }

  const record = await registryContract.getEmployee(companyId);
  return { ok: true, employee: { name: record.name, companyId, wallet: record.wallet } };
}

el('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name      = el('nameInput').value.trim();
  const companyId = el('idInput').value.trim();
  const wallet    = userAddress || el('walletInput').value.trim();

  if (!ethers.isAddress(wallet)) {
    setLoginMsg('Please enter or connect a valid wallet address.', 'error');
    return;
  }

  setLoginMsg('Verifying credentials…', '');

  // 1. Try On-Chain verification if contract addresses are provided & provider/signer exists
  if (CONTRACT_ADDRESS && REGISTRY_ADDRESS && (signer || window.ethereum)) {
    try {
      if (!signer && window.ethereum) {
        provider = new ethers.BrowserProvider(window.ethereum, 'any');
        signer   = await provider.getSigner();
      }
      registryContract = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, signer || provider);
      const result = await findEmployee(name, companyId, wallet);

      if (!result.ok) {
        setLoginMsg(result.message, 'error');
        return;
      }

      currentEmployee = result.employee;
      contract = new ethers.Contract(CONTRACT_ADDRESS, REWARDS_ABI, signer || provider);
      await loadDashboard();
      showScreen('dashboardScreen');
      return;
    } catch (err) {
      console.warn('On-chain check failed, falling back to backend verification:', err.message);
    }
  }

  // 2. Fallback verification against Backend CSV data (for testing/preview when contracts aren't deployed)
  const cidUpper = companyId.toUpperCase();
  const emp = employeeMetrics[cidUpper];

  if (!emp) {
    setLoginMsg(`Employee ID "${companyId}" not found in database. Example: TCS20261001 (Aarav)`, 'error');
    return;
  }

  if (emp.name.toLowerCase() !== name.toLowerCase()) {
    setLoginMsg(`Name "${name}" does not match record for ID ${companyId}. Expected: ${emp.name}`, 'error');
    return;
  }

  // Login successful via fallback!
  currentEmployee = { name: emp.name, companyId: emp.companyId, wallet: wallet };
  setLoginMsg('Signed in — loading dashboard…', 'ok');
  await loadDashboardFallback();
  showScreen('dashboardScreen');
});

// Fallback dashboard load when smart contract is not yet deployed
async function loadDashboardFallback() {
  el('dashInitials').textContent   = initials(currentEmployee.name);
  el('avatarInitials').textContent = initials(currentEmployee.name);
  el('dashName').textContent       = currentEmployee.name;
  el('dashId').textContent         = currentEmployee.companyId;
  el('walletOut').textContent      = currentEmployee.wallet.slice(0, 6) + '…' + currentEmployee.wallet.slice(-4);

  const emp = employeeMetrics[currentEmployee.companyId.toUpperCase()];
  let estimatedScore = 75;
  if (emp) {
    estimatedScore = Math.min(100, Math.max(40, Math.round(
      (emp.avgWorkHours >= 8 ? 40 : 25) +
      (emp.projectsCompleted * 10) +
      (emp.leaves <= 3 ? 20 : 5) +
      (emp.avgExtraHours * 5)
    )));
  }

  el('balanceOut').textContent = '100.0 PPAY (Preview)';
  el('scoreOut').textContent   = estimatedScore.toString();

  const stampEl  = el('claimStamp');
  const detailEl = el('claimDetail');
  const btn      = el('claimBtn');

  if (estimatedScore > 50) {
    stampEl.textContent  = 'AVAILABLE';
    stampEl.className    = 'stamp available';
    detailEl.textContent = `You are eligible to claim ~${estimatedScore + 10} PPAY reward tokens (Deploy smart contract to claim on-chain).`;
    btn.disabled         = true;
  } else {
    stampEl.textContent  = 'NOT ELIGIBLE';
    stampEl.className    = 'stamp locked';
    detailEl.textContent = 'Score must be above 50 to claim rewards.';
    btn.disabled         = true;
  }

  await loadFeedback(estimatedScore, 'PPAY');

  const list = el('historyList');
  list.innerHTML = '<div class="history-empty">Contract not deployed yet — demo preview mode active.</div>';
}

el('logoutBtn').addEventListener('click', () => {
  currentEmployee = null;
  el('loginForm').reset();
  el('walletInput').value  = '';
  el('avatarInitials').textContent = '--';
  userAddress = null;
  el('loginBtn').disabled  = true;
  setLoginMsg('', '');
  setWalletNote('', '');
  el('topWalletBtn').textContent = 'not connected';
  showScreen('loginScreen');
});

/* ============================================================
   DASHBOARD LOAD
   ============================================================ */
async function loadDashboard() {
  el('dashInitials').textContent = initials(currentEmployee.name);
  el('avatarInitials').textContent = initials(currentEmployee.name);
  el('dashName').textContent     = currentEmployee.name;
  el('dashId').textContent       = currentEmployee.companyId;
  el('walletOut').textContent    = userAddress.slice(0, 6) + '…' + userAddress.slice(-4);

  decimals       = await contract.decimals();
  const symbol   = await contract.symbol();

  await refreshBalance(symbol);
  const score = await contract.scores(userAddress);
  el('scoreOut').textContent = score.toString();

  await refreshClaimState(symbol);
  await loadFeedback(score, symbol);
  await loadHistory(symbol);
}

async function refreshBalance(symbol) {
  const bal = await contract.balanceOf(userAddress);
  el('balanceOut').textContent = ethers.formatUnits(bal, decimals) + ' ' + symbol;
}

/* ============================================================
   CLAIM STATE + ACTION
   ============================================================ */
async function refreshClaimState(symbol) {
  const stampEl  = el('claimStamp');
  const detailEl = el('claimDetail');
  const btn      = el('claimBtn');

  const eligible = await contract.canClaim(userAddress);
  const score    = await contract.scores(userAddress);

  if (score <= 50n) {
    stampEl.textContent  = 'NOT ELIGIBLE';
    stampEl.className    = 'stamp locked';
    detailEl.textContent = 'Your current score is 50 or below, so no reward is available this cycle.';
    btn.disabled         = true;
    return;
  }

  if (eligible) {
    const preview        = await contract.previewReward(userAddress);
    stampEl.textContent  = 'AVAILABLE';
    stampEl.className    = 'stamp available';
    detailEl.textContent = `You can claim ${preview.toString()} ${symbol} right now.`;
    btn.disabled         = false;
  } else {
    const next    = await contract.nextClaimTime(userAddress);
    const nextDate = new Date(Number(next) * 1000);
    stampEl.textContent  = 'LOCKED';
    stampEl.className    = 'stamp locked';
    detailEl.textContent =
      `You've already claimed this cycle. Next reward opens on ${nextDate.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}.`;
    btn.disabled = true;
  }
}

el('claimBtn').addEventListener('click', async () => {
  const btn = el('claimBtn');
  btn.disabled    = true;
  btn.textContent = 'Confirm in MetaMask…';
  try {
    const tx = await contract.claim();
    btn.textContent = 'Waiting for confirmation…';
    await tx.wait();
    const symbol = await contract.symbol();
    await refreshBalance(symbol);
    await refreshClaimState(symbol);
    await loadHistory(symbol);
    btn.textContent = 'Claim reward';
  } catch (e) {
    const msg = (e && e.reason) || (e && e.shortMessage) || (e && e.error && e.error.message) || 'Claim failed.';
    el('claimDetail').textContent = msg;
    btn.textContent  = 'Claim reward';
    btn.disabled     = false;
  }
});

/* ============================================================
   AI FEEDBACK  — calls backend /api/feedback (Groq via server.js)
   ============================================================ */
async function loadFeedback(score, symbol) {
  const out = el('feedbackOut');
  out.textContent = 'Generating AI feedback…';

  try {
    const preview  = await contract.previewReward(userAddress);
    const companyId = currentEmployee.companyId.toUpperCase();

    const response = await fetch(`${API_BASE}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        score:         score.toString(),
        previewReward: preview.toString(),
        symbol,
        companyId,
      }),
    });

    if (!response.ok) throw new Error(`Backend returned ${response.status}`);

    const data = await response.json();
    out.textContent = data.text || 'No feedback available this cycle.';
  } catch (e) {
    // Graceful fallback — still useful without backend connection
    const s = Number(score);
    out.textContent =
      s > 80 ? `Outstanding performance this quarter! Your score of ${s}/100 places you in the top tier.`
    : s > 60 ? `Solid performance this quarter with a score of ${s}/100. Keep pushing on project delivery.`
    :           `Your score of ${s}/100 reflects some areas to improve. Focus on attendance and project output.`;
  }
}

/* ============================================================
   HISTORY (read directly from on-chain Claimed events)
   ============================================================ */
async function loadHistory(symbol) {
  const list = el('historyList');
  list.innerHTML = '<div class="history-empty">Loading history from chain…</div>';
  try {
    const filter = contract.filters.Claimed(userAddress);
    const events = await contract.queryFilter(filter, 0, 'latest');

    if (events.length === 0) {
      list.innerHTML = '<div class="history-empty">No rewards claimed yet.</div>';
      return;
    }

    const withTimestamps = await Promise.all(events.map(async (ev) => {
      const block = await ev.getBlock();
      return {
        amount:    ev.args.rewardAmount.toString(),
        score:     ev.args.score.toString(),
        timestamp: block.timestamp,
        txHash:    ev.transactionHash
      };
    }));

    withTimestamps.sort((a, b) => b.timestamp - a.timestamp);

    list.innerHTML = '';
    withTimestamps.forEach(row => {
      const date = new Date(row.timestamp * 1000)
        .toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      const div  = document.createElement('div');
      div.className = 'history-row';
      div.innerHTML =
        `<span class="history-date">${date} · score ${row.score}</span>` +
        `<span class="history-amt">+${row.amount} ${symbol}</span>`;
      list.appendChild(div);
    });
  } catch (e) {
    list.innerHTML = '<div class="history-empty">Could not load history from chain.</div>';
  }
}

/* ============================================================
   DEMO MODE — AI evaluation without MetaMask / contracts
   ============================================================ */

// Populate quick-pick chips once metrics load
function populateQuickChips() {
  const chips = el('quickChips');
  if (!chips) return;
  chips.innerHTML = '';
  // Show first 8 employees as chips
  const entries = Object.values(employeeMetrics).slice(0, 8);
  entries.forEach(emp => {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'chip';
    btn.textContent = emp.name;
    btn.title = emp.companyId;
    btn.addEventListener('click', () => {
      el('demoName').value = emp.name;
      el('demoId').value   = emp.companyId;
    });
    chips.appendChild(btn);
  });
}

// Fetch metrics and then populate chips
fetch(`${API_BASE}/employee-metrics.json`)
  .then(r => r.json())
  .then(data => {
    employeeMetrics = data;
    populateQuickChips();
  })
  .catch(() => {});

// Toggle between login and demo screens
el('demoToggleBtn').addEventListener('click', () => {
  const demo = el('demoScreen');
  if (demo.classList.contains('active')) {
    showScreen('loginScreen');
    el('demoToggleBtn').textContent = '⚡ Try Demo';
  } else {
    showScreen('demoScreen');
    el('demoToggleBtn').textContent = '← Login';
    populateQuickChips();
  }
});

el('demoBackBtn').addEventListener('click', () => {
  showScreen('loginScreen');
  el('demoToggleBtn').textContent = '⚡ Try Demo';
});

// Render score in the result panel
function renderDemoScore(result) {
  const scoreClass = result.score >= 75 ? 'high' : result.score >= 55 ? 'mid' : 'low';
  el('demoResultBody').innerHTML = `
    <div class="score-gauge">
      <div class="score-number ${scoreClass}">${result.score}</div>
      <div class="score-label">Performance Score / 100</div>
      <div class="score-bar-track">
        <div class="score-bar-fill" id="scoreBarFill" style="width:0%"></div>
      </div>
    </div>
    <div class="score-summary">${result.summary}</div>
  `;
  // Animate bar
  requestAnimationFrame(() => {
    setTimeout(() => {
      const fill = document.getElementById('scoreBarFill');
      if (fill) fill.style.width = result.score + '%';
    }, 50);
  });
}

// Render full report in the wide panel
function renderDemoReport(result) {
  const panel = el('demoReportPanel');
  const body  = el('demoReportBody');
  panel.style.display = '';

  const listHtml = (items, cls) =>
    `<ul class="report-list ${cls}">${items.map(i => `<li>${i}</li>`).join('')}</ul>`;

  body.innerHTML = `
    <div class="report-section">
      <div class="report-section-title">✅ Strengths</div>
      ${listHtml(result.strengths, 'strengths')}
    </div>
    <div class="report-section">
      <div class="report-section-title">⚠️ Areas to Improve</div>
      ${listHtml(result.weaknesses, 'weaknesses')}
    </div>
    <div class="report-section">
      <div class="report-section-title">💡 Suggestions</div>
      ${listHtml(result.improvement_suggestions, 'suggestions')}
    </div>
  `;
}

// Handle demo form submission
el('demoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name      = el('demoName').value.trim();
  const companyId = el('demoId').value.trim();
  const btn       = el('demoEvalBtn');
  const msgEl     = el('demoMsg');

  if (!name || !companyId) return;

  btn.disabled    = true;
  btn.innerHTML   = '<span class="spinner"></span>Evaluating with AI…';
  msgEl.textContent = '';
  msgEl.className   = 'form-msg';
  el('demoReportPanel').style.display = 'none';
  el('demoResultBody').innerHTML = `
    <div class="demo-placeholder">
      <div class="demo-placeholder-icon"><span class="spinner" style="width:28px;height:28px;border-width:3px;"></span></div>
      <div class="demo-placeholder-text">Contacting Groq LLM…</div>
    </div>`;

  try {
    const response = await fetch(`${API_BASE}/api/evaluate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, companyId }),
    });

    const data = await response.json();

    if (!response.ok) {
      msgEl.textContent = data.error || 'Evaluation failed.';
      msgEl.className   = 'form-msg error';
      el('demoResultBody').innerHTML = `
        <div class="demo-placeholder">
          <div class="demo-placeholder-icon">❌</div>
          <div class="demo-placeholder-text">${data.error || 'Employee not found'}</div>
        </div>`;
      return;
    }

    renderDemoScore(data);
    renderDemoReport(data);

  } catch (err) {
    msgEl.textContent = 'Could not reach the backend. Make sure server.js is running (npm start).';
    msgEl.className   = 'form-msg error';
    el('demoResultBody').innerHTML = `
      <div class="demo-placeholder">
        <div class="demo-placeholder-icon">🔌</div>
        <div class="demo-placeholder-text">Backend not reachable</div>
      </div>`;
  } finally {
    btn.disabled  = false;
    btn.innerHTML = 'Run AI Evaluation';
  }
});