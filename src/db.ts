import { Pool } from 'pg';
import type { Task, Priority, Oncall, CallLogEntry } from './types';

export const pool = new Pool({ database: 'tasking' });

export async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT,
      task_date DATE NOT NULL DEFAULT CURRENT_DATE,
      snoozed_to DATE,
      snoozed_until TIMESTAMPTZ,
      project TEXT,
      tags TEXT[] NOT NULL DEFAULT '{}',
      source TEXT,
      slug TEXT,
      needs_attention TEXT,
      thread_read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);
  // migrations
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS slug TEXT`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS tasks_slug_unique ON tasks (slug) WHERE slug IS NOT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS thread_read_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS needs_attention TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oncall (
      id SERIAL PRIMARY KEY,
      who TEXT NOT NULL,
      until_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_log (
      id SERIAL PRIMARY KEY,
      tool TEXT NOT NULL,
      args JSONB NOT NULL DEFAULT '{}',
      success BOOLEAN NOT NULL DEFAULT true,
      error TEXT,
      duration_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
}

// ── Call logging ──────────────────────────────────────────────────────────

export async function logCall(tool: string, args: Record<string, unknown>, success: boolean, error: string | null, duration_ms: number) {
  await pool.query(
    `INSERT INTO call_log (tool, args, success, error, duration_ms) VALUES ($1, $2, $3, $4, $5)`,
    [tool, JSON.stringify(args), success, error, duration_ms]
  ).catch(e => console.error('[call_log]', e.message));
}

// ── Tasks ─────────────────────────────────────────────────────────────────

export async function add(body: string, opts: { date?: string; project?: string | null; tags?: string[]; source?: string; priority?: Priority } = {}): Promise<Task> {
  const { rows } = await pool.query(
    `INSERT INTO tasks (body, task_date, project, tags, source, priority) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [body, opts.date || new Date().toISOString().slice(0, 10), opts.project || null, opts.tags || [], opts.source || null, opts.priority || null]
  );
  return rows[0];
}

export async function list(opts: { date?: string; project?: string | null } = {}): Promise<Task[]> {
  const d = opts.date || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE status NOT IN ('done', 'cancelled')
       AND task_date <= $1
       AND (snoozed_to IS NULL OR snoozed_to <= $1)
       AND (snoozed_until IS NULL OR snoozed_until <= NOW())
       AND (project IS NULL OR project = $2)
     ORDER BY priority NULLS LAST, project NULLS LAST, task_date, id`,
    [d, opts.project || null]
  );
  return rows;
}

export async function listAllOpen(opts: { date?: string } = {}): Promise<Task[]> {
  const d = opts.date || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE status NOT IN ('done', 'cancelled')
       AND task_date <= $1
       AND (snoozed_to IS NULL OR snoozed_to <= $1)
     ORDER BY priority NULLS LAST, project NULLS LAST, task_date, id`,
    [d]
  );
  return rows;
}

export async function getById(id: number): Promise<Task | null> {
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getBySlug(slug: string): Promise<Task | null> {
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

export async function resolveRef(ref: string): Promise<Task | null> {
  if (/^\d+$/.test(String(ref))) return getById(Number(ref));
  return getBySlug(String(ref));
}

export async function setSlug(id: number, slug: string): Promise<Task | null> {
  const clean = slug.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const { rows } = await pool.query(
    `UPDATE tasks SET slug = $2 WHERE id = $1 RETURNING *`,
    [id, clean]
  );
  return rows[0] || null;
}

export async function setStatus(id: number, status: string): Promise<Task | null> {
  const completedAt = status === 'done' ? 'NOW()' : 'NULL';
  const { rows } = await pool.query(
    `UPDATE tasks SET status = $2, completed_at = ${completedAt} WHERE id = $1 RETURNING *`,
    [id, status]
  );
  return rows[0] || null;
}

export async function setPriority(id: number, priority: Priority): Promise<Task | null> {
  const { rows } = await pool.query(
    `UPDATE tasks SET priority = $2 WHERE id = $1 RETURNING *`,
    [id, priority]
  );
  return rows[0] || null;
}

export async function setProject(id: number, project: string | null): Promise<Task | null> {
  const { rows } = await pool.query(
    `UPDATE tasks SET project = $2 WHERE id = $1 RETURNING *`,
    [id, project]
  );
  return rows[0] || null;
}

export async function moveTask(id: number, project: string | null): Promise<Task | null> {
  const { rows: current } = await pool.query(`SELECT project FROM tasks WHERE id = $1`, [id]);
  if (!current[0]) return null;
  const newProject = current[0].project === project ? null : project;
  return setProject(id, newProject);
}

export async function snooze(id: number, until: string): Promise<Task | null> {
  const hasTime = until.includes('T');
  const date = hasTime ? until.slice(0, 10) : until;
  const { rows } = await pool.query(
    `UPDATE tasks SET snoozed_to = $2, task_date = $2, snoozed_until = $3 WHERE id = $1 RETURNING *`,
    [id, date, hasTime ? until : null]
  );
  return rows[0] || null;
}

export async function editBody(id: number, body: string): Promise<Task | null> {
  const { rows } = await pool.query(
    `UPDATE tasks SET body = $2 WHERE id = $1 RETURNING *`,
    [id, body]
  );
  return rows[0] || null;
}

export async function log(body: string, opts: { date?: string; project?: string | null; tags?: string[] } = {}): Promise<Task> {
  const { rows } = await pool.query(
    `INSERT INTO tasks (body, status, task_date, project, tags) VALUES ($1, 'log', $2, $3, $4) RETURNING *`,
    [body, opts.date || new Date().toISOString().slice(0, 10), opts.project || null, opts.tags || []]
  );
  return rows[0];
}

export async function claudeTasks(): Promise<Task[]> {
  const d = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE status NOT IN ('done', 'cancelled')
       AND task_date <= $1
       AND (snoozed_to IS NULL OR snoozed_to <= $1)
       AND (snoozed_until IS NULL OR snoozed_until <= NOW())
       AND 'c' = ANY(tags)
     ORDER BY priority NULLS LAST, task_date, id`,
    [d]
  );
  return rows;
}

export async function recentDone(opts: { since_hours?: number; project?: string | null } = {}): Promise<Task[]> {
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE status = 'done'
       AND ($2::text IS NULL OR project = $2)
       AND COALESCE(completed_at, created_at) >= NOW() - ($1 || ' hours')::INTERVAL
     ORDER BY COALESCE(completed_at, created_at) DESC`,
    [opts.since_hours || 24, opts.project || null]
  );
  return rows;
}

export async function listAll(opts: { project?: string | null; limit?: number } = {}): Promise<Task[]> {
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE ($1::text IS NULL OR project IS NULL OR project = $1)
     ORDER BY id DESC
     LIMIT $2`,
    [opts.project || null, opts.limit || 50]
  );
  return rows;
}

export async function signal() {
  const { rows: stuck } = await pool.query(
    `SELECT id, body, task_date, project, CURRENT_DATE - task_date::date as age_days
     FROM tasks WHERE status = 'open'
       AND (snoozed_to IS NULL OR snoozed_to <= CURRENT_DATE)
       AND task_date < CURRENT_DATE - INTERVAL '3 days'
     ORDER BY task_date`
  );
  const { rows: deferred } = await pool.query(
    `SELECT id, body, snoozed_to, project, snoozed_to::date - CURRENT_DATE as days_away
     FROM tasks WHERE status = 'open' AND snoozed_to > CURRENT_DATE
     ORDER BY snoozed_to`
  );
  const { rows: clusters } = await pool.query(
    `SELECT COALESCE(SPLIT_PART(project, '/', -1), '(global)') as repo,
            COUNT(*) as open_count, MIN(task_date)::date as oldest
     FROM tasks WHERE status = 'open'
     GROUP BY project ORDER BY open_count DESC`
  );
  const { rows: signals } = await pool.query(
    `SELECT id, body, task_date FROM tasks
     WHERE status = 'open' AND body LIKE 'loop:%' ORDER BY task_date`
  );
  const { rows: velocity } = await pool.query(
    `SELECT COALESCE(completed_at, created_at)::date as day, COUNT(*) as done
     FROM tasks WHERE status = 'done'
       AND COALESCE(completed_at, created_at) >= CURRENT_DATE - INTERVAL '7 days'
     GROUP BY day ORDER BY day DESC`
  );
  return { stuck, deferred, clusters, signals, velocity };
}

export async function markThreadRead(id: number): Promise<Task | null> {
  const { rows } = await pool.query(
    `UPDATE tasks SET thread_read_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

export async function unreadThreads(project: string | null, rhizome: { getUnreadReplyRoots: (entries: Array<{ ref: string; readAt: Date | string }>) => Promise<string[]>; taskRef: (task: Task) => string }): Promise<Task[]> {
  const { rows: candidates } = await pool.query(
    `SELECT * FROM tasks
     WHERE status NOT IN ('done', 'cancelled')
       AND (project IS NULL OR project = $1)
     ORDER BY id`,
    [project || null]
  );
  if (!candidates.length) return [];
  const entries = candidates.map((t: Task) => ({
    ref: rhizome.taskRef(t),
    readAt: t.thread_read_at || t.created_at,
    task: t,
  }));
  const unreadRefs = new Set(await rhizome.getUnreadReplyRoots(entries.map(({ ref, readAt }) => ({ ref, readAt: readAt as string }))));
  return entries.filter(e => unreadRefs.has(e.ref)).map(e => e.task);
}

// ── Attention ─────────────────────────────────────────────────────────────

export async function setAttention(id: number, who: string | null): Promise<Task | null> {
  const { rows } = await pool.query(
    `UPDATE tasks SET needs_attention = $2 WHERE id = $1 RETURNING *`,
    [id, who || null]
  );
  return rows[0] || null;
}

export async function attentionTasks(who: string, project?: string | null): Promise<Task[]> {
  const normalized = who.replace(/^@/, '').toLowerCase();
  const variants = normalized === 'h' ? ['hallie', 'h'] : [normalized];
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE status NOT IN ('done', 'cancelled')
       AND (LOWER(REPLACE(needs_attention, '@', '')) = ANY($1))
     ORDER BY priority NULLS LAST, task_date, id`,
    [variants]
  );
  return rows;
}

/**
 * Resolve who is flagged on a task after a reply.
 * Rules:
 *   - If reply explicitly sets --needs, use that (re-route attention)
 *   - If oncall is active, flag oncall person
 *   - If the replier matches the current flaggee, CLEAR the flag (they responded)
 *   - Otherwise leave the flag as-is
 */
export function resolveAttentionAfterReply(
  parentTask: Task,
  replySource: string | null,
  explicitNeeds: string | null,
  oncallWho: string | null,
): string | null | 'clear' {
  if (explicitNeeds) return explicitNeeds;
  if (oncallWho) return oncallWho;

  // If the replier matches the flaggee, clear the flag
  const flaggee = parentTask.needs_attention;
  if (flaggee && replySource) {
    const normalizedFlag = flaggee.replace(/^@/, '').toLowerCase();
    const normalizedSource = replySource.replace(/^@/, '').toLowerCase();
    // claude replying clears @claude, hallie replying clears @hallie
    if (normalizedFlag === normalizedSource) return 'clear';
    // "hallie" source also clears "@h"
    if (normalizedSource === 'hallie' && (normalizedFlag === 'h' || normalizedFlag === 'hallie')) return 'clear';
  }

  return null; // no change
}

// ── Oncall ────────────────────────────────────────────────────────────────

export async function setOncall(who: string, untilAt: string): Promise<Oncall> {
  await pool.query(`DELETE FROM oncall`);
  const { rows } = await pool.query(
    `INSERT INTO oncall (who, until_at) VALUES ($1, $2) RETURNING *`,
    [who, untilAt]
  );
  return rows[0];
}

export async function getOncall(): Promise<Oncall | null> {
  const { rows } = await pool.query(
    `SELECT * FROM oncall WHERE until_at > NOW() ORDER BY created_at DESC LIMIT 1`
  );
  return rows[0] || null;
}

export async function clearOncall(): Promise<void> {
  await pool.query(`DELETE FROM oncall`);
}
