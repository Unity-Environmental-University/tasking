const { Pool } = require('pg');

const pool = new Pool({ database: 'tasking' });

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      task_date DATE NOT NULL DEFAULT CURRENT_DATE,
      snoozed_to DATE,
      project TEXT,
      tags TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // migrations for existing tables
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS slug TEXT`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS tasks_slug_unique ON tasks (slug) WHERE slug IS NOT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS thread_read_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS needs_attention TEXT`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oncall (
      id SERIAL PRIMARY KEY,
      who TEXT NOT NULL,
      until_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
}

// status: open | done | cancelled | log | needs-review
// project: null = global, repo path = local
// tags: [] | ['c'] | etc

async function add(body, { date, project, tags, source } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO tasks (body, task_date, project, tags, source) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [body, date || new Date().toISOString().slice(0, 10), project || null, tags || [], source || null]
  );
  return rows[0];
}

async function list({ date, project } = {}) {
  const d = date || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE status NOT IN ('done', 'cancelled')
       AND task_date <= $1
       AND (snoozed_to IS NULL OR snoozed_to <= $1)
       AND (snoozed_until IS NULL OR snoozed_until <= NOW())
       AND (project IS NULL OR project = $2)
     ORDER BY project NULLS LAST, task_date, id`,
    [d, project || null]
  );
  return rows;
}

async function listAllOpen({ date } = {}) {
  const d = date || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE status NOT IN ('done', 'cancelled')
       AND task_date <= $1
       AND (snoozed_to IS NULL OR snoozed_to <= $1)
     ORDER BY project NULLS LAST, task_date, id`,
    [d]
  );
  return rows;
}

async function snooze(id, until) {
  // until is ISO string — could be date or datetime
  const hasTime = until && until.includes('T');
  const date = hasTime ? until.slice(0, 10) : until;
  const { rows } = await pool.query(
    `UPDATE tasks SET snoozed_to = $2, task_date = $2, snoozed_until = $3 WHERE id = $1 RETURNING *`,
    [id, date, hasTime ? until : null]
  );
  return rows[0];
}

async function getById(id) {
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getBySlug(slug) {
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

// resolveRef accepts either a numeric id (number or numeric string) or a slug string.
// Returns the task row, or null if not found.
async function resolveRef(ref) {
  if (/^\d+$/.test(String(ref))) return getById(Number(ref));
  return getBySlug(String(ref));
}

async function setSlug(id, slug) {
  // Enforce kebab-case: lowercase, spaces→hyphens, strip non-alphanumeric-hyphen
  const clean = slug.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const { rows } = await pool.query(
    `UPDATE tasks SET slug = $2 WHERE id = $1 RETURNING *`,
    [id, clean]
  );
  return rows[0];
}

async function setStatus(id, status) {
  const completedAt = status === 'done' ? 'NOW()' : 'NULL';
  const { rows } = await pool.query(
    `UPDATE tasks SET status = $2, completed_at = ${completedAt} WHERE id = $1 RETURNING *`,
    [id, status]
  );
  return rows[0];
}

async function setProject(id, project) {
  const { rows } = await pool.query(
    `UPDATE tasks SET project = $2 WHERE id = $1 RETURNING *`,
    [id, project]
  );
  return rows[0];
}

async function moveTask(id, project) {
  // toggle: if already in project, release to global; otherwise move to project
  const { rows: current } = await pool.query(`SELECT project FROM tasks WHERE id = $1`, [id]);
  if (!current[0]) return null;
  const newProject = current[0].project === project ? null : project;
  return setProject(id, newProject);
}

async function log(body, { date, project, tags } = {}) {
  const d = date || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `INSERT INTO tasks (body, status, task_date, project, tags) VALUES ($1, 'log', $2, $3, $4) RETURNING *`,
    [body, d, project || null, tags || []]
  );
  return rows[0];
}

async function claudeTasks() {
  const d = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE status NOT IN ('done', 'cancelled')
       AND task_date <= $1
       AND (snoozed_to IS NULL OR snoozed_to <= $1)
       AND (snoozed_until IS NULL OR snoozed_until <= NOW())
       AND 'c' = ANY(tags)
     ORDER BY task_date, id`,
    [d]
  );
  return rows;
}

async function recentDone({ since_hours = 24, project } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE status = 'done'
       AND ($2::text IS NULL OR project = $2)
       AND COALESCE(completed_at, created_at) >= NOW() - ($1 || ' hours')::INTERVAL
     ORDER BY COALESCE(completed_at, created_at) DESC`,
    [since_hours, project || null]
  );
  return rows;
}

async function editBody(id, body) {
  const { rows } = await pool.query(
    `UPDATE tasks SET body = $2 WHERE id = $1 RETURNING *`,
    [id, body]
  );
  return rows[0];
}

async function listAll({ project, limit } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE ($1::text IS NULL OR project IS NULL OR project = $1)
     ORDER BY id DESC
     LIMIT $2`,
    [project || null, limit || 50]
  );
  return rows;
}

async function signal() {
  // Surface patterns worth paying attention to
  const today = new Date().toISOString().slice(0, 10);

  // 1. Old open tasks (not snoozed past today) — stuck or avoided
  const { rows: stuck } = await pool.query(
    `SELECT id, body, task_date, project,
            CURRENT_DATE - task_date::date as age_days
     FROM tasks
     WHERE status = 'open'
       AND (snoozed_to IS NULL OR snoozed_to <= CURRENT_DATE)
       AND task_date < CURRENT_DATE - INTERVAL '3 days'
     ORDER BY task_date`
  );

  // 2. Tasks snoozed into the future — what's being deferred
  const { rows: deferred } = await pool.query(
    `SELECT id, body, snoozed_to, project,
            snoozed_to::date - CURRENT_DATE as days_away
     FROM tasks
     WHERE status = 'open' AND snoozed_to > CURRENT_DATE
     ORDER BY snoozed_to`
  );

  // 3. Project clusters — where is the open work concentrated
  const { rows: clusters } = await pool.query(
    `SELECT COALESCE(SPLIT_PART(project, '/', -1), '(global)') as repo,
            COUNT(*) as open_count,
            MIN(task_date)::date as oldest
     FROM tasks
     WHERE status = 'open'
     GROUP BY project
     ORDER BY open_count DESC`
  );

  // 4. Unacted loop signals
  const { rows: signals } = await pool.query(
    `SELECT id, body, task_date
     FROM tasks
     WHERE status = 'open' AND body LIKE 'loop:%'
     ORDER BY task_date`
  );

  // 5. Completion velocity (last 7 days, uses created_at as fallback)
  const { rows: velocity } = await pool.query(
    `SELECT COALESCE(completed_at, created_at)::date as day, COUNT(*) as done
     FROM tasks
     WHERE status = 'done'
       AND COALESCE(completed_at, created_at) >= CURRENT_DATE - INTERVAL '7 days'
     GROUP BY day
     ORDER BY day DESC`
  );

  return { stuck, deferred, clusters, signals, velocity };
}

async function markThreadRead(id) {
  const { rows } = await pool.query(
    `UPDATE tasks SET thread_read_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0];
}

// Returns tasks that have new replies since thread_read_at.
// Scoped to global + current project. Delegates rhizome query to rhizome.js.
async function unreadThreads(project, rhizome) {
  const { rows: candidates } = await pool.query(
    `SELECT * FROM tasks
     WHERE status NOT IN ('done', 'cancelled')
       AND (project IS NULL OR project = $1)
     ORDER BY id`,
    [project || null]
  );
  if (!candidates.length) return [];
  const entries = candidates.map(t => ({
    ref: t.slug ? `task:${t.slug}` : `task:${t.id}`,
    readAt: t.thread_read_at || t.created_at,
    task: t,
  }));
  const unreadRefs = new Set(await rhizome.getUnreadReplyRoots(entries.map(({ ref, readAt }) => ({ ref, readAt }))));
  return entries.filter(e => unreadRefs.has(e.ref)).map(e => e.task);
}

async function setOncall(who, untilAt) {
  // Clear existing, set new
  await pool.query(`DELETE FROM oncall`);
  const { rows } = await pool.query(
    `INSERT INTO oncall (who, until_at) VALUES ($1, $2) RETURNING *`,
    [who, untilAt]
  );
  return rows[0];
}

async function getOncall() {
  const { rows } = await pool.query(
    `SELECT * FROM oncall WHERE until_at > NOW() ORDER BY created_at DESC LIMIT 1`
  );
  return rows[0] || null;
}

async function clearOncall() {
  await pool.query(`DELETE FROM oncall`);
}

async function setAttention(id, who) {
  const { rows } = await pool.query(
    `UPDATE tasks SET needs_attention = $2 WHERE id = $1 RETURNING *`,
    [id, who || null]
  );
  return rows[0];
}

async function attentionTasks(who, project) {
  // Normalize: @hallie, @h, hallie, h → hallie
  const normalized = who.replace(/^@/, '').toLowerCase();
  const variants = normalized === 'h' ? ['hallie', 'h'] : [normalized];
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE status NOT IN ('done', 'cancelled')
       AND (LOWER(REPLACE(needs_attention, '@', '')) = ANY($1))
     ORDER BY task_date, id`,
    [variants]
  );
  return rows;
}

module.exports = { init, add, list, listAllOpen, snooze, getById, getBySlug, resolveRef, setSlug, setStatus, setProject, moveTask, log, claudeTasks, recentDone, editBody, listAll, signal, markThreadRead, unreadThreads, setAttention, attentionTasks, setOncall, getOncall, clearOncall, pool };
