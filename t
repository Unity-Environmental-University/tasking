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
  // relative: 2h, 3d, 1w, 30m/30min, 2mo — bare words — or absolute YYYY-MM-DD
  if (!str) return null;
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
    // hours/minutes: return full ISO datetime so server stores snoozed_until
    if (unit === 'h' || unit === 'm' || unit === 'min') return d.toISOString();
    return d.toISOString().slice(0, 10);
  }
  // bare word aliases
  const low = str.toLowerCase().trim();
  const today = new Date();
  if (low === 'today') return today.toISOString().slice(0, 10);
  if (low === 'tomorrow') {
    today.setDate(today.getDate() + 1);
    return today.toISOString().slice(0, 10);
  }
  if (low === 'next week' || low === 'nextweek') {
    today.setDate(today.getDate() + 7);
    return today.toISOString().slice(0, 10);
  }
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayIdx = days.indexOf(low);
  if (dayIdx !== -1) {
    const cur = today.getDay();
    const diff = ((dayIdx - cur + 7) % 7) || 7; // next occurrence, never today
    today.setDate(today.getDate() + diff);
    return today.toISOString().slice(0, 10);
  }
  return str; // assume YYYY-MM-DD or ISO datetime
}

const [cmd, ...rest] = args;

if (!cmd || cmd === 'list' || cmd === 'ls') {
  const f = parseFlags(rest);
  const detail = f.rest.includes('-d') || rest.includes('-d');
  const all = f.rest.includes('-a') || rest.includes('-a') || rest.includes('--all');
  if (all) {
    call('list_all', { project: gitRoot() || undefined });
  } else {
    call('list', { project: gitRoot() || undefined, detail: detail || undefined });
  }
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
} else if (cmd === 'loop') {
  // t loop <repo> <message>  — send a cross-repo signal to a Claude loop
  // Creates a global [c] task with "loop:REPO — MESSAGE" format
  // The target repo's Claude will see it in their UserPromptSubmit hook context
  const [targetRepo, ...msgParts] = rest;
  if (!targetRepo || !msgParts.length) {
    console.error('Usage: t loop <repo> <message>');
    console.error('Example: t loop ghostty found something relevant in ocean shaders, check thread:ocean-notes');
    process.exit(1);
  }
  const from = gitRoot() ? gitRoot().split('/').pop() : 'unknown';
  call('add', {
    body: `loop:${targetRepo} — ${msgParts.join(' ')} (from ${from})`,
    project: undefined, // always global
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
  const note = rest.slice(1).join(' ') || undefined;
  call('complete', { id: Number(rest[0]), note });
} else if (cmd === 'cancel' || cmd === 'x') {
  call('cancel', { id: Number(rest[0]) });
} else if (cmd === 'snooze' || cmd === 's') {
  if (!rest[0] || !rest[1]) { console.error('Usage: t snooze <id> <when>  (e.g. 1d, friday, tomorrow, 2026-04-01)'); process.exit(1); }
  call('snooze', { id: Number(rest[0]), to_date: resolveDate(rest[1]) });
} else if (cmd === 'standup') {
  // t standup [--hours N]  — draft standup from recent done + open tasks
  const hoursFlag = rest.indexOf('--hours');
  const hours = hoursFlag !== -1 ? Number(rest[hoursFlag + 1]) : 24;
  call('standup', { since_hours: hours });
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
  t ls -a                  list ALL tasks including done/cancelled (history)
  t <text>                 add a global task (bare text shorthand)

  t add [-l] [-c] <text>   add task  (-l local to repo, -c flag for claude)
  t c [-g] <text>          add claude-tagged task (local if in repo, -g for global)
  t edit <id> <new text>   edit task body
  t log [-l] <text>        add a log/note entry
  t done <id> [note]       mark done (optional closing note written to rhizome)
  t cancel <id>            cancel
  t review <id> [@person]  mark needs-review, create Review: task for person
  t snooze <id> <when>     snooze: tomorrow, friday, next week, 1d, 2w, 2mo, YYYY-MM-DD

  t <id> local|l           scope task to current repo
  t <id> global|g          release task to global
  t mv <id>                toggle task between local and global

  t <id> block <id2>       mark task as blocking another
  t <id> unblock <id2>     remove blocking relationship
  t block <id> <id2>       same as above
  t notes <id>             show Qwen annotation + blocking relationships

  t standup [--hours N]    draft standup from recent done + open tasks (default 24h)
  t loop <repo> <msg>      signal a Claude loop in another repo (global [c] task)
  t annotate [--dry-run]   run Qwen annotation batch on open tasks
  t reg <name> <value>     store a secret in Keychain
  t keys                   list registered key names
`.trim());
} else if (cmd === 'annotate') {
  // Run annotate.js directly (bypasses MCP server — avoids streaming timeout on long Qwen calls)
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const annotateScript = require('path').join(fs.realpathSync(__filename), '..', 'annotate.js');
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
