const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const http = require('http');
const db = require('./db');
const rhizome = require('./rhizome');

const PORT = 5055;

function fmt(task) {
  const sym = { open: '•', done: '✓', cancelled: '✗', log: '–' }[task.status] || '?';
  const d = task.task_date instanceof Date
    ? task.task_date.toISOString().slice(0, 10)
    : String(task.task_date).slice(0, 10);
  const proj = task.project ? ` @${task.project.split('/').pop()}` : '';
  const claude = task.tags && task.tags.includes('c') ? ' [c]' : '';
  return `[${task.id}] ${sym} ${task.body}${claude}${proj}  (${d})`;
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
  }, async ({ date, project }) => {
    const tasks = await db.list({ date, project });
    if (!tasks.length) return { content: [{ type: 'text', text: 'No open tasks.' }] };
    return { content: [{ type: 'text', text: tasks.map(fmt).join('\n') }] };
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
