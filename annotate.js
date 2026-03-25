#!/usr/bin/env node
// annotate.js — Qwen annotation loop for open tasks
//
// Pulls open tasks from the tasking db, asks Qwen7B for clarity assessment,
// writes edges into rhizome-alkahest, and surfaces stuck+unclear tasks as
// visible notes only when they've been open 3+ days.
//
// Usage:
//   node annotate.js              — run a batch (up to 5 tasks)
//   node annotate.js --dry-run    — print what would happen, no writes

'use strict';

const https = require('https');
const http = require('http');

const QWEN_URL = 'http://localhost:5052/generate';
const BATCH_SIZE = 5;
const SKIP_IF_ANNOTATED_WITHIN_HOURS = 24;
const STUCK_DAYS = 3;
const DRY_RUN = process.argv.includes('--dry-run');

// Heuristic: Qwen said something is unclear if response contains these signals
const UNCLEAR_SIGNALS = [
  'unclear', 'vague', 'ambiguous', 'not clear',
  'need more', 'needs more', 'specify', 'more information',
  'more detail', 'more context', 'lacking', 'missing',
  'no context', 'without context', 'insufficient',
];

// Use shared pool modules (separate process = separate connections, but same config)
const taskingPool = require('./dist/db').pool;
const rhizomePool = require('./dist/rhizome').rhizomePool;
const OBSERVER = 'tasking-system';

// ── Qwen ────────────────────────────────────────────────────────────────────

async function askQwen(prompt, maxTokens = 150) {
  const body = JSON.stringify({ prompt, max_tokens: maxTokens });
  return new Promise((resolve, reject) => {
    const url = new URL(QWEN_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Qwen parse error: ${e.message} — raw: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('Qwen request timed out')); });
    req.write(body);
    req.end();
  });
}

function isUnclear(response) {
  const lower = response.toLowerCase();
  return UNCLEAR_SIGNALS.some(sig => lower.includes(sig));
}

// ── Rhizome ──────────────────────────────────────────────────────────────────
// Note: uses ON CONFLICT ... DO UPDATE (not DO NOTHING like rhizome.js).
// This is intentional — annotations should update with the latest Qwen assessment,
// while lifecycle edges (add/complete/cancel) should never overwrite.

async function rhizomeEdge(subject, predicate, object, { phase = 'fluid', notes = '' } = {}) {
  if (DRY_RUN) {
    console.log(`  [dry] edge: ${subject} --${predicate}--> ${object}`);
    if (notes) console.log(`        notes: ${notes.slice(0, 100)}`);
    return;
  }
  try {
    await rhizomePool.query(
      `INSERT INTO edges (subject, predicate, object, phase, observer, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (subject, predicate, object, observer) WHERE dissolved_at IS NULL DO UPDATE
         SET notes = EXCLUDED.notes, updated_at = NOW()`,
      [subject, predicate, object, phase, OBSERVER, notes]
    );
  } catch (e) {
    console.error(`[rhizome] ${e.message}`);
  }
}

// Check if a task was annotated by Qwen within the last N hours
async function recentlyAnnotated(taskId, hours) {
  const { rows } = await rhizomePool.query(
    `SELECT id FROM edges
     WHERE subject = $1 AND predicate = 'annotated-by' AND object = 'qwen'
       AND observer = $2 AND dissolved_at IS NULL
       AND updated_at > NOW() - INTERVAL '${hours} hours'`,
    [`task:${taskId}`, OBSERVER]
  );
  return rows.length > 0;
}

// ── Tasking DB ───────────────────────────────────────────────────────────────

async function getOpenTasksBatch(limit) {
  // Skip log entries, tasks with no body, prefer oldest created_at
  const { rows } = await taskingPool.query(
    `SELECT id, body, status, task_date, created_at
     FROM tasks
     WHERE status = 'open'
       AND body IS NOT NULL AND trim(body) != ''
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit * 3] // fetch extra so we can filter already-annotated
  );
  return rows;
}

// ── Main annotation loop ─────────────────────────────────────────────────────

function daysOpen(task) {
  const created = task.created_at instanceof Date ? task.created_at : new Date(task.created_at);
  const now = new Date();
  return (now - created) / (1000 * 60 * 60 * 24);
}

async function annotateTask(task) {
  const subject = `task:${task.id}`;
  const days = daysOpen(task);

  const prompt =
    `This task reads: "${task.body}". ` +
    `Is this clear enough to act on? What is the likely next physical action? ` +
    `Are there any obvious blockers? Reply in 2-3 sentences.`;

  console.log(`\n[${task.id}] ${task.body.slice(0, 80)}${task.body.length > 80 ? '…' : ''}`);
  console.log(`  open ${days.toFixed(1)} days — asking Qwen...`);

  let qwenResponse;
  try {
    const result = await askQwen(prompt, 150);
    qwenResponse = (result.response || '').trim();
  } catch (e) {
    console.error(`  Qwen error: ${e.message}`);
    return;
  }

  if (!qwenResponse) {
    console.log('  Qwen returned empty response, skipping.');
    return;
  }

  console.log(`  Qwen: ${qwenResponse.slice(0, 120)}${qwenResponse.length > 120 ? '…' : ''}`);

  const unclear = isUnclear(qwenResponse);
  const stuck = days >= STUCK_DAYS;

  // Always write the annotation edge
  await rhizomeEdge(subject, 'annotated-by', 'qwen', {
    phase: 'fluid',
    notes: qwenResponse,
  });

  // If unclear, write a needs-clarification edge
  if (unclear) {
    console.log('  -> flagged unclear');
    await rhizomeEdge(subject, 'needs-clarification', 'intent-or-scope', {
      phase: 'fluid',
      notes: `Qwen assessment: ${qwenResponse}`,
    });
  }

  // Only escalate to a visible t note if stuck 3+ days AND unclear
  if (stuck && unclear) {
    console.log(`  -> ESCALATING: stuck ${days.toFixed(0)} days and unclear`);
    if (!DRY_RUN) {
      // Write a high-visibility edge that tools can surface
      await rhizomeEdge(subject, 'escalated-for-review', 'owner', {
        phase: 'fluid',
        notes: `Task open ${days.toFixed(0)} days. Qwen: ${qwenResponse}`,
      });
    } else {
      console.log(`  [dry] escalation edge would be written`);
    }
  }
}

async function run() {
  console.log(`Qwen annotation run — ${new Date().toISOString()}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  let candidates;
  try {
    candidates = await getOpenTasksBatch(BATCH_SIZE * 3);
  } catch (e) {
    console.error('Failed to fetch tasks:', e.message);
    process.exit(1);
  }

  if (!candidates.length) {
    console.log('No open tasks to annotate.');
    await cleanup();
    return;
  }

  // Filter out recently annotated
  const toProcess = [];
  for (const task of candidates) {
    if (toProcess.length >= BATCH_SIZE) break;
    const skip = !DRY_RUN && await recentlyAnnotated(task.id, SKIP_IF_ANNOTATED_WITHIN_HOURS);
    if (skip) {
      console.log(`[${task.id}] skipping — annotated within ${SKIP_IF_ANNOTATED_WITHIN_HOURS}h`);
      continue;
    }
    toProcess.push(task);
  }

  if (!toProcess.length) {
    console.log('All candidates annotated recently — nothing to do.');
    await cleanup();
    return;
  }

  console.log(`Processing ${toProcess.length} task(s)...`);

  for (const task of toProcess) {
    await annotateTask(task);
  }

  // Print escalations summary
  const escalated = [];
  for (const task of toProcess) {
    const days = daysOpen(task);
    if (days >= STUCK_DAYS) escalated.push(task);
  }

  if (escalated.length) {
    console.log(`\n--- Tasks stuck 3+ days ---`);
    for (const t of escalated) {
      console.log(`  [${t.id}] ${t.body.slice(0, 80)} (${daysOpen(t).toFixed(0)}d)`);
    }
  }

  console.log('\nDone.');
  await cleanup();
}

async function cleanup() {
  await taskingPool.end();
  await rhizomePool.end();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
