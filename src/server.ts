import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'http';
import path from 'path';
import * as db from './db';
import * as rhizome from './rhizome';
import * as trello from './trello';
import { fmt, enrichLines } from './fmt';

const PORT = 5055;

function registerTools(server: McpServer) {

  // ── Wrap every tool handler with call logging ──────────────────────────
  function tool(name: string, desc: string, schema: Record<string, any>, handler: (args: any) => Promise<any>) {
    server.tool(name, desc, schema, async (args: any) => {
      const start = Date.now();
      try {
        const result = await handler(args);
        db.logCall(name, args, true, null, Date.now() - start);
        return result;
      } catch (e: any) {
        db.logCall(name, args, false, e.message, Date.now() - start);
        throw e;
      }
    });
  }

  // ── Shared attention logic ─────────────────────────────────────────────
  async function applyAttention(task: { id: number } & Record<string, any>, explicitNeeds?: string | null) {
    const attnTarget = explicitNeeds || (await db.getOncall())?.who || null;
    if (attnTarget) {
      await db.setAttention(task.id, attnTarget);
      await rhizome.onAttention(task as any, attnTarget);
      (task as any).needs_attention = attnTarget;
    }
    return attnTarget;
  }

  async function clearAttentionIfNeeded(task: { id: number; needs_attention?: string | null }) {
    if (task.needs_attention) {
      await db.setAttention(task.id, null);
    }
  }

  // ── Tasks ──────────────────────────────────────────────────────────────

  tool('add', 'Add a task. Pass source: "claude" when Claude creates. needs: "@hallie" to flag.', {
    body: z.string(),
    date: z.string().optional(),
    project: z.string().optional(),
    tags: z.array(z.string()).optional(),
    source: z.string().optional(),
    needs: z.string().optional(),
    priority: z.enum(['A', 'B', 'C']).optional(),
  }, async ({ body, date, project, tags, source, needs, priority }) => {
    const resolvedProject = project || await db.resolveBodyProject(body);
    const task = await db.add(body, { date, project: resolvedProject, tags, source, priority });
    rhizome.onAdd(task);
    await applyAttention(task, needs);
    return { content: [{ type: 'text', text: fmt(task) }] };
  });

  tool('list', 'List open tasks (today + overdue)', {
    date: z.string().optional(),
    project: z.string().optional(),
    detail: z.boolean().optional(),
  }, async ({ date, project, detail }) => {
    const tasks = await db.list({ date, project });
    if (!tasks.length) return { content: [{ type: 'text', text: 'No open tasks.' }] };
    if (!detail) return { content: [{ type: 'text', text: tasks.map(fmt).join('\n') }] };
    const lines = await Promise.all(tasks.map(async t => {
      const extra = await enrichLines(t);
      return [fmt(t), ...extra].join('\n');
    }));
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  tool('complete', 'Mark a task as done', {
    id: z.number(),
    note: z.string().optional(),
  }, async ({ id, note }) => {
    const task = await db.setStatus(id, 'done');
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    rhizome.onComplete(task, note);
    await clearAttentionIfNeeded(task);
    return { content: [{ type: 'text', text: `Done: ${fmt(task)}` }] };
  });

  tool('cancel', 'Cancel a task', {
    id: z.number(),
  }, async ({ id }) => {
    const task = await db.setStatus(id, 'cancelled');
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    rhizome.onCancel(task);
    await clearAttentionIfNeeded(task);
    return { content: [{ type: 'text', text: `Cancelled: ${fmt(task)}` }] };
  });

  tool('snooze', 'Snooze a task to a future date', {
    id: z.number(),
    to_date: z.string(),
  }, async ({ id, to_date }) => {
    const task = await db.snooze(id, to_date);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    rhizome.onSnooze(task);
    return { content: [{ type: 'text', text: `Snoozed: ${fmt(task)}` }] };
  });

  tool('edit', 'Edit a task body', {
    id: z.number(),
    body: z.string(),
  }, async ({ id, body }) => {
    const task = await db.editBody(id, body);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    return { content: [{ type: 'text', text: `Edited: ${fmt(task)}` }] };
  });

  tool('priority', 'Set task priority: A (now), B (soon), C (someday), or null to clear', {
    id: z.number(),
    priority: z.enum(['A', 'B', 'C']).nullable(),
  }, async ({ id, priority }) => {
    const task = await db.setPriority(id, priority);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    return { content: [{ type: 'text', text: `Priority: ${fmt(task)}` }] };
  });

  tool('review', 'Mark needs-review, create Review: task for reviewer', {
    id: z.number(),
    reviewer: z.string().optional(),
  }, async ({ id, reviewer }) => {
    const task = await db.getById(id);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    await db.setStatus(id, 'needs-review');
    const reviewerTag = reviewer ? '@' + reviewer.replace(/^@/, '') : null;
    const reviewTask = await db.add(`Review: ${task.body}`, {
      project: task.project,
      tags: reviewerTag ? [reviewerTag] : [],
    });
    return { content: [{ type: 'text', text: `Needs review: ${fmt({ ...task, status: 'needs-review' } as any)}\nCreated: ${fmt(reviewTask)}` }] };
  });

  tool('log', 'Add a log/note entry', {
    body: z.string(),
    date: z.string().optional(),
    project: z.string().optional(),
  }, async ({ body, date, project }) => {
    const task = await db.log(body, { date, project });
    return { content: [{ type: 'text', text: fmt(task) }] };
  });

  tool('move', 'Move task between global and local (toggles)', {
    id: z.number(),
    project: z.string().optional(),
  }, async ({ id, project }) => {
    const task = await db.moveTask(id, project || null);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    rhizome.onMove(task);
    const bucket = task.project ? `local (${task.project.split('/').pop()})` : 'global';
    return { content: [{ type: 'text', text: `Moved to ${bucket}: ${fmt(task)}` }] };
  });

  tool('list_all', 'List all tasks including done/cancelled (history)', {
    project: z.string().optional(),
    limit: z.number().optional(),
  }, async ({ project, limit }) => {
    const tasks = await db.listAll({ project, limit });
    if (!tasks.length) return { content: [{ type: 'text', text: 'No tasks found.' }] };
    return { content: [{ type: 'text', text: tasks.map(fmt).join('\n') }] };
  });

  tool('key', 'Set a slug (human-readable key) on a task', {
    id: z.number(),
    slug: z.string(),
  }, async ({ id, slug }) => {
    const task = await db.setSlug(id, slug);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    return { content: [{ type: 'text', text: `Key set: task:${task.slug}  (id ${task.id})` }] };
  });

  // ── Threads & replies ──────────────────────────────────────────────────

  tool('reply', 'Reply to a task. needs: "@hallie" to flag. Omit for status updates. Auto-clears flag when the flaggee responds.', {
    parent: z.string(),
    body: z.string(),
    tags: z.array(z.string()).optional(),
    source: z.string().optional(),
    needs: z.string().optional(),
  }, async ({ parent, body, tags, source, needs }) => {
    const parentTask = await db.resolveRef(parent);
    if (!parentTask) return { content: [{ type: 'text', text: `Parent task "${parent}" not found.` }] };

    // Replies go global — scope comes from @mentions in body, not parent
    const bodyProject = await db.resolveBodyProject(body);
    const child = await db.add(body, { project: bodyProject, tags, source });
    await rhizome.onAdd(child);
    await rhizome.onReply(child, parentTask);

    // Attention: explicit needs > oncall > auto-clear if flaggee is replying
    const oncall = await db.getOncall();
    const resolution = db.resolveAttentionAfterReply(parentTask, source || null, needs || null, oncall?.who || null);

    if (resolution === 'clear') {
      await db.setAttention(parentTask.id, null);
    } else if (resolution) {
      await db.setAttention(parentTask.id, resolution);
      await rhizome.onAttention(parentTask, resolution);
    }

    const parentRef = rhizome.taskRef(parentTask);
    const childRef = rhizome.taskRef(child);
    const attnMsg = resolution && resolution !== 'clear' ? `\n⚑ needs attention from ${resolution}` : '';
    const clearedMsg = resolution === 'clear' ? '\n⚑ cleared (flaggee responded)' : '';
    return { content: [{ type: 'text', text: `${childRef} --reply-to--> ${parentRef}\n${fmt(child)}${attnMsg}${clearedMsg}` }] };
  });

  tool('thread', 'Show the reply thread rooted at a task', {
    ref: z.string(),
  }, async ({ ref }) => {
    const root = await db.resolveRef(ref);
    if (!root) return { content: [{ type: 'text', text: `Task "${ref}" not found.` }] };
    const rootRef = rhizome.taskRef(root);
    const children = await rhizome.getThread(rootRef);
    const lines = [`${fmt(root)}  [root]`];
    for (const { subject, depth } of children) {
      const idPart = subject.replace(/^task:/, '');
      const child = /^\d+$/.test(idPart) ? await db.getById(Number(idPart)) : await db.getBySlug(idPart);
      if (child) lines.push(`${'  '.repeat(depth + 1)}↳ ${fmt(child)}`);
    }
    if (children.length === 0) lines.push('  (no replies)');
    await db.markThreadRead(root.id);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  tool('unread', 'Show tasks with new replies since last viewed', {
    project: z.string().optional(),
  }, async ({ project }) => {
    const tasks = await db.unreadThreads(project || null, rhizome);
    if (!tasks.length) return { content: [{ type: 'text', text: 'No unread threads.' }] };
    const lines = ['Unread threads:'];
    for (const task of tasks) {
      const count = await rhizome.getReplyCount(rhizome.taskRef(task));
      lines.push(`  ${fmt(task)}  ↩ ${count} repl${count === 1 ? 'y' : 'ies'}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  // ── Attention routing ──────────────────────────────────────────────────

  tool('attention', 'Show tasks needing attention from someone', {
    who: z.string(),
    project: z.string().optional(),
  }, async ({ who, project }) => {
    const tasks = await db.attentionTasks(who, project || null);
    if (!tasks.length) return { content: [{ type: 'text', text: `No tasks need attention from ${who}.` }] };
    const lines = [`Tasks needing ${who}:`];
    for (const task of tasks) {
      lines.push(`  ${fmt(task)}`);
      const extra = await enrichLines(task);
      for (const l of extra) lines.push(`  ${l}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  tool('flag', 'Flag a task for attention', {
    id: z.number(),
    needs: z.string(),
  }, async ({ id, needs }) => {
    const task = await db.getById(id);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    await db.setAttention(id, needs);
    await rhizome.onAttention(task, needs);
    return { content: [{ type: 'text', text: `⚑ ${fmt({ ...task, needs_attention: needs } as any)}` }] };
  });

  tool('unflag', 'Clear attention flag', {
    id: z.number(),
  }, async ({ id }) => {
    const task = await db.getById(id);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    await db.setAttention(id, null);
    return { content: [{ type: 'text', text: `Cleared: ${fmt({ ...task, needs_attention: null } as any)}` }] };
  });

  tool('oncall', 'Set or check on-call — new tasks auto-flag for this person', {
    who: z.string().optional(),
    duration: z.string().optional(),
  }, async ({ who, duration }) => {
    if (!who && !duration) {
      const current = await db.getOncall();
      if (!current) return { content: [{ type: 'text', text: 'No one on call.' }] };
      const remaining = Math.round((new Date(current.until_at as string).getTime() - Date.now()) / 60000);
      return { content: [{ type: 'text', text: `On call: ${current.who} (${remaining}m remaining)` }] };
    }
    if (duration === 'off' || who === 'off') {
      await db.clearOncall();
      return { content: [{ type: 'text', text: 'On-call cleared.' }] };
    }
    const dur = duration || '1h';
    const match = dur.match(/^(\d+)(h|m|min)$/);
    if (!match) return { content: [{ type: 'text', text: `Invalid duration: ${dur}. Use e.g. 1h, 30m.` }] };
    const ms = match[2] === 'h' ? parseInt(match[1]) * 3600000 : parseInt(match[1]) * 60000;
    const untilAt = new Date(Date.now() + ms);
    await db.setOncall(who!, untilAt.toISOString());
    return { content: [{ type: 'text', text: `⚑ ${who} on call until ${untilAt.toLocaleTimeString()} (${dur})` }] };
  });

  // ── Meta ───────────────────────────────────────────────────────────────

  tool('notes', 'Show annotation, blocking, reply count for a task', {
    id: z.number(),
  }, async ({ id }) => {
    const task = await db.getById(id);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    const extra = await enrichLines(task);
    if (!extra.some(l => l.includes('✎'))) extra.push(`  annotation: (none)`);
    return { content: [{ type: 'text', text: [fmt(task), ...extra].join('\n') }] };
  });

  // ── Stories (personas) ──────────────────────────────────────────────────

  tool('story', 'Attach a persona to a task (task serves persona)', {
    id: z.number(),
    persona: z.string().describe('Persona name, e.g. "learning-student", "overwhelmed-advisor"'),
  }, async ({ id, persona }) => {
    const task = await db.getById(id);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    const clean = persona.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    await rhizome.onStory(task, clean);
    return { content: [{ type: 'text', text: `${rhizome.taskRef(task)} --serves--> persona:${clean}` }] };
  });

  tool('unstory', 'Remove a persona from a task', {
    id: z.number(),
    persona: z.string(),
  }, async ({ id, persona }) => {
    const task = await db.getById(id);
    if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
    const clean = persona.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    await rhizome.removeStory(task, clean);
    return { content: [{ type: 'text', text: `Removed: ${rhizome.taskRef(task)} --serves--> persona:${clean}` }] };
  });

  tool('stories', 'List all personas and the tasks that serve them', {}, async () => {
    const personas = await rhizome.getPersonas();
    if (!personas.length) return { content: [{ type: 'text', text: 'No personas yet. Use t story <id> <persona> to attach one.' }] };
    const lines: string[] = [];
    for (const p of personas) {
      lines.push(`persona:${p.persona}  (${p.task_count} task${p.task_count === 1 ? '' : 's'})`);
      for (const ref of p.tasks) {
        const idPart = ref.replace('task:', '');
        const task = /^\d+$/.test(idPart) ? await db.getById(Number(idPart)) : await db.getBySlug(idPart);
        if (task) lines.push(`  ${fmt(task)}`);
      }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  tool('block', 'Mark task A as blocking task B', {
    blocker: z.number(),
    blocked: z.number(),
  }, async ({ blocker, blocked }) => {
    const [a, b] = await Promise.all([db.getById(blocker), db.getById(blocked)]);
    if (!a) return { content: [{ type: 'text', text: `Task ${blocker} not found.` }] };
    if (!b) return { content: [{ type: 'text', text: `Task ${blocked} not found.` }] };
    await rhizome.onBlock(blocker, blocked, a.body, b.body);
    return { content: [{ type: 'text', text: `task:${blocker} --blocks--> task:${blocked}` }] };
  });

  tool('unblock', 'Remove blocking relationship', {
    blocker: z.number(),
    blocked: z.number(),
  }, async ({ blocker, blocked }) => {
    await rhizome.onUnblock(blocker, blocked);
    return { content: [{ type: 'text', text: `Removed: task:${blocker} --blocks--> task:${blocked}` }] };
  });

  tool('activity', 'Show full arc of a task from rhizome', {
    ref: z.string(),
  }, async ({ ref }) => {
    const task = await db.resolveRef(ref);
    if (!task) return { content: [{ type: 'text', text: `Task "${ref}" not found.` }] };
    const allRefs = [`task:${task.id}`];
    if (task.slug) allRefs.push(`task:${task.slug}`);
    const edges = await rhizome.getActivity(allRefs);
    const lines = [fmt(task)];
    if (task.slug) lines.push(`  key: task:${task.slug}`);
    lines.push('');
    if (!edges.length) {
      lines.push('  (no graph activity recorded)');
    } else {
      for (const e of edges) {
        const ts = new Date(e.created_at).toISOString().slice(0, 16).replace('T', ' ');
        const dissolved = e.dissolved_at ? '  [dissolved]' : '';
        const who = e.observer !== 'tasking-system' ? `  [${e.observer}]` : '';
        if (allRefs.includes(e.subject)) {
          lines.push(`  ${ts}  ${e.predicate} → ${e.object}${who}${dissolved}`);
        } else {
          lines.push(`  ${ts}  ← ${e.predicate} — ${e.subject}${who}${dissolved}`);
        }
        if (e.notes) lines.push(`              ${e.notes}`);
      }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  tool('claude_tasks', 'Get tasks tagged [c] for Claude context', {
    project: z.string().optional().describe('Filter to global + this project path (omit for all)'),
  }, async (args: any) => {
    const tasks = await db.claudeTasks(args.project || undefined);
    if (!tasks.length) return { content: [{ type: 'text', text: 'No claude-tagged tasks.' }] };
    return { content: [{ type: 'text', text: tasks.map(fmt).join('\n') }] };
  });

  tool('signal', 'Surface patterns: stuck, avoidance, clusters, velocity', {}, async () => {
    const s = await db.signal();
    const snoozePatterns = await rhizome.getSnoozePatterns();
    const lines: string[] = [];

    if (snoozePatterns.length) {
      lines.push('🔄 AVOIDANCE (snoozed 2+ times)');
      for (const sp of snoozePatterns) {
        const task = await db.getById(sp.id);
        if (task && task.status === 'open') {
          const proj = task.project ? ` @${task.project.split('/').pop()}` : '';
          lines.push(`  [${sp.id}] ${task.body}${proj}  (snoozed ${sp.snooze_count}x: ${sp.trail})`);
        }
      }
      lines.push('');
    }
    if (s.stuck.length) {
      lines.push('⚠ STUCK (open > 3 days, not snoozed forward)');
      s.stuck.forEach((t: any) => {
        const proj = t.project ? ` @${t.project.split('/').pop()}` : '';
        lines.push(`  [${t.id}] ${t.body}${proj}  (${t.age_days}d old)`);
      });
      lines.push('');
    }
    if (s.deferred.length) {
      lines.push('⏳ DEFERRED (snoozed into the future)');
      s.deferred.forEach((t: any) => {
        const proj = t.project ? ` @${t.project.split('/').pop()}` : '';
        const to = t.snoozed_to instanceof Date ? t.snoozed_to.toISOString().slice(0, 10) : String(t.snoozed_to).slice(0, 10);
        lines.push(`  [${t.id}] ${t.body}${proj}  (until ${to}, ${t.days_away}d away)`);
      });
      lines.push('');
    }
    if (s.clusters.length) {
      lines.push('📍 WORKFRONTS');
      s.clusters.forEach((c: any) => {
        const oldest = c.oldest instanceof Date ? c.oldest.toISOString().slice(0, 10) : String(c.oldest).slice(0, 10);
        lines.push(`  ${c.repo}: ${c.open_count} open (oldest ${oldest})`);
      });
      lines.push('');
    }
    if (s.signals.length) {
      lines.push('📡 UNACTED SIGNALS');
      s.signals.forEach((t: any) => lines.push(`  [${t.id}] ${t.body.slice(0, 80)}...`));
      lines.push('');
    }
    if (s.velocity.length) {
      lines.push('📈 VELOCITY (last 7d)');
      s.velocity.forEach((v: any) => {
        const day = v.day instanceof Date ? v.day.toISOString().slice(0, 10) : String(v.day).slice(0, 10);
        lines.push(`  ${day}: ${v.done} done`);
      });
    }
    if (!lines.length) lines.push('All clear. No patterns worth flagging.');

    const structured = {
      avoidance: snoozePatterns,
      stuck: s.stuck.map((t: any) => ({ id: t.id, body: t.body, age_days: t.age_days, project: t.project })),
      deferred: s.deferred.map((t: any) => ({ id: t.id, body: t.body, snoozed_to: t.snoozed_to, days_away: t.days_away, project: t.project })),
      clusters: s.clusters.map((c: any) => ({ repo: c.repo, open_count: parseInt(c.open_count), oldest: c.oldest })),
      signals: s.signals.map((t: any) => ({ id: t.id, body: t.body })),
      velocity: s.velocity.map((v: any) => ({ day: v.day, done: parseInt(v.done) })),
    };

    return { content: [
      { type: 'text', text: lines.join('\n') },
      { type: 'text', text: JSON.stringify(structured) },
    ] };
  });

  tool('standup', 'Generate standup from recent done + open tasks', {
    since_hours: z.number().optional(),
    project: z.string().optional(),
  }, async ({ since_hours = 24, project } = {}) => {
    const [done, open] = await Promise.all([
      db.recentDone({ since_hours, project }),
      db.list({ project }),
    ]);
    const lines: string[] = [];
    lines.push('**Yesterday / recent:**');
    const realDone = done.filter(t => !t.body.startsWith('loop:') && t.body !== '--all');
    if (realDone.length) {
      realDone.forEach(t => {
        const proj = t.project ? ` (${t.project.split('/').pop()})` : '';
        lines.push(`✓ ${t.body}${proj}`);
      });
    } else lines.push('(nothing recorded recently)');
    lines.push('');
    lines.push('**Today / up next:**');
    const realOpen = open.filter(t => !t.body.startsWith('loop:'));
    if (realOpen.length) {
      realOpen.forEach(t => {
        const proj = t.project ? ` (${t.project.split('/').pop()})` : '';
        lines.push(`• ${t.body}${proj}`);
      });
    } else lines.push('(nothing scheduled)');
    const blockerLines: string[] = [];
    for (const t of realOpen) {
      const blocking = await rhizome.getBlocking(t.id);
      if (blocking.blocked_by.length) {
        blockerLines.push(`• #${t.id} ${t.body} — blocked by ${blocking.blocked_by.map(b => `#${b.id}`).join(', ')}`);
      }
    }
    lines.push('');
    if (blockerLines.length) {
      lines.push('**Blockers:**');
      blockerLines.forEach(l => lines.push(l));
    } else lines.push('**Blockers:** none');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  // ── Browser extension tools ────────────────────────────────────────────

  tool('rhizome_edge', 'Write an arbitrary edge into rhizome-alkahest', {
    subject: z.string(),
    predicate: z.string(),
    object: z.string(),
    phase: z.enum(['volatile', 'fluid', 'salt']).optional(),
    notes: z.string().optional(),
  }, async ({ subject, predicate, object, phase, notes }) => {
    await rhizome.rhizomePool.query(
      `INSERT INTO edges (subject, predicate, object, phase, observer, notes)
       VALUES ($1, $2, $3, $4, 'browser-extension', $5) ON CONFLICT DO NOTHING`,
      [subject, predicate, object, phase || 'fluid', notes || '']
    );
    return { content: [{ type: 'text', text: `(${subject} --${predicate}--> ${object}) [${phase || 'fluid'}]` }] };
  });

  tool('context_push', 'Record browser page context as rhizome edge', {
    url: z.string(),
    title: z.string().optional(),
    context: z.string().optional(),
    user: z.string().optional(),
  }, async ({ url, title, context, user }) => {
    const subject = user ? `user:${user}` : 'user:unknown';
    const object = `url:${url}`;
    const notes = [title, context].filter(Boolean).join(' — ');
    await rhizome.rhizomePool.query(
      `INSERT INTO edges (subject, predicate, object, phase, observer, notes)
       VALUES ($1, 'visited', $2, 'volatile', 'browser-extension', $3) ON CONFLICT DO NOTHING`,
      [subject, object, notes]
    );
    return { content: [{ type: 'text', text: `context recorded: ${subject} visited ${url}` }] };
  });

  tool('teams_message', 'Store a captured Teams message as rhizome edge', {
    message_id: z.string(),
    channel: z.string().optional(),
    sender: z.string().optional(),
    body: z.string(),
    url: z.string().optional(),
    user: z.string().optional(),
  }, async ({ message_id, channel, sender, body, url, user }) => {
    const subject = user ? `user:${user}` : 'user:unknown';
    const object = `teams-message:${message_id}`;
    const notes = [sender && `from:${sender}`, channel && `in:${channel}`, body.slice(0, 200)].filter(Boolean).join(' | ');
    await rhizome.rhizomePool.query(
      `INSERT INTO edges (subject, predicate, object, phase, observer, notes)
       VALUES ($1, 'read-message', $2, 'fluid', 'browser-extension', $3) ON CONFLICT DO NOTHING`,
      [subject, object, notes]
    );
    if (url) {
      await rhizome.rhizomePool.query(
        `INSERT INTO edges (subject, predicate, object, phase, observer, notes)
         VALUES ($1, 'has-url', $2, 'fluid', 'browser-extension', '') ON CONFLICT DO NOTHING`,
        [object, url]
      );
    }
    return { content: [{ type: 'text', text: `teams message stored: ${object}` }] };
  });

  tool('trello_view', 'View Trello boards and cards', {
    board: z.string().optional(),
    list: z.string().optional(),
  }, async ({ board, list }) => {
    try {
      const bds = await trello.boards();
      if (board === 'boards' || board === 'all') {
        const lines = bds.map((b: any) => `[${b.name}]  ${b.shortUrl}`);
        return { content: [{ type: 'text', text: lines.join('\n') || 'No open boards.' }] };
      }
      let boardName = board;
      if (!boardName) {
        const { execSync } = require('child_process');
        try { boardName = execSync('security find-generic-password -a tasking -s "TRELLO_DEFAULT_BOARD" -w', { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' }).trim(); } catch {}
        if (!boardName) {
          const lines = bds.map((b: any) => `[${b.name}]  ${b.shortUrl}`);
          return { content: [{ type: 'text', text: `No default board set. Run: t reg TRELLO_DEFAULT_BOARD "board name"\n\n${lines.join('\n')}` }] };
        }
      }
      const match = bds.find((b: any) => b.name.toLowerCase().includes(boardName!.toLowerCase()));
      if (!match) return { content: [{ type: 'text', text: `No board matching "${boardName}".` }] };
      const [ls, cs] = await Promise.all([trello.lists(match.id), trello.cards(match.id)]);
      const listMap = Object.fromEntries(ls.map((l: any) => [l.id, l.name]));
      let filtered = cs;
      if (list) {
        const lmatch = ls.find((l: any) => l.name.toLowerCase().includes(list.toLowerCase()));
        if (lmatch) filtered = cs.filter((c: any) => c.idList === lmatch.id);
      }
      if (!filtered.length) return { content: [{ type: 'text', text: 'No open cards.' }] };
      const lines = filtered.map((c: any) => {
        const due = c.due ? ` (due ${c.due.slice(0, 10)})` : '';
        return `• ${c.name}  [${listMap[c.idList] || '?'}]${due}`;
      });
      return { content: [{ type: 'text', text: `${match.name}\n${lines.join('\n')}` }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: e.message }] };
    }
  });

  tool('annotate', 'Run Qwen annotation batch (background)', {
    dry_run: z.boolean().optional(),
  }, async ({ dry_run }) => {
    const { spawn } = require('child_process');
    const fs = require('fs');
    const scriptPath = path.join(__dirname, '..', 'annotate.js');
    const logPath = path.join(__dirname, '..', 'annotate.log');
    const args = dry_run ? ['--dry-run'] : [];
    const logStream = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, [scriptPath, ...args], {
      detached: true,
      stdio: ['ignore', logStream, logStream],
    });
    child.unref();
    return { content: [{ type: 'text', text: `Annotation batch started (pid ${child.pid}). Follow progress: tail -f ${logPath}` }] };
  });
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'tasking', version: '2.0.0' });
  registerTools(server);
  return server;
}

async function main() {
  await db.init();

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if ((req.method === 'POST' || req.method === 'GET') && req.url === '/mcp') {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
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
