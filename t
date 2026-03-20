#!/usr/bin/env node
// t — bullet journal CLI for tasking MCP server
// Usage:
//   t [list]                    — list today's tasks (global + local repo)
//   t add [-l] [-c] <text>      — add task (-l = local to repo, -c = claude-tagged)
//   t c [-l] <text>             — add claude-tagged task
//   t done <id>                 — mark done
//   t cancel <id>               — cancel
//   t snooze <id> <date>        — snooze to date
//   t log <text>                — log entry
//   t <id> local|l              — scope task to current repo
//   t <id> global|g             — release task to global
//   t mv <id>                   — toggle task between local and global
//   t <text>                    — bare text: add as global task

const { execSync } = require('child_process');
const BASE = 'http://localhost:5055/mcp';

function gitRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || null;
  } catch { return null; }
}

async function call(tool, args) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: tool, arguments: args }
    })
  });
  const raw = await res.text();
  let json;
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

const args = process.argv.slice(2);

// parse flags
function parseFlags(arr) {
  const flags = { local: false, global: false, claude: false, rest: [] };
  for (const a of arr) {
    if (a === '-l' || a === '--local') flags.local = true;
    else if (a === '-g' || a === '--global') flags.global = true;
    else if (a === '-c' || a === '--claude') flags.claude = true;
    else flags.rest.push(a);
  }
  return flags;
}

function resolveDate(str) {
  // relative: 2h, 3d, 1w, 2m — or absolute YYYY-MM-DD
  if (!str) return null;
  const rel = str.match(/^(\d+)(h|m|d|w)$/);
  if (rel) {
    const n = parseInt(rel[1]);
    const unit = rel[2];
    const d = new Date();
    if (unit === 'h') d.setHours(d.getHours() + n);
    else if (unit === 'm') d.setMinutes(d.getMinutes() + n);
    else if (unit === 'd') d.setDate(d.getDate() + n);
    else if (unit === 'w') d.setDate(d.getDate() + n * 7);
    // hours/minutes: return full ISO datetime so server stores snoozed_until
    if (unit === 'h' || unit === 'm') return d.toISOString();
    return d.toISOString().slice(0, 10);
  }
  return str; // assume YYYY-MM-DD or ISO datetime
}

const [cmd, ...rest] = args;

if (!cmd || cmd === 'list' || cmd === 'ls') {
  const f = parseFlags(rest);
  const detail = f.rest.includes('-d') || rest.includes('-d');
  call('list', { project: gitRoot() || undefined, detail: detail || undefined });
} else if (cmd === 'add' || cmd === 'a') {
  const f = parseFlags(rest);
  call('add', {
    body: f.rest.join(' '),
    project: f.local ? (gitRoot() || undefined) : undefined,
    tags: f.claude ? ['c'] : [],
  });
} else if (cmd === 'c') {
  // claude-tagged shorthand — defaults to local if in a git repo, -g to force global
  const f = parseFlags(rest);
  const root = gitRoot();
  call('add', {
    body: f.rest.join(' '),
    project: f.global ? undefined : (root || undefined),
    tags: ['c'],
  });
} else if (cmd === 'notes' || cmd === 'n') {
  call('notes', { id: Number(rest[0]) });
} else if (cmd === 'block') {
  // t block <blocker-id> <blocked-id>
  call('block', { blocker: Number(rest[0]), blocked: Number(rest[1]) });
} else if (cmd === 'unblock') {
  call('unblock', { blocker: Number(rest[0]), blocked: Number(rest[1]) });
} else if (cmd === 'review' || cmd === 'rv') {
  // t review <id> [@person]  — mark needs-review, create Review: task for person
  call('review', { id: Number(rest[0]), reviewer: rest[1] || undefined });
} else if (cmd === 'done' || cmd === 'd') {
  call('complete', { id: Number(rest[0]) });
} else if (cmd === 'cancel' || cmd === 'x') {
  call('cancel', { id: Number(rest[0]) });
} else if (cmd === 'snooze' || cmd === 's') {
  call('snooze', { id: Number(rest[0]), to_date: resolveDate(rest[1]) });
} else if (cmd === 'log' || cmd === 'l') {
  const f = parseFlags(rest);
  call('log', { body: f.rest.join(' '), project: f.local ? (gitRoot() || undefined) : undefined });
} else if (cmd === 'reg') {
  // t reg NAME VALUE — store in Keychain, index name in ~/.tasking-keys
  const [name, value] = rest;
  if (!name || !value) { console.error('Usage: t reg NAME VALUE'); process.exit(1); }
  const { execSync: ex } = require('child_process');
  const fs = require('fs');
  const idx = `${process.env.HOME}/.tasking-keys`;
  try {
    ex(`security delete-generic-password -a tasking -s ${JSON.stringify(name)} 2>/dev/null; security add-generic-password -a tasking -s ${JSON.stringify(name)} -w ${JSON.stringify(value)}`, { shell: true, stdio: 'pipe' });
    const existing = fs.existsSync(idx) ? fs.readFileSync(idx, 'utf8').split('\n').filter(Boolean) : [];
    if (!existing.includes(name)) fs.writeFileSync(idx, [...existing, name].join('\n') + '\n');
    console.log(`Stored: ${name}`);
  } catch (e) { console.error('Failed:', e.message); process.exit(1); }
} else if (cmd === 'keys') {
  const fs = require('fs');
  const idx = `${process.env.HOME}/.tasking-keys`;
  const keys = fs.existsSync(idx) ? fs.readFileSync(idx, 'utf8').trim() : '';
  console.log(keys || '(no keys registered)');
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`
t — bullet journal task manager

  t                        list today's tasks (global + local repo)
  t <text>                 add a global task (bare text shorthand)

  t add [-l] [-c] <text>   add task  (-l local to repo, -c flag for claude)
  t c [-l] <text>          add claude-tagged task
  t log [-l] <text>        add a log/note entry
  t done <id>              mark done
  t cancel <id>            cancel
  t review <id> [@person]  mark needs-review, create Review: task for person
  t snooze <id> <when>     snooze: 2h, 3d, 1w, 2m, or YYYY-MM-DD

  t <id> local|l           scope task to current repo
  t <id> global|g          release task to global
  t mv <id>                toggle task between local and global

  t <id> block <id2>       mark task as blocking another
  t <id> unblock <id2>     remove blocking relationship
  t block <id> <id2>       same as above
  t notes <id>             show Qwen annotation + blocking relationships
  t list -d                (alias: not yet implemented inline — use t notes <id>)

  t annotate [--dry-run]   run Qwen annotation batch on open tasks
  t reg <name> <value>     store a secret in Keychain
  t keys                   list registered key names
`.trim());
} else if (cmd === 'annotate') {
  // Run annotate.js directly (bypasses MCP server — avoids streaming timeout on long Qwen calls)
  const { spawnSync } = require('child_process');
  const annotateScript = '/Users/hlarsson/repos/tasking/annotate.js';
  const dryRun = rest.includes('--dry-run') || rest.includes('-n');
  const result = spawnSync(process.execPath, dryRun ? [annotateScript, '--dry-run'] : [annotateScript], {
    stdio: 'inherit',
    timeout: 300000,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
} else if (cmd === 'trello') {
  // t trello                — cards on default board
  // t trello boards         — list all boards
  // t trello <board>        — cards on named board
  // t trello <board> <list> — filter by list name
  call('trello_view', { board: rest[0] || undefined, list: rest[1] || undefined });
} else if (cmd === 'claude_tasks') {
  call('claude_tasks', {});
} else if (cmd === 'mv') {
  call('move', { id: Number(rest[0]), project: gitRoot() || undefined });
} else if (/^\d+$/.test(cmd)) {
  // t <id> local|l|global|g|block <id2>|unblock <id2>|notes
  const sub = rest[0];
  if (sub === 'local' || sub === 'l') {
    call('move', { id: Number(cmd), project: gitRoot() || undefined });
  } else if (sub === 'global' || sub === 'g') {
    call('move', { id: Number(cmd), project: null });
  } else if (sub === 'block' || sub === 'blocks') {
    call('block', { blocker: Number(cmd), blocked: Number(rest[1]) });
  } else if (sub === 'unblock') {
    call('unblock', { blocker: Number(cmd), blocked: Number(rest[1]) });
  } else if (sub === 'notes' || sub === 'n') {
    call('notes', { id: Number(cmd) });
  } else {
    console.error(`Unknown subcommand: ${sub}`);
    process.exit(1);
  }
} else {
  // bare text = global add
  const f = parseFlags(args);
  call('add', { body: f.rest.join(' '), tags: [] });
}
