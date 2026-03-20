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
}

// status: open | done | cancelled | log | needs-review
// project: null = global, repo path = local
// tags: [] | ['c'] | etc

async function add(body, { date, project, tags } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO tasks (body, task_date, project, tags) VALUES ($1, $2, $3, $4) RETURNING *`,
    [body, date || new Date().toISOString().slice(0, 10), project || null, tags || []]
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

async function setStatus(id, status) {
  const { rows } = await pool.query(
    `UPDATE tasks SET status = $2 WHERE id = $1 RETURNING *`,
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

module.exports = { init, add, list, snooze, getById, setStatus, setProject, moveTask, log, claudeTasks, pool };
