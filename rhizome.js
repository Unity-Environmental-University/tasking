// rhizome.js — write task lifecycle edges into rhizome-alkahest
const pool = require('./rhizome-pool');

// Map task.source to a rhizome observer frame.
// Authority lives in the originating frame, not a generic system observer.
// parallax(subject) will then show where hallie and claude disagree on what matters.
const FALLBACK_OBSERVER = 'tasking-system';
const CLAUDE_OBSERVER = 'unity-rhizome-alkahest';
const HALLIE_OBSERVER = 'hallie';
const COMPOSITE_OBSERVER = 'unity-rhizome-alkahest+hallie';

function observerFor(source) {
  if (!source || source === 'hallie') return HALLIE_OBSERVER;
  if (source === 'claude') return CLAUDE_OBSERVER;
  if (source === 'claude:hallie') return COMPOSITE_OBSERVER;
  return FALLBACK_OBSERVER;
}

async function edge(subject, predicate, object, { phase = 'fluid', notes = '', observer = FALLBACK_OBSERVER } = {}) {
  try {
    await pool.query(
      `INSERT INTO edges (subject, predicate, object, phase, observer, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [subject, predicate, object, phase, observer, notes]
    );
  } catch (e) {
    // never let rhizome errors break tasking
    console.error('[rhizome]', e.message);
  }
}

async function dissolve(subject, predicate, object, observer = FALLBACK_OBSERVER) {
  try {
    await pool.query(
      `UPDATE edges SET dissolved_at = NOW()
       WHERE subject = $1 AND predicate = $2 AND object = $3
         AND observer = $4 AND dissolved_at IS NULL`,
      [subject, predicate, object, observer]
    );
  } catch (e) {
    console.error('[rhizome]', e.message);
  }
}

// Use slug as edge subject when available — makes graph edges human-legible
function taskRef(task) {
  return task.slug ? `task:${task.slug}` : `task:${task.id}`;
}

async function onAdd(task) {
  const s = taskRef(task);
  const obs = observerFor(task.source);
  const notes = `created ${task.task_date instanceof Date ? task.task_date.toISOString().slice(0,10) : String(task.task_date).slice(0,10)}`;
  await edge(s, 'records', task.body, { phase: 'fluid', notes, observer: obs });
  if (task.source && task.source !== 'hallie') {
    // record authority explicitly so parallax can surface it
    await edge(s, 'originated-by', task.source, { phase: 'salt', observer: obs });
  }
  if (task.project) await edge(s, 'scoped-to', task.project, { phase: 'fluid', observer: obs });
  if (task.tags && task.tags.includes('c')) await edge(s, 'flagged-for', 'claude', { phase: 'fluid', observer: obs });
}

async function onComplete(task, note) {
  const s = taskRef(task);
  const obs = observerFor(task.source);
  const date = new Date().toISOString().slice(0, 10);
  await dissolve(s, 'records', task.body, obs);
  await edge(s, 'completed-on', date, { phase: 'salt', notes: task.body, observer: obs });
  if (note) await edge(s, 'closed-with', note, { phase: 'salt', notes: `closing note: ${note}`, observer: obs });
}

async function onCancel(task) {
  const s = taskRef(task);
  const obs = observerFor(task.source);
  const date = new Date().toISOString().slice(0, 10);
  await dissolve(s, 'records', task.body, obs);
  await edge(s, 'cancelled-on', date, { phase: 'salt', notes: task.body, observer: obs });
}

async function onSnooze(task) {
  const s = taskRef(task);
  const obs = observerFor(task.source);
  const to = task.snoozed_to instanceof Date ? task.snoozed_to.toISOString().slice(0,10) : String(task.snoozed_to).slice(0,10);
  // dissolve old snooze edge if any, write new one
  await pool.query(
    `UPDATE edges SET dissolved_at = NOW()
     WHERE subject = $1 AND predicate = 'snoozed-to' AND observer = $2 AND dissolved_at IS NULL`,
    [s, obs]
  ).catch(() => {});
  await edge(s, 'snoozed-to', to, { phase: 'fluid', notes: task.body, observer: obs });
}

async function onMove(task) {
  const s = taskRef(task);
  const obs = observerFor(task.source);
  // dissolve old scoped-to
  await pool.query(
    `UPDATE edges SET dissolved_at = NOW()
     WHERE subject = $1 AND predicate = 'scoped-to' AND observer = $2 AND dissolved_at IS NULL`,
    [s, obs]
  ).catch(() => {});
  if (task.project) await edge(s, 'scoped-to', task.project, { phase: 'fluid', observer: obs });
}

async function onBlock(blockerId, blockedId, bodyA, bodyB) {
  await edge(`task:${blockerId}`, 'blocks', `task:${blockedId}`, { phase: 'fluid', notes: `${bodyA} → ${bodyB}`, observer: FALLBACK_OBSERVER });
}

async function onUnblock(blockerId, blockedId) {
  await dissolve(`task:${blockerId}`, 'blocks', `task:${blockedId}`, FALLBACK_OBSERVER);
}

async function getBlocking(id) {
  // returns { blocks: [...], blocked_by: [...] }
  const [a, b] = await Promise.all([
    pool.query(
      `SELECT object, notes FROM edges WHERE subject = $1 AND predicate = 'blocks' AND dissolved_at IS NULL`,
      [`task:${id}`]
    ),
    pool.query(
      `SELECT subject, notes FROM edges WHERE object = $1 AND predicate = 'blocks' AND dissolved_at IS NULL`,
      [`task:${id}`]
    ),
  ]);
  return {
    blocks: a.rows.map(r => ({ id: parseInt(r.object.replace('task:', '')), notes: r.notes })),
    blocked_by: b.rows.map(r => ({ id: parseInt(r.subject.replace('task:', '')), notes: r.notes })),
  };
}

async function getAnnotations(id) {
  const { rows } = await pool.query(
    `SELECT notes, created_at FROM edges WHERE subject = $1 AND predicate = 'annotated-by' AND dissolved_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [`task:${id}`]
  );
  return rows[0] || null;
}

async function onReply(childTask, parentTask) {
  const childRef = taskRef(childTask);
  const parentRef = taskRef(parentTask);
  const obs = observerFor(childTask.source);
  await edge(childRef, 'reply-to', parentRef, { phase: 'fluid', notes: childTask.body, observer: obs });
}

// Returns flat list of tasks in thread rooted at parentRef, in creation order.
// Each row has { id, slug, body, status, source, created_at, depth }
async function getThread(parentRef) {
  // Traverse reply-to edges upward from parent
  try {
    const { rows } = await pool.query(
      `WITH RECURSIVE thread AS (
         SELECT subject, 0 as depth FROM edges
         WHERE object = $1 AND predicate = 'reply-to' AND dissolved_at IS NULL
         UNION ALL
         SELECT e.subject, t.depth + 1 FROM edges e
         JOIN thread t ON e.object = t.subject
         WHERE e.predicate = 'reply-to' AND e.dissolved_at IS NULL
       )
       SELECT subject, depth FROM thread ORDER BY depth, subject`,
      [parentRef]
    );
    return rows; // [{ subject: 'task:5', depth: 0 }, ...]
  } catch (e) {
    return [];
  }
}

async function getReplyCount(taskRef) {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as n FROM edges WHERE object = $1 AND predicate = 'reply-to' AND dissolved_at IS NULL`,
      [taskRef]
    );
    return parseInt(rows[0].n);
  } catch (e) {
    return 0;
  }
}

// Full arc for a task: all edges where task is subject or object, ordered by time.
// Accepts an array of refs to handle cases where slug was set after edges were written
// (edges may use task:5 while current ref is task:my-slug).
async function getActivity(refs) {
  const refList = Array.isArray(refs) ? refs : [refs];
  try {
    const { rows } = await pool.query(
      `SELECT subject, predicate, object, phase, observer, notes, created_at, dissolved_at
       FROM edges
       WHERE subject = ANY($1) OR object = ANY($1)
       ORDER BY created_at ASC`,
      [refList]
    );
    return rows;
  } catch (e) {
    return [];
  }
}

async function getSnoozePatterns() {
  // Tasks snoozed 2+ times — signal of avoidance or being blocked
  // Search across all authority frames (hallie, claude, composite, fallback)
  const authorityFrames = [HALLIE_OBSERVER, CLAUDE_OBSERVER, COMPOSITE_OBSERVER, FALLBACK_OBSERVER];
  try {
    const { rows } = await pool.query(
      `SELECT subject, COUNT(*) as snooze_count,
              string_agg(object, ' → ' ORDER BY created_at) as trail
       FROM edges
       WHERE predicate = 'snoozed-to' AND observer = ANY($1)
       GROUP BY subject
       HAVING COUNT(*) >= 2
       ORDER BY COUNT(*) DESC`,
      [authorityFrames]
    );
    return rows.map(r => ({
      id: parseInt(r.subject.replace('task:', '')),
      snooze_count: parseInt(r.snooze_count),
      trail: r.trail,
    }));
  } catch (e) {
    return [];
  }
}

// Given an array of { ref, readAt } objects, returns refs that have reply-to edges
// newer than readAt (or newer than task creation if never read).
async function getUnreadReplyRoots(entries) {
  if (!entries.length) return [];
  try {
    const results = [];
    for (const { ref, readAt } of entries) {
      const { rows } = await pool.query(
        `SELECT 1 FROM edges
         WHERE object = $1
           AND predicate = 'reply-to'
           AND dissolved_at IS NULL
           AND created_at > $2
         LIMIT 1`,
        [ref, readAt]
      );
      if (rows.length) results.push(ref);
    }
    return results;
  } catch (e) {
    return [];
  }
}

module.exports = { onAdd, onComplete, onCancel, onSnooze, onMove, onBlock, onUnblock, onReply, getBlocking, getAnnotations, getSnoozePatterns, getThread, getReplyCount, getActivity, getUnreadReplyRoots, taskRef };
