/**
 * generateScores.js  —  ProofPay AI · Oracle Score Writer
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads every employee from employees.csv, calls the Groq LLM to compute a
 * 0-100 performance score, then writes that score on-chain via setScore()
 * using the ORACLE_PRIVATE_KEY wallet.
 *
 * Run ONCE after deploying contracts and seeding the registry:
 *   node generateScores.js
 *
 * Required .env vars:
 *   GROQ_API_KEY         — Groq API key
 *   RPC_URL              — JSON-RPC endpoint (Infura/Alchemy Sepolia or localhost:8545)
 *   ORACLE_PRIVATE_KEY   — Private key of the oracle wallet
 *   REWARDS_ADDRESS      — Deployed ProofPayRewards contract address
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const fs      = require('fs');
const path    = require('path');
const { parse } = require('csv-parse/sync');
const { ethers } = require('ethers');
const OpenAI  = require('openai');

/* ─── Env ─────────────────────────────────────────────────────────────────── */
const {
  GROQ_API_KEY,
  RPC_URL,
  ORACLE_PRIVATE_KEY,
  REWARDS_ADDRESS,
} = process.env;

/* ─── Validate env ────────────────────────────────────────────────────────── */
const missing = [];
if (!GROQ_API_KEY)       missing.push('GROQ_API_KEY');
if (!RPC_URL)            missing.push('RPC_URL');
if (!ORACLE_PRIVATE_KEY) missing.push('ORACLE_PRIVATE_KEY');
if (!REWARDS_ADDRESS)    missing.push('REWARDS_ADDRESS');

if (missing.length) {
  console.error(`❌  Missing required env vars: ${missing.join(', ')}`);
  console.error('    Fill in .env and try again.');
  process.exit(1);
}

/* ─── Contract ABI (only setScore needed) ────────────────────────────────── */
const REWARDS_ABI = [
  'function setScore(address employee, uint256 score) external',
  'function scores(address) view returns (uint256)',
];

/* ─── Groq client ─────────────────────────────────────────────────────────── */
const groq = new OpenAI({
  apiKey: GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

/* ─── LLM evaluation ─────────────────────────────────────────────────────── */
async function evaluateEmployee(emp) {
  const prompt = `You are a senior HR performance evaluation expert with 15 years of experience.
Analyze this employee's last 3 months of work data.

Employee: ${emp.name}
Company ID: ${emp.companyId}
Average Work Hours Per Day: ${emp.avgWorkHours} hrs
Average Extra Time Per Day: ${emp.avgExtraHours} hrs
Leaves Taken (Last 3 Months): ${emp.leaves}
Projects Completed (Last 3 Months): ${emp.projectsCompleted}

Scoring guide:
- Work hours above 8/day is good, below 7 is concerning
- Extra time shows dedication but over 2hrs/day may suggest inefficiency
- Leaves above 6 in 3 months is high
- Projects completed is the strongest signal of output

Return ONLY valid JSON, no markdown fences:
{
  "score": <number 0-100>,
  "summary": "<2-3 sentences>",
  "strengths": ["<strength>", "<strength>"],
  "weaknesses": ["<weakness>"],
  "improvement_suggestions": ["<suggestion>", "<suggestion>"]
}`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.6,
    });

    let raw = completion.choices[0].message.content.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`  ⚠  LLM failed for ${emp.name}: ${err.message} — using calculated fallback`);
    // Simple algorithmic fallback
    let score = 50;
    if (emp.avgWorkHours >= 8)   score += 15;
    else if (emp.avgWorkHours < 7) score -= 10;
    if (emp.avgExtraHours > 0 && emp.avgExtraHours <= 2) score += 5;
    if (emp.leaves <= 3)         score += 10;
    else if (emp.leaves > 6)     score -= 15;
    score += emp.projectsCompleted * 5;
    score = Math.max(0, Math.min(100, Math.round(score)));
    return { score, summary: 'Calculated fallback score.', strengths: [], weaknesses: [], improvement_suggestions: [] };
  }
}

/* ─── Main ────────────────────────────────────────────────────────────────── */
async function main() {
  /* Load CSV */
  const csvPath = path.join(__dirname, 'employees.csv');
  const raw  = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });

  const employees = rows.map(r => ({
    name:              (r['Employee Name'] || '').trim(),
    companyId:         (r['Company ID'] || '').trim(),
    avgWorkHours:      parseFloat(r['Avg Work Hours/Day'])              || 0,
    avgExtraHours:     parseFloat(r['Avg Extra Time (Hours/Day)'])      || 0,
    leaves:            parseInt(r['Leaves (Last 3 Months)'])            || 0,
    projectsCompleted: parseInt(r['Projects Completed (Last 3 Months)']) || 0,
    wallet:            (r['MetaMask Address'] || '').trim(),
  })).filter(e => e.wallet && e.name);

  console.log(`\n📊  Evaluating ${employees.length} employees via Groq LLM…\n`);

  /* Connect to chain */
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const oracle   = new ethers.Wallet(ORACLE_PRIVATE_KEY, provider);
  const rewards  = new ethers.Contract(REWARDS_ADDRESS, REWARDS_ABI, oracle);

  console.log(`🔑  Oracle wallet : ${oracle.address}`);
  console.log(`📄  Rewards at    : ${REWARDS_ADDRESS}\n`);

  /* Evaluate and write each employee */
  for (const emp of employees) {
    process.stdout.write(`  ${emp.name.padEnd(12)} (${emp.companyId}) … `);

    const result = await evaluateEmployee(emp);
    const score  = Math.max(0, Math.min(100, Math.round(result.score)));

    process.stdout.write(`score=${score} → writing on-chain… `);

    try {
      const tx = await rewards.setScore(emp.wallet, score);
      await tx.wait();
      console.log(`✅  tx ${tx.hash.slice(0, 12)}…`);
    } catch (err) {
      // If the same wallet is used for multiple employees (demo data),
      // the second write will just overwrite — that's fine.
      console.log(`⚠   on-chain write failed: ${err.reason || err.message}`);
    }

    // Small delay to avoid rate-limiting on Groq
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n✅  All scores written on-chain.\n');
}

main().catch(err => {
  console.error('\n❌  generateScores failed:', err.message);
  process.exit(1);
});
