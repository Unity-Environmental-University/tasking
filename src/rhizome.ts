import { Pool } from 'pg';
import type { Task, Phase } from './types';

export const rhizomePool = new Pool({ database: 'rhizome-alkahest' });

const FALLBACK_OBSERVER = 'tasking-system';
const CLAUDE_OBSERVER = 'unity-rhizome-alkahest';
const HALLIE_OBSERVER = 'hallie';
const COMPOSITE_OBSERVER = 'unity-rhizome-alkahest+hallie';
const ALL_OBSERVERS = [HALLIE_OBSERVER, CLAUDE_OBSERVER, COMPOSITE_OBSERVER, FALLBACK_OBSERVER];

export function observerFor(source: string | null): string {
  if (!source || source === 'hallie') return HALLIE_OBSERVER;
  if (source === 'claude') return CLAUDE_OBSERVER;
  if (source === 'claude:hallie') return COMPOSITE_OBSERVER;
  return FALLBACK_OBSERVER;
}

export function taskRef(task: Task): string {
  return task.slug ? `task:${task.slug}` : `task:${task.id}`;
}

async function edge(subject: string, predicate: string, object: string, opts: { phase?: Phase; notes?: string; observer?: string } = {}) {
  try {
    await rhizomePool.query(
      `INSERT INTO edges (subject, predicate, object, phase, observer, notes)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [subject, predicate, object, opts.phase || 'fluid', opts.observer || FALLBACK_OBSERVER, opts.notes || '']
    );
  } catch (e: any) {
    console.error('[rhizome]', e.message);
  }
}

async function dissolve(subject: string, predicate: string, object: string, observer: string = FALLBACK_OBSERVER) {
  try {
    await rhizomePool.query(
      `UPDATE edges SET dissolved_at = NOW()
       WHERE subject = $1 AND predicate = $2 AND object = $3
         AND observer = $4 AND dissolved_at IS NULL`,
      [subject, predicate, object, observer]
    );
  } catch (e: any) {
    console.error('[rhizome]', e.message);
  }
}

export async function onAdd(task: Task) {
  const s = taskRef(task);
  const obs = observerFor(task.source);
  const d = task.task_date instanceof Date ? task.task_date.toISOString().slice(0, 10) : String(task.task_date).slice(0, 10);
  await edge(s, 'records', task.body, { phase: 'fluid', notes: `created ${d}`, observer: obs });
  if (task.source && task.source !== 'hallie') {
    await edge(s, 'originated-by', task.source, { phase: 'salt', observer: obs });
  }
  if (task.project) await edge(s, 'scoped-to', task.project, { phase: 'fluid', observer: obs });
  if (task.tags?.includes('c')) await edge(s, 'flagged-for', 'claude', { phase: 'fluid', observer: obs });
}

export async function onComplete(task: Task, note?: string) {
  const s = taskRef(task);
  const obs = observerFor(task.source);
  const date = new Date().toISOString().slice(0, 10);
  await dissolve(s, 'records', task.body, obs);
  await edge(s, 'completed-on', date, { phase: 'salt', notes: task.body, observer: obs });
  if (note) await edge(s, 'closed-with', note, { phase: 'salt', notes: `closing note: ${note}`, observer: obs });
}

export async function onCancel(task: Task) {
  const s = taskRef(task);
  const obs = observerFor(task.source);
  const date = new Date().toISOString().slice(0, 10);
  await dissolve(s, 'records', task.body, obs);
  await edge(s, 'cancelled-on', date, { phase: 'salt', notes: task.body, observer: obs });
}

export async function onSnooze(task: Task) {
  const s = taskRef(task);
  const obs = observerFor(task.source);
  const to = task.snoozed_to instanceof Date ? task.snoozed_to.toISOString().slice(0, 10) : String(task.snoozed_to).slice(0, 10);
  await rhizomePool.query(
    `UPDATE edges SET dissolved_at = NOW()
     WHERE subject = $1 AND predicate = 'snoozed-to' AND observer = $2 AND dissolved_at IS NULL`,
    [s, obs]
  ).catch(() => {});
  await edge(s, 'snoozed-to', to, { phase: 'fluid', notes: task.body, observer: obs });
}

export async function onMove(task: Task) {
  const s = taskRef(task);
  const obs = observerFor(task.source);
  await rhizomePool.query(
    `UPDATE edges SET dissolved_at = NOW()
     WHERE subject = $1 AND predicate = 'scoped-to' AND observer = $2 AND dissolved_at IS NULL`,
    [s, obs]
  ).catch(() => {});
  if (task.project) await edge(s, 'scoped-to', task.project, { phase: 'fluid', observer: obs });
}

export async function onBlock(blockerId: number, blockedId: number, bodyA: string, bodyB: string) {
  await edge(`task:${blockerId}`, 'blocks', `task:${blockedId}`, { phase: 'fluid', notes: `${bodyA} → ${bodyB}`, observer: FALLBACK_OBSERVER });
}

export async function onUnblock(blockerId: number, blockedId: number) {
  await dissolve(`task:${blockerId}`, 'blocks', `task:${blockedId}`, FALLBACK_OBSERVER);
}

export async function onReply(childTask: Task, parentTask: Task) {
  const childRef = taskRef(childTask);
  const parentRef = taskRef(parentTask);
  const obs = observerFor(childTask.source);
  await edge(childRef, 'reply-to', parentRef, { phase: 'fluid', notes: childTask.body, observer: obs });
}

export async function onAttention(task: Task, who: string) {
  const ref = taskRef(task);
  const obs = observerFor(task.source);
  await edge(ref, 'needs-attention-from', who, { phase: 'fluid', notes: task.body, observer: obs });
}

export async function getBlocking(id: number) {
  const [a, b] = await Promise.all([
    rhizomePool.query(
      `SELECT object, notes FROM edges WHERE subject = $1 AND predicate = 'blocks' AND dissolved_at IS NULL`,
      [`task:${id}`]
    ),
    rhizomePool.query(
      `SELECT subject, notes FROM edges WHERE object = $1 AND predicate = 'blocks' AND dissolved_at IS NULL`,
      [`task:${id}`]
    ),
  ]);
  return {
    blocks: a.rows.map((r: any) => ({ id: parseInt(r.object.replace('task:', '')), notes: r.notes })),
    blocked_by: b.rows.map((r: any) => ({ id: parseInt(r.subject.replace('task:', '')), notes: r.notes })),
  };
}

export async function getAnnotations(id: number) {
  const { rows } = await rhizomePool.query(
    `SELECT notes, created_at FROM edges WHERE subject = $1 AND predicate = 'annotated-by' AND dissolved_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [`task:${id}`]
  );
  return rows[0] || null;
}

export async function getThread(parentRef: string): Promise<Array<{ subject: string; depth: number }>> {
  try {
    const { rows } = await rhizomePool.query(
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
    return rows;
  } catch {
    return [];
  }
}

export async function getReplyCount(ref: string): Promise<number> {
  try {
    const { rows } = await rhizomePool.query(
      `SELECT COUNT(*) as n FROM edges WHERE object = $1 AND predicate = 'reply-to' AND dissolved_at IS NULL`,
      [ref]
    );
    return parseInt(rows[0].n);
  } catch {
    return 0;
  }
}

export async function getActivity(refs: string | string[]) {
  const refList = Array.isArray(refs) ? refs : [refs];
  try {
    const { rows } = await rhizomePool.query(
      `SELECT subject, predicate, object, phase, observer, notes, created_at, dissolved_at
       FROM edges WHERE subject = ANY($1) OR object = ANY($1)
       ORDER BY created_at ASC`,
      [refList]
    );
    return rows;
  } catch {
    return [];
  }
}

export async function getSnoozePatterns() {
  try {
    const { rows } = await rhizomePool.query(
      `SELECT subject, COUNT(*) as snooze_count,
              string_agg(object, ' → ' ORDER BY created_at) as trail
       FROM edges
       WHERE predicate = 'snoozed-to' AND observer = ANY($1)
       GROUP BY subject HAVING COUNT(*) >= 2
       ORDER BY COUNT(*) DESC`,
      [ALL_OBSERVERS]
    );
    return rows.map((r: any) => ({
      id: parseInt(r.subject.replace('task:', '')),
      snooze_count: parseInt(r.snooze_count),
      trail: r.trail,
    }));
  } catch {
    return [];
  }
}

// ── Stories (personas) ────────────────────────────────────────────────────

export async function onStory(task: Task, persona: string) {
  const ref = taskRef(task);
  const obs = observerFor(task.source);
  await edge(ref, 'serves', `persona:${persona}`, { phase: 'fluid', notes: task.body, observer: obs });
}

export async function removeStory(task: Task, persona: string) {
  const ref = taskRef(task);
  const obs = observerFor(task.source);
  await dissolve(ref, 'serves', `persona:${persona}`, obs);
}

export async function getPersonas(): Promise<Array<{ persona: string; task_count: number; tasks: string[] }>> {
  try {
    const { rows } = await rhizomePool.query(
      `SELECT object as persona, COUNT(*) as task_count,
              array_agg(subject ORDER BY subject) as tasks
       FROM edges
       WHERE predicate = 'serves' AND dissolved_at IS NULL
         AND object LIKE 'persona:%'
       GROUP BY object
       ORDER BY COUNT(*) DESC`
    );
    return rows.map((r: any) => ({
      persona: r.persona.replace('persona:', ''),
      task_count: parseInt(r.task_count),
      tasks: r.tasks,
    }));
  } catch {
    return [];
  }
}

export async function getTaskPersonas(ref: string): Promise<string[]> {
  try {
    const { rows } = await rhizomePool.query(
      `SELECT object FROM edges
       WHERE subject = $1 AND predicate = 'serves' AND dissolved_at IS NULL
         AND object LIKE 'persona:%'`,
      [ref]
    );
    return rows.map((r: any) => r.object.replace('persona:', ''));
  } catch {
    return [];
  }
}

export async function getUnreadReplyRoots(entries: Array<{ ref: string; readAt: string | Date }>) {
  if (!entries.length) return [];
  try {
    const results: string[] = [];
    for (const { ref, readAt } of entries) {
      const { rows } = await rhizomePool.query(
        `SELECT 1 FROM edges
         WHERE object = $1 AND predicate = 'reply-to' AND dissolved_at IS NULL AND created_at > $2
         LIMIT 1`,
        [ref, readAt]
      );
      if (rows.length) results.push(ref);
    }
    return results;
  } catch {
    return [];
  }
}
