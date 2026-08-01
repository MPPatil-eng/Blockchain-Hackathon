/**
 * server.js  —  ProofPay AI · Backend
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   1.  Parse employees.csv and expose GET /employee-metrics.json
 *   2.  POST /api/evaluate  — runs Groq LLM, returns score + detailed feedback
 *   3.  GET  /api/employees — list all employees (name + companyId, no secrets)
 *   4.  Serve static frontend (index.html, script.js, style.css) from ./
 *
 * Start:  node server.js        (or  npm start)
 * Port:   3000  (override with PORT env var)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const OpenAI   = require('openai');

const { parse } = require('csv-parse/sync');

/* ─── Config ─────────────────────────────────────────────────────────────── */
const PORT      = process.env.PORT || 3000;
const GROQ_KEY  = process.env.GROQ_API_KEY;
const CSV_PATH  = path.join(__dirname, 'employees.csv');

/* ─── Parse CSV once at startup ──────────────────────────────────────────── */
let employeeRows  = [];    // raw CSV rows
let employeeMap   = {};    // keyed by UPPERCASE companyId → metrics object

try {
  const raw  = fs.readFileSync(CSV_PATH, 'utf8');
  employeeRows = parse(raw, { columns: true, skip_empty_lines: true });

  for (const row of employeeRows) {
    const id = (row['Company ID'] || '').trim().toUpperCase();
    if (!id) continue;
    employeeMap[id] = {
      name:              (row['Employee Name'] || '').trim(),
      companyId:         id,
      avgWorkHours:      parseFloat(row['Avg Work Hours/Day'])       || 0,
      avgExtraHours:     parseFloat(row['Avg Extra Time (Hours/Day)']) || 0,
      leaves:            parseInt(row['Leaves (Last 3 Months)'])     || 0,
      projectsCompleted: parseInt(row['Projects Completed (Last 3 Months)']) || 0,
      wallet:            (row['MetaMask Address'] || '').trim(),
    };
  }
  console.log(`✅ Loaded ${Object.keys(employeeMap).length} employees from ${CSV_PATH}`);
} catch (err) {
  console.error('❌ Could not read employees.csv:', err.message);
}

/* ─── Groq client (OpenAI-compatible) ────────────────────────────────────── */
let groq = null;
if (GROQ_KEY) {
  groq = new OpenAI({ apiKey: GROQ_KEY, baseURL: 'https://api.groq.com/openai/v1' });
  console.log('✅ Groq API client initialised');
} else {
  console.warn('⚠️  GROQ_API_KEY not set — /api/evaluate will return mock data');
}

/* ─── Retry helper (handles transient Groq network drops) ─────────────────── */
async function callGroqWithRetry(params, maxRetries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await groq.chat.completions.create(params);
    } catch (err) {
      lastErr = err;
      const isTransient = err.message && (
        err.message.includes('Premature close') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('fetch failed')
      );
      if (isTransient && attempt < maxRetries) {
        console.warn(`  Groq attempt ${attempt} failed (${err.message}) — retrying in ${attempt}s…`);
        await new Promise(r => setTimeout(r, attempt * 1000));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

/* ─── Express app ────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json());

/* ─────────────────────────────────────────────────────────────────────────
   CORS — allow the frontend (same origin in prod, or localhost:3000 in dev)
   ───────────────────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ─────────────────────────────────────────────────────────────────────────
   GET /employee-metrics.json
   Returns the full metrics object keyed by companyId so script.js can
   enrich the AI feedback prompt with real numbers.
   ───────────────────────────────────────────────────────────────────────── */
app.get('/employee-metrics.json', (_req, res) => {
  res.json(employeeMap);
});

/* ─────────────────────────────────────────────────────────────────────────
   GET /api/employees
   Returns a lightweight list for UI autocomplete / admin views.
   ───────────────────────────────────────────────────────────────────────── */
app.get('/api/employees', (_req, res) => {
  const list = Object.values(employeeMap).map(e => ({
    name: e.name,
    companyId: e.companyId,
    wallet: e.wallet,
  }));
  res.json({ employees: list });
});

/* ─────────────────────────────────────────────────────────────────────────
   POST /api/evaluate
   Body: { name: string, companyId: string }
   Returns: { score, summary, strengths, weaknesses, improvement_suggestions }
   ───────────────────────────────────────────────────────────────────────── */
app.post('/api/evaluate', async (req, res) => {
  const { name, companyId } = req.body || {};

  if (!name || !companyId) {
    return res.status(400).json({ error: 'name and companyId are required' });
  }

  const emp = employeeMap[companyId.trim().toUpperCase()];
  if (!emp) {
    return res.status(404).json({ error: 'Employee not found in CSV' });
  }

  // Case-insensitive name check
  if (emp.name.toLowerCase() !== name.trim().toLowerCase()) {
    return res.status(403).json({ error: 'Name does not match company ID' });
  }

  /* ── Mock fallback when no API key ─────────────────────────────────── */
  if (!groq) {
    return res.json({
      score: 74,
      summary: 'Mock response — add GROQ_API_KEY to .env for real AI evaluation.',
      strengths: ['Shows up regularly', 'Completed some projects'],
      weaknesses: ['Low project output'],
      improvement_suggestions: ['Set weekly project goals', 'Reduce unplanned leaves'],
    });
  }

  /* ── Build LLM prompt ───────────────────────────────────────────────── */
  const prompt = `You are a senior HR performance evaluation expert with 15 years of experience.
Analyze this employee's last 3 months of work data and give a detailed, honest, human-sounding evaluation.
Be specific — mention actual numbers from their data in your feedback.

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

Return ONLY valid JSON, no extra text, no markdown fences:
{
  "score": <number 0-100>,
  "summary": "<2-3 sentences, mention specific numbers>",
  "strengths": ["<strength with specific data>", "<strength>", "<strength>"],
  "weaknesses": ["<weakness with specific data>", "<weakness>"],
  "improvement_suggestions": ["<specific actionable suggestion>", "<suggestion>", "<suggestion>"]
}`;

  try {
    const completion = await callGroqWithRetry({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 700,
      temperature: 0.7,
    });

    let raw = completion.choices[0].message.content.trim();

    // Strip markdown fences if the model adds them
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }

    const result = JSON.parse(raw);
    return res.json(result);

  } catch (err) {
    console.error('LLM evaluation error:', err.message);
    return res.status(500).json({ error: 'LLM evaluation failed', detail: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   POST /api/feedback
   Body: { score, previewReward, symbol, companyId }
   Returns: { text } — short 3-5 sentence dashboard feedback paragraph
   This is the endpoint script.js calls for the "Performance feedback" panel.
   ───────────────────────────────────────────────────────────────────────── */
app.post('/api/feedback', async (req, res) => {
  const { score, previewReward, symbol, companyId } = req.body || {};

  if (score === undefined) {
    return res.status(400).json({ error: 'score is required' });
  }

  const emp = companyId ? employeeMap[companyId.trim().toUpperCase()] : null;

  if (!groq) {
    return res.json({
      text: `Your performance score of ${score}/100 has been recorded on-chain. ${
        score > 50
          ? `You are eligible to claim ${previewReward} ${symbol || 'PPAY'} tokens as your reward.`
          : 'Your score is 50 or below — keep pushing to unlock rewards next cycle!'
      } Keep up the great work and aim for consistent project delivery.`
    });
  }

  const system = `You write short, direct performance feedback for an employee reward system called ProofPay.
You are given: the employee's 3-month work metrics (if available), their numeric performance score (0-100), and the exact token reward amount already calculated by the smart contract.
Write 3-5 sentences, second person ("you"), that: (1) point out the specific metric(s) that most likely held the score back (e.g. leaves taken, low extra hours, fewer completed projects) without being harsh, (2) acknowledge the metric(s) that helped the score, (3) state the exact reward token amount given and tie it plainly to the score. Do not invent numbers not given to you. Do not use markdown formatting.`;

  let userMsg = `Score: ${score}/100\nReward amount: ${previewReward || 0} ${symbol || 'PPAY'} tokens`;
  if (emp) {
    userMsg = `Average work hours/day: ${emp.avgWorkHours}
Average extra hours/day: ${emp.avgExtraHours}
Leaves taken (3 months): ${emp.leaves}
Projects completed (3 months): ${emp.projectsCompleted}
${userMsg}`;
  }

  try {
    const completion = await callGroqWithRetry({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      max_tokens: 300,
      temperature: 0.7,
    });

    const text = completion.choices[0].message.content.trim();
    return res.json({ text });

  } catch (err) {
    console.error('Feedback generation error:', err.message);
    return res.status(500).json({ error: 'Feedback generation failed', detail: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   Serve static frontend files (index.html, script.js, style.css, etc.)
   ───────────────────────────────────────────────────────────────────────── */
app.use(express.static(path.join(__dirname)));

/* ─── Start ──────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n🚀  ProofPay backend running at http://localhost:${PORT}`);
  console.log(`   Open http://localhost:${PORT} in your browser\n`);
});
