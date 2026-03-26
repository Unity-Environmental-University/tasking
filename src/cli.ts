#!/usr/bin/env node
// t — bullet journal CLI for tasking MCP server
// This is the canonical CLI. ~/utils/t should symlink here.
import { execSync } from 'child_process';

const BASE = 'http://localhost:5055/mcp';

function gitRoot(): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || null;
  } catch { return null; }
}

async function call(tool: string, args: Record<string, any>) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const raw = await res.text();
  let json: any;
  if (raw.trimStart().startsWith('event:') || raw.trimStart().startsWith('data:')) {
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) { json = JSON.parse(line.slice(5).trim()); break; }
    }
  } else {
    json = JSON.parse(raw);
  }
  if (!json) { console.error('No response'); process.exit(1); }
  if (json.error) { console.error(json.error.message); process.exit(1); }
  const text = json.result?.content?.[0]?.text;
  if (text) console.log(text);
}

interface Flags { local: boolean; global: boolean; claude: boolean; needs: string | null; priority: string | null; rest: string[] }

function parseFlags(arr: string[]): Flags {
  const flags: Flags = { local: false, global: false, claude: false, needs: null, priority: null, rest: [] };
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a === '-l' || a === '--local') flags.local = true;
    else if (a === '-g' || a === '--global') flags.global = true;
    else if (a === '-c' || a === '--claude') flags.claude = true;
    else if (a === '--needs' && arr[i + 1]) flags.needs = arr[++i];
    else if ((a === '-A' || a === '-B' || a === '-C') && a.length === 2) flags.priority = a.slice(1);
    else flags.rest.push(a);
  }
  return flags;
}

function resolveDate(str: string): string {
  if (!str) return str;
  const rel = str.match(/^(\d+)(h|min|m|mo|d|w)$/);
  if (rel) {
    const n = parseInt(rel[1]);
    const unit = rel[2];
    const d = new Date();
    if (unit === 'h') d.setHours(d.getHours() + n);
    else if (unit === 'm' || unit === 'min') d.setMinutes(d.getMinutes() + n);
    else if (unit === 'mo') d.setMonth(d.getMonth() + n);
    else if (unit === 'd') d.setDate(d.getDate() + n);
    else if (unit === 'w') d.setDate(d.getDate() + n * 7);
    if (unit === 'h' || unit === 'm' || unit === 'min') return d.toISOString();
    return d.toISOString().slice(0, 10);
  }
  const low = str.toLowerCase().trim();
  const today = new Date();
  if (low === 'today') return today.toISOString().slice(0, 10);
  if (low === 'tomorrow') { today.setDate(today.getDate() + 1); return today.toISOString().slice(0, 10); }
  if (low === 'next week' || low === 'nextweek') { today.setDate(today.getDate() + 7); return today.toISOString().slice(0, 10); }
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayIdx = days.indexOf(low);
  if (dayIdx !== -1) {
    const diff = ((dayIdx - today.getDay() + 7) % 7) || 7;
    today.setDate(today.getDate() + diff);
    return today.toISOString().slice(0, 10);
  }
  return str;
}

const args = process.argv.slice(2);
const [cmd, ...rest] = args;

// ── Known commands (prevents bare-text fallthrough) ──────────────────────
const KNOWN = new Set([
  'list', 'ls', 'edit', 'e', 'add', 'a', 'c', 'h', 'loop',
  'notes', 'n', 'block', 'unblock', 'review', 'rv',
  'done', 'd', 'cancel', 'x', 'snooze', 's',
  'reply', 'r', 'ask', 'thread', 'th',
  'attn', 'attention', 'flag', 'unflag', 'oncall', 'oc',
  'unread', 'signal', 'sig', 'standup',
  'log', 'l', 'reg', 'keys', 'help', '--help', '-h',
  'annotate', 'trello', 'claude_tasks', 'mv',
  'story', 'unstory', 'stories',
  'A', 'B', 'C',  // priority shortcuts
]);

if (!cmd || cmd === 'list' || cmd === 'ls') {
  const f = parseFlags(rest);
  const detail = f.rest.includes('-d') || rest.includes('-d');
  const all = f.rest.includes('-a') || rest.includes('-a') || rest.includes('--all');
  if (all) call('list_all', { project: gitRoot() || undefined });
  else call('list', { project: gitRoot() || undefined, detail: detail || undefined });

} else if (cmd === 'edit' || cmd === 'e') {
  const id = Number(rest[0]);
  const body = rest.slice(1).join(' ');
  if (!id || !body) { console.error('Usage: t edit <id> <new text>'); process.exit(1); }
  call('edit', { id, body });

} else if (cmd === 'add' || cmd === 'a') {
  const f = parseFlags(rest);
  call('add', {
    body: f.rest.join(' '),
    project: f.local ? (gitRoot() || undefined) : undefined,
    tags: f.claude ? ['c'] : [],
    needs: f.needs || undefined,
    priority: f.priority || undefined,
  });

} else if (cmd === 'c') {
  const f = parseFlags(rest);
  const root = gitRoot();
  call('add', {
    body: f.rest.join(' '),
    project: f.global ? undefined : (root || undefined),
    tags: ['c'],
    needs: f.needs || undefined,
    priority: f.priority || undefined,
  });

} else if (cmd === 'h') {
  // add on behalf of hallie
  const f = parseFlags(rest);
  const root = gitRoot();
  call('add', {
    body: f.rest.join(' '),
    project: f.global ? undefined : (root || undefined),
    tags: [],
    source: 'claude:hallie',
    priority: f.priority || undefined,
  });

} else if (cmd === 'loop') {
  const [targetRepo, ...msgParts] = rest;
  if (!targetRepo || !msgParts.length) { console.error('Usage: t loop <repo> <message>'); process.exit(1); }
  const from = gitRoot()?.split('/').pop() || 'unknown';
  call('add', { body: `loop:${targetRepo} — ${msgParts.join(' ')} (from ${from})`, project: undefined, tags: ['c'] });

} else if (cmd === 'notes' || cmd === 'n') {
  call('notes', { id: Number(rest[0]) });

} else if (cmd === 'block') {
  call('block', { blocker: Number(rest[0]), blocked: Number(rest[1]) });

} else if (cmd === 'unblock') {
  call('unblock', { blocker: Number(rest[0]), blocked: Number(rest[1]) });

} else if (cmd === 'review' || cmd === 'rv') {
  call('review', { id: Number(rest[0]), reviewer: rest[1] || undefined });

} else if (cmd === 'done' || cmd === 'd') {
  const note = rest.slice(1).join(' ') || undefined;
  call('complete', { id: Number(rest[0]), note });

} else if (cmd === 'cancel' || cmd === 'x') {
  call('cancel', { id: Number(rest[0]) });

} else if (cmd === 'snooze' || cmd === 's') {
  if (!rest[0] || !rest[1]) { console.error('Usage: t snooze <id> <when>'); process.exit(1); }
  call('snooze', { id: Number(rest[0]), to_date: resolveDate(rest[1]) });

} else if (cmd === 'reply' || cmd === 'r') {
  const id = rest[0];
  if (!id) { console.error('Usage: t reply <id|slug> <text> [--needs @who]'); process.exit(1); }
  let needs: string | undefined;
  const textParts: string[] = [];
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === '--needs' && rest[i + 1]) { needs = rest[i + 1]; i++; continue; }
    textParts.push(rest[i]);
  }
  call('reply', { parent: id, body: textParts.join(' '), source: 'claude', needs: needs || undefined });

} else if (cmd === 'ask') {
  const id = rest[0];
  if (!id || rest.length < 2) { console.error('Usage: t ask <id|slug> <text>'); process.exit(1); }
  call('reply', { parent: id, body: rest.slice(1).join(' '), source: 'claude', needs: '@hallie' });

} else if (cmd === 'thread' || cmd === 'th') {
  call('thread', { ref: rest[0] || '' });

} else if (cmd === 'attn' || cmd === 'attention') {
  const who = rest[0] || '@hallie';
  // Only scope @claude flags by repo — humans see everything
  const isClaudeQuery = ['@claude', '@c', 'claude', 'c'].includes(who.toLowerCase().replace(/^@/, ''));
  call('attention', { who, project: isClaudeQuery ? (gitRoot() || undefined) : undefined });

} else if (cmd === 'flag') {
  const id = Number(rest[0]);
  if (!id) { console.error('Usage: t flag <id> [@who]'); process.exit(1); }
  call('flag', { id, needs: rest[1] || '@hallie' });

} else if (cmd === 'unflag') {
  call('unflag', { id: Number(rest[0]) });

} else if (cmd === 'oncall' || cmd === 'oc') {
  call('oncall', { who: rest[0] || undefined, duration: rest[1] || undefined });

} else if (cmd === 'unread') {
  call('unread', { project: gitRoot() || undefined });

} else if (cmd === 'signal' || cmd === 'sig') {
  call('signal', {});

} else if (cmd === 'standup') {
  const hoursFlag = rest.indexOf('--hours');
  const hours = hoursFlag !== -1 ? Number(rest[hoursFlag + 1]) : 24;
  call('standup', { since_hours: hours });

} else if (cmd === 'log' || cmd === 'l') {
  const f = parseFlags(rest);
  call('log', { body: f.rest.join(' '), project: f.local ? (gitRoot() || undefined) : undefined });

// ── Priority shortcuts: t A <id>, t B <id>, t C <id> ──────────────────
} else if (cmd === 'A' || cmd === 'B' || cmd === 'C') {
  const id = Number(rest[0]);
  if (!id) { console.error(`Usage: t ${cmd} <id>`); process.exit(1); }
  call('priority', { id, priority: cmd });

// ── Stories (personas) ─────────────────────────────────────────────────
} else if (cmd === 'story') {
  const id = Number(rest[0]);
  const persona = rest.slice(1).join('-');
  if (!id || !persona) { console.error('Usage: t story <id> <persona>  (e.g. t story 92 learning student)'); process.exit(1); }
  call('story', { id, persona });

} else if (cmd === 'unstory') {
  const id = Number(rest[0]);
  const persona = rest.slice(1).join('-');
  if (!id || !persona) { console.error('Usage: t unstory <id> <persona>'); process.exit(1); }
  call('unstory', { id, persona });

} else if (cmd === 'stories') {
  call('stories', {});

} else if (cmd === 'reg') {
  const [name, value] = rest;
  if (!name || !value) { console.error('Usage: t reg NAME VALUE'); process.exit(1); }
  const fs = require('fs');
  const idx = `${process.env.HOME}/.tasking-keys`;
  try {
    execSync(`security delete-generic-password -a tasking -s ${JSON.stringify(name)} 2>/dev/null; security add-generic-password -a tasking -s ${JSON.stringify(name)} -w ${JSON.stringify(value)}`, { shell: '/bin/bash', stdio: 'pipe' });
    const existing = fs.existsSync(idx) ? fs.readFileSync(idx, 'utf8').split('\n').filter(Boolean) : [];
    if (!existing.includes(name)) fs.writeFileSync(idx, [...existing, name].join('\n') + '\n');
    console.log(`Stored: ${name}`);
  } catch (e: any) { console.error('Failed:', e.message); process.exit(1); }

} else if (cmd === 'keys') {
  const fs = require('fs');
  const idx = `${process.env.HOME}/.tasking-keys`;
  console.log(fs.existsSync(idx) ? fs.readFileSync(idx, 'utf8').trim() : '(no keys registered)');

} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`
t — bullet journal task manager

  t                        list today's tasks (global + local repo)
  t ls -a                  list ALL tasks including done/cancelled (history)
  t <text>                 add a global task (bare text shorthand)

  t add [-l] [-c] [-A|-B|-C] [--needs @h] <text>
  t c [-g] [-A|-B|-C] <text>   claude-tagged (local if in repo, -g global)
  t h [-g] <text>              add on behalf of hallie (composite observer)
  t edit <id> <new text>       edit task body
  t log [-l] <text>            add a log/note entry
  t done <id> [note]           mark done
  t cancel <id>                cancel
  t review <id> [@person]      mark needs-review
  t snooze <id> <when>         snooze: tomorrow, friday, 1d, 2w, 2mo, YYYY-MM-DD

  t A <id>                     priority A (now)
  t B <id>                     priority B (soon)
  t C <id>                     priority C (someday)

  t <id> local|l               scope to current repo
  t <id> global|g              release to global
  t mv <id>                    toggle local/global

  t block <id> <id2>           mark blocking
  t unblock <id> <id2>         remove blocking
  t notes <id>                 show annotation + blocking + replies

  t ask <id> <text>            reply + auto-flag @hallie (bot asks human)
  t reply <id> <text>          reply (inherits parent scope; @repo overrides)
  t reply <id> <text> --needs @h   reply + flag (@global forces global)
  t thread <id>                show reply thread (marks as read)
  t attn [@who]                tasks needing attention (default @hallie)
  t flag <id> [@who]           flag for attention
  t unflag <id>                clear flag
  t oncall @h 1h               set on-call
  t oncall                     check on-call
  t oncall off                 clear on-call

  t story <id> <persona>       attach persona (e.g. t story 92 learning student)
  t unstory <id> <persona>     remove persona from task
  t stories                    list all personas and their tasks

  t unread                     tasks with new replies since last view
  t signal                     surface patterns: stuck, deferred, velocity
  t standup [--hours N]        draft standup
  t loop <repo> <msg>          signal another Claude loop
  t annotate [--dry-run]       run Qwen annotation batch
  t trello [board] [list]      view Trello
  t reg <name> <value>         store secret in Keychain
  t keys                       list registered key names
`.trim());

} else if (cmd === 'annotate') {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const annotateScript = require('path').join(fs.realpathSync(__filename), '..', '..', 'annotate.js');
  const dryRun = rest.includes('--dry-run') || rest.includes('-n');
  const result = spawnSync(process.execPath, dryRun ? [annotateScript, '--dry-run'] : [annotateScript], {
    stdio: 'inherit', timeout: 300000,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);

} else if (cmd === 'trello') {
  call('trello_view', { board: rest[0] || undefined, list: rest[1] || undefined });

} else if (cmd === 'claude_tasks') {
  call('claude_tasks', { project: rest[0] || undefined });

} else if (cmd === 'mv') {
  call('move', { id: Number(rest[0]), project: gitRoot() || undefined });

} else if (/^\d+$/.test(cmd)) {
  const sub = rest[0];
  if (sub === 'local' || sub === 'l') call('move', { id: Number(cmd), project: gitRoot() || undefined });
  else if (sub === 'global' || sub === 'g') call('move', { id: Number(cmd), project: null });
  else if (sub === 'block' || sub === 'blocks') call('block', { blocker: Number(cmd), blocked: Number(rest[1]) });
  else if (sub === 'unblock') call('unblock', { blocker: Number(cmd), blocked: Number(rest[1]) });
  else if (sub === 'notes' || sub === 'n') call('notes', { id: Number(cmd) });
  else { console.error(`Unknown subcommand: ${sub}`); process.exit(1); }

} else if (!KNOWN.has(cmd)) {
  // bare text = global add
  const f = parseFlags(args);
  call('add', { body: f.rest.join(' '), tags: [], priority: f.priority || undefined });

} else {
  console.error(`Command "${cmd}" recognized but not handled — this is a bug.`);
  process.exit(1);
}
