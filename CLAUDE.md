# tasking

A bullet-journal task system that runs as a persistent MCP server, surfaces tasks into Claude's context automatically, and traces lifecycle into rhizome-alkahest.

## What this actually is

Not a todo app. A loop.

Tasks go in (low friction). Tasks surface to you (via terminal, Claude Code, Claude Desktop). Claude sees flagged tasks before you speak. Completed tasks crystallize into rhizome as salt edges. Snoozed tasks accumulate as signal.

The goal is ADHD-compatible: the system comes to you, not the other way around.

## Architecture

```
PostgreSQL (tasking db)
  └── tasks table

MCP HTTP server — port 5055
  └── tools: add, list, snooze, complete, cancel, log, move, claude_tasks
  └── launchd: com.hlarsson.tasking (always running)

~/utils/t — CLI wrapper
  └── calls MCP server over HTTP

Claude Code hooks (in ~/.claude/settings.json)
  └── UserPromptSubmit — injects [c] tasks into Claude's context
  └── Stop — shows task list every 5 min cooldown

Claude Desktop
  └── ~/.../claude_desktop_config.json → url: http://localhost:5055/mcp

rhizome-alkahest (postgres: rhizome-alkahest db)
  └── rhizome.js — writes lifecycle edges on add/complete/cancel/snooze/move
  └── observer: tasking-system frame
```

## Task anatomy

```
[id] • body [c] @project  (date)
         │        │
         │        └── local scope (git repo name), absent = global
         └── claude-tagged: surfaces in my context via UserPromptSubmit hook
```

## Statuses

| symbol | meaning |
|--------|---------|
| `•` | open |
| `✓` | done |
| `✗` | cancelled |
| `–` | log entry |

## CLI

```bash
t                        # list today (global + current repo local)
t <text>                 # add global task (bare text)
t add [-l] [-c] <text>   # add task (-l local, -c claude-tagged)
t c <text>               # add claude-tagged, defaults local if in git repo (-g for global)
t log <text>             # log entry
t done <id>              # complete
t cancel <id>            # cancel
t snooze <id> YYYY-MM-DD # snooze
t <id> local|l           # scope to current repo
t <id> global|g          # release to global
t mv <id>                # toggle between local and global
t reg NAME VALUE         # store secret in macOS Keychain
t keys                   # list registered key names
t help                   # this
```

## Scoping

- **Global** (default): visible from anywhere, `project IS NULL`
- **Local**: scoped to a git repo path, shown when `t list` run from that repo
- `t c` defaults to local when in a git repo — claude-tagged tasks are almost always about current context
- `-g` flag forces global

## Rhizome integration

Every task lifecycle event writes an edge to `rhizome-alkahest`:

| event | edge | phase |
|-------|------|-------|
| add | `task:N --records--> body` | fluid |
| add (local) | `task:N --scoped-to--> /path` | fluid |
| add ([c]) | `task:N --flagged-for--> claude` | fluid |
| complete | `task:N --completed-on--> date` | salt |
| cancel | `task:N --cancelled-on--> date` | salt |
| snooze | `task:N --snoozed-to--> date` | fluid |
| move | `task:N --scoped-to--> /path` | fluid |

Completed tasks dissolve their `records` edge. Snooze patterns accumulate — multiple `snoozed-to` edges on the same task are a signal worth reading.

## Secrets

```bash
t reg TEAMS_TOKEN "..."      # stores in macOS Keychain under account 'tasking'
security find-generic-password -a tasking -s TEAMS_TOKEN -w   # retrieve in scripts
```

Claude never reads secrets. Scripts pull from Keychain at runtime.

## What's next (backlog in tasking db, local to this repo)

- **Qwen annotation** — local model sweep of unclear tasks, feeds back as notes/edges
- **Blocking relationships** — `t 5 block 7`, edges native to rhizome
- **Git commit integration** — commit references task id, edge written automatically
- **Teams integration** — post standup, read notifications (pending IT auth)
- **Standup generator** — draft from done + open, post to Teams

## Server management

```bash
# restart
launchctl unload ~/Library/LaunchAgents/com.hlarsson.tasking.plist
launchctl load ~/Library/LaunchAgents/com.hlarsson.tasking.plist

# logs
tail -f ~/repos/tasking/tasking.log

# health
curl http://localhost:5055/health
```

## Key signals to watch for

- Tasks snoozed 3+ times: blocked, too big, or avoidance — ask what's actually going on
- No salt edges in rhizome for >3 days: system stalled, say something
- [c] tasks accumulating without resolution: triage needed
