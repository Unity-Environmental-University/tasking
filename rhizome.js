// rhizome.js — write task lifecycle edges into rhizome-alkahest
const { Pool } = require('pg');

const pool = new Pool({ database: 'rhizome-alkahest' });
const OBSERVER = 'tasking-system';

async function edge(subject, predicate, object, { phase = 'fluid', notes = '' } = {}) {
  try {
    await pool.query(
      `INSERT INTO edges (subject, predicate, object, phase, observer, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [subject, predicate, object, phase, OBSERVER, notes]
    );
  } catch (e) {
    // never let rhizome errors break tasking
    console.error('[rhizome]', e.message);
  }
}

async function dissolve(subject, predicate, object) {
  try {
    await pool.query(
      `UPDATE edges SET dissolved_at = NOW()
       WHERE subject = $1 AND predicate = $2 AND object = $3
         AND observer = $4 AND dissolved_at IS NULL`,
      [subject, predicate, object, OBSERVER]
    );
  } catch (e) {
    console.error('[rhizome]', e.message);
  }
}

async function onAdd(task) {
  const s = `task:${task.id}`;
  const notes = `created ${task.task_date instanceof Date ? task.task_date.toISOString().slice(0,10) : String(task.task_date).slice(0,10)}`;
  await edge(s, 'records', task.body, { phase: 'fluid', notes });
  if (task.project) await edge(s, 'scoped-to', task.project, { phase: 'fluid' });
  if (task.tags && task.tags.includes('c')) await edge(s, 'flagged-for', 'claude', { phase: 'fluid' });
}

async function onComplete(task) {
  const s = `task:${task.id}`;
  const date = new Date().toISOString().slice(0, 10);
  await dissolve(s, 'records', task.body);
  await edge(s, 'completed-on', date, { phase: 'salt', notes: task.body });
}

async function onCancel(task) {
  const s = `task:${task.id}`;
  const date = new Date().toISOString().slice(0, 10);
  await dissolve(s, 'records', task.body);
  await edge(s, 'cancelled-on', date, { phase: 'salt', notes: task.body });
}

async function onSnooze(task) {
  const s = `task:${task.id}`;
  const to = task.snoozed_to instanceof Date ? task.snoozed_to.toISOString().slice(0,10) : String(task.snoozed_to).slice(0,10);
  // dissolve old snooze edge if any, write new one
  await pool.query(
    `UPDATE edges SET dissolved_at = NOW()
     WHERE subject = $1 AND predicate = 'snoozed-to' AND observer = $2 AND dissolved_at IS NULL`,
    [s, OBSERVER]
  ).catch(() => {});
  await edge(s, 'snoozed-to', to, { phase: 'fluid', notes: task.body });
}

async function onMove(task) {
  const s = `task:${task.id}`;
  // dissolve old scoped-to
  await pool.query(
    `UPDATE edges SET dissolved_at = NOW()
     WHERE subject = $1 AND predicate = 'scoped-to' AND observer = $2 AND dissolved_at IS NULL`,
    [s, OBSERVER]
  ).catch(() => {});
  if (task.project) await edge(s, 'scoped-to', task.project, { phase: 'fluid' });
}

module.exports = { onAdd, onComplete, onCancel, onSnooze, onMove };
