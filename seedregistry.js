/**
 * seedRegistry.js
 * ----------------
 * Reads employees.csv and registers every row on-chain in
 * EmployeeRegistry, using the ADMIN_PRIVATE_KEY wallet. Run this once after
 * deploying EmployeeRegistry.sol, and again any time the CSV changes.
 *
 * Usage:
 *   node seedRegistry.js
 *
 * Required .env vars:
 *   RPC_URL            — JSON-RPC endpoint (Infura/Alchemy Sepolia or localhost:8545)
 *   ADMIN_PRIVATE_KEY  — Private key of the wallet that owns EmployeeRegistry
 *   REGISTRY_ADDRESS   — Deployed EmployeeRegistry contract address
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { parse }  = require('csv-parse/sync');
const { ethers } = require('ethers');

/* ─── ABI — must match EmployeeRegistry.sol exactly ──────────────────────── */
const REGISTRY_ABI = [
  // addEmployeesBulk(string[] companyIds, string[] names, address[] wallets)
  'function addEmployeesBulk(string[] calldata companyIds, string[] calldata names, address[] calldata wallets) external',
  // addEmployee(string companyId, string name, address wallet)
  'function addEmployee(string calldata companyId, string calldata name, address wallet) external',
  // getEmployee — used to check if already registered
  'function getEmployee(string calldata companyId) view returns (string name, address wallet, bool exists)',
];

const BATCH_SIZE = 10; // keep each tx's gas reasonable

async function main() {
  const { RPC_URL, ADMIN_PRIVATE_KEY, REGISTRY_ADDRESS } = process.env;

  if (!RPC_URL || !ADMIN_PRIVATE_KEY || !REGISTRY_ADDRESS) {
    throw new Error(
      'Missing required env vars. Set RPC_URL, ADMIN_PRIVATE_KEY, and REGISTRY_ADDRESS in .env'
    );
  }

  /* ── Load CSV (same directory as this script) ────────────────────────── */
  const csvPath = path.join(__dirname, 'employees.csv');
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found at ${csvPath}`);
  }
  const raw  = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });

  if (!rows.length) {
    console.log('No rows found in CSV — nothing to seed.');
    return;
  }

  /* ── Connect ─────────────────────────────────────────────────────────── */
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
  const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, wallet);

  console.log(`\n🌱  Seeding ${rows.length} employees into EmployeeRegistry at ${REGISTRY_ADDRESS}…`);
  console.log(`    Admin wallet: ${wallet.address}\n`);

  /* ── Filter out already-registered employees to avoid reverts ────────── */
  const toRegister = [];
  for (const row of rows) {
    const companyId = (row['Company ID'] || '').trim();
    if (!companyId) continue;
    try {
      const { exists } = await registry.getEmployee(companyId);
      if (exists) {
        console.log(`  ↩  ${companyId} already registered — skipping`);
      } else {
        toRegister.push(row);
      }
    } catch {
      // If getEmployee fails (e.g., wrong contract), include it and let the tx fail
      toRegister.push(row);
    }
  }

  if (!toRegister.length) {
    console.log('\n✅  All employees already registered. Nothing to do.\n');
    return;
  }

  /* ── Batch-register remaining employees ──────────────────────────────── */
  for (let i = 0; i < toRegister.length; i += BATCH_SIZE) {
    const chunk      = toRegister.slice(i, i + BATCH_SIZE);
    const companyIds = chunk.map(r => (r['Company ID'] || '').trim());
    const names      = chunk.map(r => (r['Employee Name'] || '').trim());
    const wallets    = chunk.map(r => (r['MetaMask Address'] || '').trim());

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`  📦  Batch ${batchNum}: registering ${chunk.length} employees…`);

    try {
      const tx = await registry.addEmployeesBulk(companyIds, names, wallets);
      console.log(`      tx: ${tx.hash}`);
      await tx.wait();
      console.log(`      ✅  confirmed`);
    } catch (err) {
      // If bulk fails (e.g., one entry already exists), try one by one
      console.warn(`      ⚠  Bulk failed (${err.reason || err.message}), retrying one-by-one…`);
      for (let j = 0; j < chunk.length; j++) {
        try {
          const tx = await registry.addEmployee(companyIds[j], names[j], wallets[j]);
          await tx.wait();
          console.log(`      ✅  ${companyIds[j]} registered`);
        } catch (e2) {
          console.warn(`      ❌  ${companyIds[j]} failed: ${e2.reason || e2.message}`);
        }
      }
    }
  }

  console.log('\n✅  Registry seeded successfully.\n');
}

main().catch(err => {
  console.error('\n❌  seedRegistry failed:', err.message);
  process.exit(1);
});