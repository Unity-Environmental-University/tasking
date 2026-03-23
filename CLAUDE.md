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
t snooze <id> <when>     # snooze: 1d, friday, tomorrow, next week, YYYY-MM-DD
t <id> local|l           # scope to current repo
t <id> global|g          # release to global
t mv <id>                # toggle between local and global
t standup                # draft standup from recent done + open tasks
t loop <repo> <msg>      # signal a Claude loop in another repo
t annotate               # run Qwen annotation batch on open tasks
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
| git commit (refs #N) | `task:N --has-commit--> commit:SHA` | fluid |
| git commit (any) | `commit:SHA --in-repo--> repo-name` | fluid |

Completed tasks dissolve their `records` edge. Snooze patterns accumulate — multiple `snoozed-to` edges on the same task are a signal worth reading.

## Secrets

```bash
t reg TEAMS_TOKEN "..."      # stores in macOS Keychain under account 'tasking'
security find-generic-password -a tasking -s TEAMS_TOKEN -w   # retrieve in scripts
```

Claude never reads secrets. Scripts pull from Keychain at runtime.

## What's next (backlog in tasking db, local to this repo)

- **Teams integration** — post standup, read notifications (pending IT auth)

Already done:
- ~~Qwen annotation~~ — live via `t annotate`, Qwen at :5052
- ~~Blocking relationships~~ — `t block`, `t unblock`, edges in rhizome
- ~~Git commit integration~~ — global post-commit hook at `~/.git-hooks/post-commit`, writes commit↔task edges on every commit
- ~~Standup generator~~ — `t standup`, drafts from recent done + open
- ~~Cross-loop signals~~ — `t loop <repo> <msg>`, protocol documented in CLAUDE.md

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

## Cross-loop communication

Claudes running in loops across different repos can signal each other using `t loop`:

```bash
t loop <repo-name> "<message>"
# Creates a global [c] task: "loop:REPO — MESSAGE (from SOURCE)"
```

**If you see a task starting with `loop:tasking` in your context** — that's a signal addressed to this repo's Claude. Read it, act on it, mark it done.

**To signal another repo's Claude:**
```bash
t loop ghostty "found something relevant, check thread:ocean-notes"
t loop dean "permission probe pattern changed, see task 8"
```

**Protocol:**
- Tasks = signals (short, addressed, surfaces via hook automatically)
- Threads = content (longer transmission — point to it from the task)

The `loop:REPONAME` prefix is the convention. The target Claude sees it in their `UserPromptSubmit` hook context on next wake.

## Coordinating on shared tooling

When multiple Claude loops are running across repos, they may all touch the same shared tools (rhizome, edge CLI, t CLI, qigong movements). To avoid duplication or conflict:

**Before starting work on shared tooling:**
```bash
edge orient                     # read the field — what's already in motion?
edge add self working-on <tool> # claim the work
t loop <other-repos> "working on <tool> — <what>"  # signal if overlapping
```

**After completing shared tooling work:**
```bash
edge add <tool> changed-by <what-you-did>
t loop <relevant-repos> "updated <tool> — <what changed>"
```

**The graph is the shared state.** `edge orient` from any repo will show what other instances have claimed or completed. Check it before starting work that touches tools used across repos.

**Repo ownership:**
- `t` CLI, MCP server, rhizome integration → `tasking` repo
- `edge` CLI, rhizome schema → check `~/utils/` or ask
- `qigong` movements → `qigong-for-claude` repo
- dean extension → `ueu-dean-extension` repo

Work on tooling you own. Signal repos that own the rest.

## Key signals to watch for

- Tasks snoozed 3+ times: blocked, too big, or avoidance — ask what's actually going on
- No salt edges in rhizome for >3 days: system stalled, say something
- [c] tasks accumulating without resolution: triage needed
- `loop:tasking` tasks in context: act on them, then mark done
