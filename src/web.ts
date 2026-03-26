import http from 'http';
import fs from 'fs';
import path from 'path';
import * as db from './db';
import * as rhizome from './rhizome';

const PORT = 5157;

function json(res: http.ServerResponse, data: any, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
  });
}

function taskJson(task: any, extra: any = {}) {
  return {
    id: task.id, body: task.body, status: task.status, priority: task.priority,
    task_date: task.task_date, snoozed_to: task.snoozed_to, project: task.project,
    repo: task.project ? task.project.split('/').pop() : null,
    tags: task.tags, source: task.source, slug: task.slug,
    needs_attention: task.needs_attention,
    created_at: task.created_at, completed_at: task.completed_at,
    ...extra,
  };
}

async function enrichTasks(tasks: any[]) {
  return Promise.all(tasks.map(async t => {
    const ref = rhizome.taskRef(t);
    const [replyCount, personas, parentRef] = await Promise.all([
      rhizome.getReplyCount(ref),
      rhizome.getTaskPersonas(ref),
      rhizome.getParent(ref),
    ]);
    // Get last reply for preview
    let lastReply = null;
    if (replyCount > 0) {
      const thread = await rhizome.getThread(ref);
      if (thread.length) {
        const lastRef = thread[thread.length - 1].subject;
        const idPart = lastRef.replace('task:', '');
        const child = /^\d+$/.test(idPart) ? await db.getById(Number(idPart)) : await db.getBySlug(idPart);
        if (child) lastReply = { id: child.id, body: child.body, source: child.source, created_at: child.created_at };
      }
    }
    // Get parent + thread root for reply tasks
    let parent = null;
    let threadRoot = null;
    if (parentRef) {
      const parentIdPart = parentRef.replace('task:', '');
      const parentTask = /^\d+$/.test(parentIdPart) ? await db.getById(Number(parentIdPart)) : await db.getBySlug(parentIdPart);
      if (parentTask) parent = { id: parentTask.id, body: parentTask.body, slug: parentTask.slug };
      // Find thread root (may differ from direct parent)
      const rootRef = await rhizome.getThreadRoot(ref);
      if (rootRef !== parentRef) {
        const rootIdPart = rootRef.replace('task:', '');
        const rootTask = /^\d+$/.test(rootIdPart) ? await db.getById(Number(rootIdPart)) : await db.getBySlug(rootIdPart);
        if (rootTask) threadRoot = { id: rootTask.id, body: rootTask.body, slug: rootTask.slug };
      }
    }
    return taskJson(t, { reply_count: replyCount, personas, last_reply: lastReply, parent, thread_root: threadRoot });
  }));
}

type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, id?: number) => Promise<void>;
const routes: Record<string, RouteHandler> = {};

// Filter replies out of list views — replies only appear inside their parent's thread
function rootsOnly(tasks: any[]) {
  return tasks.filter(t => !t.parent);
}

routes['GET /api/tasks'] = async (_req, res, url) => {
  const all = url.searchParams.get('include_replies') === '1';
  const enriched = await enrichTasks(await db.listAllOpen());
  json(res, all ? enriched : rootsOnly(enriched));
};

routes['GET /api/tasks/attention'] = async (_req, res, url) => {
  const who = url.searchParams.get('who') || '@hallie';
  const enriched = await enrichTasks(await db.attentionTasks(who));
  // For attention: show replies too if they're specifically flagged
  json(res, enriched);
};

routes['GET /api/tasks/all'] = async (_req, res, url) => {
  const limit = parseInt(url.searchParams.get('limit') || '100');
  const all = url.searchParams.get('include_replies') === '1';
  const enriched = await enrichTasks(await db.listAll({ limit }));
  json(res, all ? enriched : rootsOnly(enriched));
};

routes['GET /api/tasks/thread'] = async (_req, res, _url, id) => {
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

routes['GET /api/activity'] = async (_req, res, url) => {
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const { rows } = await rhizome.rhizomePool.query(
    `SELECT subject, predicate, object, phase, observer, notes, created_at
     FROM edges
     WHERE predicate IN ('completed-on','cancelled-on','records','reply-to','snoozed-to','needs-attention-from','originated-by')
       AND dissolved_at IS NULL
     ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  json(res, rows);
};

routes['GET /api/oncall'] = async (_req, res) => {
  const oncall = await db.getOncall();
  if (!oncall) return json(res, { active: false });
  const remaining = Math.round((new Date(oncall.until_at as string).getTime() - Date.now()) / 60000);
  json(res, { active: true, who: oncall.who, until_at: oncall.until_at, remaining_minutes: remaining });
};

routes['GET /api/signal'] = async (_req, res) => json(res, await db.signal());

routes['GET /api/stories'] = async (_req, res) => {
  const personas = await rhizome.getPersonas();
  // enrich with full task objects
  const result = [];
  for (const p of personas) {
    const tasks = [];
    for (const ref of p.tasks) {
      const idPart = ref.replace('task:', '');
      const task = /^\d+$/.test(idPart) ? await db.getById(Number(idPart)) : await db.getBySlug(idPart);
      if (task) {
        const replyCount = await rhizome.getReplyCount(rhizome.taskRef(task));
        tasks.push(taskJson(task, { reply_count: replyCount }));
      }
    }
    result.push({ persona: p.persona, tasks });
  }
  json(res, result);
};

routes['POST /api/tasks/story'] = async (req, res, _url, id) => {
  const body = await parseBody(req);
  if (!body.persona) return json(res, { error: 'persona required' }, 400);
  const task = await db.getById(id!);
  if (!task) return json(res, { error: 'not found' }, 404);
  const clean = body.persona.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  await rhizome.onStory(task, clean);
  json(res, { persona: clean, task: taskJson(task) });
};

routes['POST /api/tasks/unstory'] = async (req, res, _url, id) => {
  const body = await parseBody(req);
  if (!body.persona) return json(res, { error: 'persona required' }, 400);
  const task = await db.getById(id!);
  if (!task) return json(res, { error: 'not found' }, 404);
  const clean = body.persona.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  await rhizome.removeStory(task, clean);
  json(res, { persona: clean, removed: true });
};

routes['GET /api/stats'] = async (_req, res) => {
  const [open, flagged, doneToday, claudeTasks] = await Promise.all([
    db.pool.query(`SELECT COUNT(*) as n FROM tasks WHERE status = 'open'`),
    db.pool.query(`SELECT COUNT(*) as n FROM tasks WHERE status = 'open' AND needs_attention IS NOT NULL`),
    db.pool.query(`SELECT COUNT(*) as n FROM tasks WHERE status = 'done' AND completed_at >= CURRENT_DATE`),
    db.pool.query(`SELECT COUNT(*) as n FROM tasks WHERE status = 'open' AND 'c' = ANY(tags)`),
  ]);
  json(res, {
    open: parseInt(open.rows[0].n),
    flagged: parseInt(flagged.rows[0].n),
    done_today: parseInt(doneToday.rows[0].n),
    claude_tasks: parseInt(claudeTasks.rows[0].n),
  });
};

routes['POST /api/tasks/done'] = async (req, res, _url, id) => {
  const body = await parseBody(req);
  const task = await db.getById(id!);
  if (!task) return json(res, { error: 'not found' }, 404);
  const updated = await db.setStatus(id!, 'done');
  if (!updated) return json(res, { error: 'not found' }, 404);
  await rhizome.onComplete(updated, body.note);
  if (updated.needs_attention) await db.setAttention(id!, null);
  json(res, taskJson(updated));
};

routes['POST /api/tasks/cancel'] = async (_req, res, _url, id) => {
  const task = await db.getById(id!);
  if (!task) return json(res, { error: 'not found' }, 404);
  const updated = await db.setStatus(id!, 'cancelled');
  if (!updated) return json(res, { error: 'not found' }, 404);
  await rhizome.onCancel(updated);
  if (updated.needs_attention) await db.setAttention(id!, null);
  json(res, taskJson(updated));
};

routes['POST /api/tasks/snooze'] = async (req, res, _url, id) => {
  const body = await parseBody(req);
  if (!body.to_date) return json(res, { error: 'to_date required' }, 400);
  const updated = await db.snooze(id!, body.to_date);
  if (!updated) return json(res, { error: 'not found' }, 404);
  await rhizome.onSnooze(updated);
  json(res, taskJson(updated));
};

routes['POST /api/tasks/flag'] = async (req, res, _url, id) => {
  const body = await parseBody(req);
  const who = body.who || '@hallie';
  const task = await db.getById(id!);
  if (!task) return json(res, { error: 'not found' }, 404);
  await db.setAttention(id!, who);
  await rhizome.onAttention(task, who);
  json(res, taskJson({ ...task, needs_attention: who }));
};

routes['POST /api/tasks/unflag'] = async (_req, res, _url, id) => {
  const task = await db.getById(id!);
  if (!task) return json(res, { error: 'not found' }, 404);
  await db.setAttention(id!, null);
  json(res, taskJson({ ...task, needs_attention: null }));
};

routes['POST /api/tasks/reply'] = async (req, res, _url, id) => {
  const body = await parseBody(req);
  if (!body.body) return json(res, { error: 'body required' }, 400);
  const parentTask = await db.getById(id!);
  if (!parentTask) return json(res, { error: 'not found' }, 404);
  const bodyProject = await db.resolveBodyProject(body.body);
  const child = await db.add(body.body, {
    project: bodyProject,
    tags: body.tags || [],
    source: body.source || 'hallie',
  });
  await rhizome.onAdd(child);
  await rhizome.onReply(child, parentTask);

  // Use shared attention resolution
  const replySource = body.source || 'hallie';
  const oncall = await db.getOncall();
  const resolution = db.resolveAttentionAfterReply(parentTask, replySource, body.needs || null, oncall?.who || null);
  if (resolution === 'clear') {
    await db.setAttention(parentTask.id, null);
  } else if (resolution) {
    await db.setAttention(parentTask.id, resolution);
    await rhizome.onAttention(parentTask, resolution);
  }

  json(res, taskJson(child));
};

routes['POST /api/tasks/add'] = async (req, res) => {
  const body = await parseBody(req);
  if (!body.body) return json(res, { error: 'body required' }, 400);
  const task = await db.add(body.body, {
    date: body.date,
    project: body.project,
    tags: body.tags || [],
    source: body.source || 'hallie',
    priority: body.priority || null,
  });
  await rhizome.onAdd(task);
  const attnTarget = body.needs || (await db.getOncall())?.who || null;
  if (attnTarget) {
    await db.setAttention(task.id, attnTarget);
    await rhizome.onAttention(task, attnTarget);
    task.needs_attention = attnTarget;
  }
  json(res, taskJson(task));
};

routes['POST /api/tasks/edit'] = async (req, res, _url, id) => {
  const body = await parseBody(req);
  if (!body.body) return json(res, { error: 'body required' }, 400);
  const task = await db.editBody(id!, body.body);
  if (!task) return json(res, { error: 'not found' }, 404);
  json(res, taskJson(task));
};

routes['POST /api/tasks/priority'] = async (req, res, _url, id) => {
  const body = await parseBody(req);
  const task = await db.setPriority(id!, body.priority || null);
  if (!task) return json(res, { error: 'not found' }, 404);
  json(res, taskJson(task));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  try {
    const taskAction = url.pathname.match(/^\/api\/tasks\/(\d+)\/(thread|done|cancel|snooze|flag|unflag|reply|priority|story|unstory|edit)$/);
    if (taskAction) {
      const [, idStr, action] = taskAction;
      const key = `${req.method} /api/tasks/${action}`;
      if (routes[key]) return await routes[key](req, res, url, parseInt(idStr));
    }
    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) return await routes[key](req, res, url);
    json(res, { error: 'not found' }, 404);
  } catch (err: any) {
    console.error('[web]', err);
    json(res, { error: err.message }, 500);
  }
});

db.init().then(() => {
  server.listen(PORT, () => console.log(`Tasking web UI: http://localhost:${PORT}`));
});
