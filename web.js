// web.js — REST API + static file server for tasking web UI
// Port 5157 — separate from MCP server on 5055
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const rhizome = require('./rhizome');

const PORT = 5157;

// --- helpers ---

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
  });
}

function taskJson(task, extra = {}) {
  return {
    id: task.id,
    body: task.body,
    status: task.status,
    task_date: task.task_date,
    snoozed_to: task.snoozed_to,
    project: task.project,
    repo: task.project ? task.project.split('/').pop() : null,
    tags: task.tags,
    source: task.source,
    slug: task.slug,
    needs_attention: task.needs_attention,
    created_at: task.created_at,
    completed_at: task.completed_at,
    ...extra,
  };
}

// enrich a list of tasks with reply counts in parallel
async function enrichTasks(tasks) {
  return Promise.all(tasks.map(async (t) => {
    const ref = rhizome.taskRef(t);
    const replyCount = await rhizome.getReplyCount(ref);
    return taskJson(t, { reply_count: replyCount });
  }));
}

// --- routes ---

const routes = {};

// GET /api/tasks — all open tasks across all projects
routes['GET /api/tasks'] = async (req, res, url) => {
  const tasks = await db.listAllOpen();
  json(res, await enrichTasks(tasks));
};

// GET /api/tasks/attention — tasks needing someone's attention
routes['GET /api/tasks/attention'] = async (req, res, url) => {
  const who = url.searchParams.get('who') || '@hallie';
  const tasks = await db.attentionTasks(who);
  json(res, await enrichTasks(tasks));
};

// GET /api/tasks/all — history view
routes['GET /api/tasks/all'] = async (req, res, url) => {
  const limit = parseInt(url.searchParams.get('limit')) || 100;
  const tasks = await db.listAll({ limit });
  json(res, await enrichTasks(tasks));
};

// GET /api/tasks/:id/thread
routes['GET /api/tasks/thread'] = async (req, res, url, id) => {
  const root = await db.resolveRef(String(id));
  if (!root) return json(res, { error: 'not found' }, 404);
  const rootRef = rhizome.taskRef(root);
  const children = await rhizome.getThread(rootRef);
  const thread = [];
  for (const { subject, depth } of children) {
    const idPart = subject.replace(/^task:/, '');
    const child = /^\d+$/.test(idPart) ? await db.getById(Number(idPart)) : await db.getBySlug(idPart);
    if (child) thread.push(taskJson(child, { depth }));
  }
  json(res, { root: taskJson(root), thread });
};

// GET /api/activity — recent activity from rhizome edges
routes['GET /api/activity'] = async (req, res, url) => {
  const limit = parseInt(url.searchParams.get('limit')) || 50;
  const pool = require('./rhizome-pool');
  const { rows } = await pool.query(
    `SELECT subject, predicate, object, phase, observer, notes, created_at
     FROM edges
     WHERE predicate IN ('completed-on','cancelled-on','records','reply-to','snoozed-to','needs-attention-from','originated-by')
       AND dissolved_at IS NULL
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  json(res, rows);
};

// GET /api/oncall
routes['GET /api/oncall'] = async (req, res) => {
  const oncall = await db.getOncall();
  if (!oncall) return json(res, { active: false });
  const remaining = Math.round((new Date(oncall.until_at) - Date.now()) / 60000);
  json(res, { active: true, who: oncall.who, until_at: oncall.until_at, remaining_minutes: remaining });
};

// GET /api/signal
routes['GET /api/signal'] = async (req, res) => {
  const data = await db.signal();
  json(res, data);
};

// GET /api/stats — quick counts for the top bar
routes['GET /api/stats'] = async (req, res) => {
  const pool = db.pool;
  const [open, flagged, doneToday, claudeTasks] = await Promise.all([
    pool.query(`SELECT COUNT(*) as n FROM tasks WHERE status = 'open'`),
    pool.query(`SELECT COUNT(*) as n FROM tasks WHERE status = 'open' AND needs_attention IS NOT NULL`),
    pool.query(`SELECT COUNT(*) as n FROM tasks WHERE status = 'done' AND completed_at >= CURRENT_DATE`),
    pool.query(`SELECT COUNT(*) as n FROM tasks WHERE status = 'open' AND 'c' = ANY(tags)`),
  ]);
  json(res, {
    open: parseInt(open.rows[0].n),
    flagged: parseInt(flagged.rows[0].n),
    done_today: parseInt(doneToday.rows[0].n),
    claude_tasks: parseInt(claudeTasks.rows[0].n),
  });
};

// POST /api/tasks/:id/done
routes['POST /api/tasks/done'] = async (req, res, url, id) => {
  const body = await parseBody(req);
  const task = await db.getById(id);
  if (!task) return json(res, { error: 'not found' }, 404);
  const updated = await db.setStatus(id, 'done');
  await rhizome.onComplete(updated, body.note);
  // clear attention flag on complete
  if (updated.needs_attention) await db.setAttention(id, null);
  json(res, taskJson(updated));
};

// POST /api/tasks/:id/cancel
routes['POST /api/tasks/cancel'] = async (req, res, url, id) => {
  const task = await db.getById(id);
  if (!task) return json(res, { error: 'not found' }, 404);
  const updated = await db.setStatus(id, 'cancelled');
  await rhizome.onCancel(updated);
  if (updated.needs_attention) await db.setAttention(id, null);
  json(res, taskJson(updated));
};

// POST /api/tasks/:id/snooze
routes['POST /api/tasks/snooze'] = async (req, res, url, id) => {
  const body = await parseBody(req);
  if (!body.to_date) return json(res, { error: 'to_date required' }, 400);
  const updated = await db.snooze(id, body.to_date);
  if (!updated) return json(res, { error: 'not found' }, 404);
  await rhizome.onSnooze(updated);
  json(res, taskJson(updated));
};

// POST /api/tasks/:id/flag
routes['POST /api/tasks/flag'] = async (req, res, url, id) => {
  const body = await parseBody(req);
  const who = body.who || '@hallie';
  const task = await db.getById(id);
  if (!task) return json(res, { error: 'not found' }, 404);
  await db.setAttention(id, who);
  await rhizome.onAttention(task, who);
  json(res, taskJson({ ...task, needs_attention: who }));
};

// POST /api/tasks/:id/unflag
routes['POST /api/tasks/unflag'] = async (req, res, url, id) => {
  const task = await db.getById(id);
  if (!task) return json(res, { error: 'not found' }, 404);
  await db.setAttention(id, null);
  json(res, taskJson({ ...task, needs_attention: null }));
};

// POST /api/tasks/:id/reply
routes['POST /api/tasks/reply'] = async (req, res, url, id) => {
  const body = await parseBody(req);
  if (!body.body) return json(res, { error: 'body required' }, 400);
  const parentTask = await db.getById(id);
  if (!parentTask) return json(res, { error: 'not found' }, 404);
  const child = await db.add(body.body, {
    project: parentTask.project,
    tags: body.tags || [],
    source: body.source || 'hallie',
  });
  await rhizome.onAdd(child);
  await rhizome.onReply(child, parentTask);
  // flag parent for attention: explicit needs, or auto-flag @claude when hallie replies
  const replySource = body.source || 'hallie';
  const attnTarget = body.needs || (replySource === 'hallie' ? '@claude' : null);
  if (attnTarget) {
    await db.setAttention(parentTask.id, attnTarget);
    await rhizome.onAttention(parentTask, attnTarget);
  }
  json(res, taskJson(child));
};

// POST /api/tasks/add
routes['POST /api/tasks/add'] = async (req, res) => {
  const body = await parseBody(req);
  if (!body.body) return json(res, { error: 'body required' }, 400);
  const task = await db.add(body.body, {
    date: body.date,
    project: body.project,
    tags: body.tags || [],
    source: body.source || 'hallie',
  });
  await rhizome.onAdd(task);
  // attention: explicit or oncall fallback
  const attnTarget = body.needs || (await db.getOncall())?.who || null;
  if (attnTarget) {
    await db.setAttention(task.id, attnTarget);
    await rhizome.onAttention(task, attnTarget);
    task.needs_attention = attnTarget;
  }
  json(res, taskJson(task));
};

// --- server ---

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // static files
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'web', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // health
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // API routing
  try {
    // match /api/tasks/:id/:action patterns
    const taskAction = url.pathname.match(/^\/api\/tasks\/(\d+)\/(thread|done|cancel|snooze|flag|unflag|reply)$/);
    if (taskAction) {
      const [, idStr, action] = taskAction;
      const key = `${req.method} /api/tasks/${action}`;
      if (routes[key]) return await routes[key](req, res, url, parseInt(idStr));
    }

    // match other routes
    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) return await routes[key](req, res, url);

    json(res, { error: 'not found' }, 404);
  } catch (err) {
    console.error('[web]', err);
    json(res, { error: err.message }, 500);
  }
});

db.init().then(() => {
  server.listen(PORT, () => {
    console.log(`Tasking web UI: http://localhost:${PORT}`);
  });
});
