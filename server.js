const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const db = require('./db');
const rhizome = require('./rhizome');
const trello = require('./trello');

const PORT = 5055;

function fmt(task) {
  const sym = { open: '•', done: '✓', cancelled: '✗', log: '–', 'needs-review': '~' }[task.status] || '?';
  const d = task.task_date instanceof Date
    ? task.task_date.toISOString().slice(0, 10)
    : String(task.task_date).slice(0, 10);
  const proj = task.project ? ` @${task.project.split('/').pop()}` : '';
  const claude = task.tags && task.tags.includes('c') ? ' [c]' : '';
  const reviewers = task.tags ? task.tags.filter(t => t.startsWith('@')).join(' ') : '';
  return `[${task.id}] ${sym} ${task.body}${claude}${reviewers ? ' ' + reviewers : ''}${proj}  (${d})`;
}

async function main() {
  await db.init();

  const server = new McpServer({ name: 'tasking', version: '1.0.0' });

  server.tool('add', 'Add a task', {
    body: z.string().describe('Task text'),
    date: z.string().optional().describe('ISO date YYYY-MM-DD, defaults to today'),
    project: z.string().optional().describe('Repo path to scope locally, null for global'),
    tags: z.array(z.string()).optional().describe('Tags e.g. ["c"] for claude-aware'),
  }, async ({ body, date, project, tags }) => {
    const task = await db.add(body, { date, project, tags });
    rhizome.onAdd(task);
    return { content: [{ type: 'text', text: fmt(task) }] };
  });

  server.tool('list', 'List open tasks (today + overdue)', {
    date: z.string().optional().describe('ISO date YYYY-MM-DD, defaults to today'),
    project: z.string().optional().describe('Include tasks for this project (plus global)'),
    detail: z.boolean().optional().describe('If true, include Qwen annotations and blocking relationships'),
  }, async ({ date, project, detail }) => {
    const tasks = await db.list({ date, project });
    if (!tasks.length) return { content: [{ type: 'text', text: 'No open tasks.' }] };
    if (!detail) return { content: [{ type: 'text', text: tasks.map(fmt).join('\n') }] };
    const lines = await Promise.all(tasks.map(async t => {
      const [ann, blocking] = await Promise.all([rhizome.getAnnotations(t.id), rhizome.getBlocking(t.id)]);
      const row = [fmt(t)];
      if (blocking.blocked_by.length) row.push(`  ↑ blocked by: ${blocking.blocked_by.map(b => `#${b.id}`).join(', ')}`);
      if (blocking.blocks.length) row.push(`  ↓ blocks: ${blocking.blocks.map(b => `#${b.id}`).join(', ')}`);
      if (ann) row.push(`  ✎ ${ann.notes}`);
      return row.join('\n');
    }));
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  server.tool('snooze', 'Snooze a task to a future date', {
    id: z.number().describe('Task ID'),
    to_date: z.string().describe('ISO date YYYY-MM-DD'),
  }, async ({ id, to_date }) => {
    const task = await db.snooze(id, to_date);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    rhizome.onSnooze(task);
    return { content: [{ type: 'text', text: `Snoozed: ${fmt(task)}` }] };
  });

  server.tool('complete', 'Mark a task as done', {
    id: z.number().describe('Task ID'),
  }, async ({ id }) => {
    const task = await db.setStatus(id, 'done');
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    rhizome.onComplete(task);
    return { content: [{ type: 'text', text: `Done: ${fmt(task)}` }] };
  });

  server.tool('cancel', 'Cancel a task', {
    id: z.number().describe('Task ID'),
  }, async ({ id }) => {
    const task = await db.setStatus(id, 'cancelled');
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    rhizome.onCancel(task);
    return { content: [{ type: 'text', text: `Cancelled: ${fmt(task)}` }] };
  });

  server.tool('review', 'Mark a task as needs-review and create a Review: task for the reviewer', {
    id: z.number().describe('Task ID to mark as needs-review'),
    reviewer: z.string().optional().describe('Person to assign the review to (e.g. "hallie" or "@hallie")'),
  }, async ({ id, reviewer }) => {
    const task = await db.getById(id);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    await db.setStatus(id, 'needs-review');
    const reviewerTag = reviewer ? '@' + reviewer.replace(/^@/, '') : null;
    const reviewTask = await db.add(`Review: ${task.body}`, {
      project: task.project,
      tags: reviewerTag ? [reviewerTag] : [],
    });
    const lines = [
      `Needs review: ${fmt({ ...task, status: 'needs-review' })}`,
      `Created: ${fmt(reviewTask)}`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  server.tool('log', 'Add a log/note entry', {
    body: z.string().describe('Log entry text'),
    date: z.string().optional().describe('ISO date YYYY-MM-DD, defaults to today'),
    project: z.string().optional(),
  }, async ({ body, date, project }) => {
    const task = await db.log(body, { date, project });
    return { content: [{ type: 'text', text: fmt(task) }] };
  });

  server.tool('move', 'Move task between global and local (toggles)', {
    id: z.number().describe('Task ID'),
    project: z.string().optional().describe('Repo path to move to; omit to release to global'),
  }, async ({ id, project }) => {
    const task = await db.moveTask(id, project || null);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    rhizome.onMove(task);
    const bucket = task.project ? `local (${task.project.split('/').pop()})` : 'global';
    return { content: [{ type: 'text', text: `Moved to ${bucket}: ${fmt(task)}` }] };
  });

  server.tool('annotate', 'Run Qwen annotation batch on open tasks (fires in background, logs to annotate.log)', {
    dry_run: z.boolean().optional().describe('If true, print what would happen without writing to rhizome'),
  }, async ({ dry_run }) => {
    const { spawn } = require('child_process');
    const fs = require('fs');
    const scriptPath = path.join(__dirname, 'annotate.js');
    const logPath = path.join(__dirname, 'annotate.log');
    const args = dry_run ? ['--dry-run'] : [];
    const logStream = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, [scriptPath, ...args], {
      detached: true,
      stdio: ['ignore', logStream, logStream],
    });
    child.unref();
    return { content: [{ type: 'text', text: `Annotation batch started (pid ${child.pid}). Follow progress: tail -f ${logPath}` }] };
  });

  server.tool('block', 'Mark task A as blocking task B', {
    blocker: z.number().describe('ID of the blocking task'),
    blocked: z.number().describe('ID of the task being blocked'),
  }, async ({ blocker, blocked }) => {
    const [a, b] = await Promise.all([db.pool.query('SELECT * FROM tasks WHERE id=$1',[blocker]), db.pool.query('SELECT * FROM tasks WHERE id=$1',[blocked])]);
    if (!a.rows[0]) return { content: [{ type: 'text', text: `Task ${blocker} not found.` }] };
    if (!b.rows[0]) return { content: [{ type: 'text', text: `Task ${blocked} not found.` }] };
    await rhizome.onBlock(blocker, blocked, a.rows[0].body, b.rows[0].body);
    return { content: [{ type: 'text', text: `task:${blocker} --blocks--> task:${blocked}` }] };
  });

  server.tool('unblock', 'Remove a blocking relationship', {
    blocker: z.number().describe('ID of the blocking task'),
    blocked: z.number().describe('ID of the task being unblocked'),
  }, async ({ blocker, blocked }) => {
    await rhizome.onUnblock(blocker, blocked);
    return { content: [{ type: 'text', text: `Removed: task:${blocker} --blocks--> task:${blocked}` }] };
  });

  server.tool('notes', 'Show Qwen annotation and blocking relationships for a task', {
    id: z.number().describe('Task ID'),
  }, async ({ id }) => {
    const [taskRes, annotation, blocking] = await Promise.all([
      db.pool.query('SELECT * FROM tasks WHERE id=$1', [id]),
      rhizome.getAnnotations(id),
      rhizome.getBlocking(id),
    ]);
    if (!taskRes.rows[0]) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    const task = taskRes.rows[0];
    const lines = [fmt(task)];
    if (blocking.blocked_by.length) lines.push(`  blocked by: ${blocking.blocked_by.map(b => `#${b.id}`).join(', ')}`);
    if (blocking.blocks.length) lines.push(`  blocks: ${blocking.blocks.map(b => `#${b.id}`).join(', ')}`);
    if (annotation) lines.push(`  annotation: ${annotation.notes}`);
    else lines.push(`  annotation: (none)`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  // ── Browser / extension tools ─────────────────────────────────────────────
  // These are designed to be called by browser extensions (e.g. Cyber-Rhizome)
  // over HTTP. Any extension pointed at this MCP server can use them.

  server.tool('rhizome_edge', 'Write an arbitrary edge into rhizome-alkahest', {
    subject:   z.string().describe('Edge subject, e.g. "url:https://..." or "user:hallie"'),
    predicate: z.string().describe('Edge predicate, e.g. "visited" or "read-message"'),
    object:    z.string().describe('Edge object'),
    phase:     z.enum(['volatile', 'fluid', 'salt']).optional().describe('Default: fluid'),
    notes:     z.string().optional().describe('Free-text notes attached to the edge'),
  }, async ({ subject, predicate, object, phase, notes }) => {
    const { Pool } = require('pg');
    const pool = new Pool({ database: 'rhizome-alkahest' });
    try {
      await pool.query(
        `INSERT INTO edges (subject, predicate, object, phase, observer, notes)
         VALUES ($1, $2, $3, $4, 'browser-extension', $5)
         ON CONFLICT DO NOTHING`,
        [subject, predicate, object, phase || 'fluid', notes || '']
      );
      return { content: [{ type: 'text', text: `(${subject} --${predicate}--> ${object}) [${phase || 'fluid'}]` }] };
    } finally {
      await pool.end();
    }
  });

  server.tool('context_push', 'Record current browser page context as a rhizome edge', {
    url:     z.string().describe('Current page URL'),
    title:   z.string().optional().describe('Page title'),
    context: z.string().optional().describe('Additional context (selected text, page type, etc.)'),
    user:    z.string().optional().describe('User identifier, e.g. "hallie"'),
  }, async ({ url, title, context, user }) => {
    const { Pool } = require('pg');
    const pool = new Pool({ database: 'rhizome-alkahest' });
    const subject = user ? `user:${user}` : 'user:unknown';
    const object = `url:${url}`;
    const notes = [title, context].filter(Boolean).join(' — ');
    try {
      await pool.query(
        `INSERT INTO edges (subject, predicate, object, phase, observer, notes)
         VALUES ($1, 'visited', $2, 'volatile', 'browser-extension', $3)
         ON CONFLICT DO NOTHING`,
        [subject, object, notes]
      );
      return { content: [{ type: 'text', text: `context recorded: ${subject} visited ${url}` }] };
    } finally {
      await pool.end();
    }
  });

  server.tool('teams_message', 'Store a captured Teams message as a rhizome edge', {
    message_id: z.string().describe('Teams message ID'),
    channel:    z.string().optional().describe('Channel or chat name'),
    sender:     z.string().optional().describe('Sender display name'),
    body:       z.string().describe('Message body text'),
    url:        z.string().optional().describe('Deep link to the message'),
    user:       z.string().optional().describe('User who read this, e.g. "hallie"'),
  }, async ({ message_id, channel, sender, body, url, user }) => {
    const { Pool } = require('pg');
    const pool = new Pool({ database: 'rhizome-alkahest' });
    const subject = user ? `user:${user}` : 'user:unknown';
    const object = `teams-message:${message_id}`;
    const notes = [sender && `from:${sender}`, channel && `in:${channel}`, body.slice(0, 200)].filter(Boolean).join(' | ');
    try {
      await pool.query(
        `INSERT INTO edges (subject, predicate, object, phase, observer, notes)
         VALUES ($1, 'read-message', $2, 'fluid', 'browser-extension', $3)
         ON CONFLICT DO NOTHING`,
        [subject, object, notes]
      );
      if (url) {
        await pool.query(
          `INSERT INTO edges (subject, predicate, object, phase, observer, notes)
           VALUES ($1, 'has-url', $2, 'fluid', 'browser-extension', '')
           ON CONFLICT DO NOTHING`,
          [object, url]
        );
      }
      return { content: [{ type: 'text', text: `teams message stored: ${object}` }] };
    } finally {
      await pool.end();
    }
  });

  server.tool('trello_view', 'View Trello boards and cards', {
    board: z.string().optional().describe('Board name substring; "boards" to list all; omit to use default board'),
    list: z.string().optional().describe('List name substring to filter cards by'),
  }, async ({ board, list }) => {
    try {
      const bds = await trello.boards();
      if (board === 'boards' || board === 'all') {
        const lines = bds.map(b => `[${b.name}]  ${b.shortUrl}`);
        return { content: [{ type: 'text', text: lines.join('\n') || 'No open boards.' }] };
      }
      if (!board) {
        // use default board from Keychain
        const { execSync } = require('child_process');
        let def = null;
        try { def = execSync('security find-generic-password -a tasking -s "TRELLO_DEFAULT_BOARD" -w', { stdio: ['pipe','pipe','pipe'], encoding: 'utf8' }).trim(); } catch {}
        if (!def) {
          const lines = bds.map(b => `[${b.name}]  ${b.shortUrl}`);
          return { content: [{ type: 'text', text: `No default board set. Run: t reg TRELLO_DEFAULT_BOARD "board name"\n\n${lines.join('\n')}` }] };
        }
        board = def;
      }
      const match = bds.find(b => b.name.toLowerCase().includes(board.toLowerCase()));
      if (!match) return { content: [{ type: 'text', text: `No board matching "${board}".` }] };
      const [ls, cs] = await Promise.all([trello.lists(match.id), trello.cards(match.id)]);
      const listMap = Object.fromEntries(ls.map(l => [l.id, l.name]));
      let filtered = cs;
      if (list) {
        const lmatch = ls.find(l => l.name.toLowerCase().includes(list.toLowerCase()));
        if (lmatch) filtered = cs.filter(c => c.idList === lmatch.id);
      }
      if (!filtered.length) return { content: [{ type: 'text', text: 'No open cards.' }] };
      const lines = filtered.map(c => {
        const due = c.due ? ` (due ${c.due.slice(0,10)})` : '';
        return `• ${c.name}  [${listMap[c.idList] || '?'}]${due}`;
      });
      return { content: [{ type: 'text', text: `${match.name}\n${lines.join('\n')}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }] };
    }
  });

  server.tool('claude_tasks', 'Get tasks tagged [c] for Claude context', {}, async () => {
    const tasks = await db.claudeTasks();
    if (!tasks.length) return { content: [{ type: 'text', text: 'No claude-tagged tasks.' }] };
    return { content: [{ type: 'text', text: tasks.map(fmt).join('\n') }] };
  });

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if ((req.method === 'POST' || req.method === 'GET') && req.url === '/mcp') {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  httpServer.listen(PORT, () => {
    console.log(`tasking MCP server running on http://localhost:${PORT}/mcp`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
