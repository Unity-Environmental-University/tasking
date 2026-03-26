# tasking

A bullet-journal task system that runs as a persistent MCP server, surfaces tasks into Claude's context automatically, and traces lifecycle into rhizome-alkahest.

## What this actually is

Not a todo app. A loop.

Tasks go in (low friction). Tasks surface to you (via terminal, Claude Code, Claude Desktop). Claude sees flagged tasks before you speak. Completed tasks crystallize into rhizome as salt edges. Snoozed tasks accumulate as signal.

The goal is ADHD-compatible: the system comes to you, not the other way around.

## Arete and hamartia

The system's **arete** (excellence): surfacing what needs attention before you forget it exists. The loop comes to you — hooks, flags, web dashboard. When it works, nothing important drops.

The system's **hamartia** (tragic flaw): it knows what to do but not who it's for. Tasks are organized by status, priority, repo — but not by the person waiting. The task list is shadows on the cave wall. The student who can't find their courses, the advisor drowning in cases — they're the real things casting the shadows.

**Personas** (`t story`) are the turn. A task isn't just work to do — it serves someone. `task:92 --serves--> persona:learning-student` makes the person visible. When three tasks serve the same persona and none have moved, the system can say: "this person is waiting."

**Ions** (proposed, needs alkahest): edges with open valences. `student --learning--> ?` — a need that hasn't found its object yet. When a task fills the blank, the ion bonds to fluid. The gardener's job is noticing these bonds.

Work backwards from who's waiting, not forwards from what's in the queue.

## Architecture

```
PostgreSQL (tasking db)
  └── tasks table (+ needs_attention column)
  └── oncall table (who, until_at — auto-expires)

MCP HTTP server — port 5055
  └── tools: add, list, list_all, edit, snooze, complete, cancel, log, move,
             block, unblock, notes, review, signal, standup, annotate,
             key, reply, thread, activity, attention, flag, unflag, oncall,
             claude_tasks, trello_view, rhizome_edge, context_push, teams_message
  └── launchd: com.hlarsson.tasking (always running)
  └── per-request McpServer instances (safe for concurrent clients)

~/utils/t — CLI wrapper
  └── calls MCP server over HTTP

Claude Code hooks (in ~/.claude/settings.json)
  └── UserPromptSubmit — injects [c] tasks into Claude's context
  └── Stop — shows task list every 5 min cooldown

Claude Desktop
  └── ~/.../claude_desktop_config.json → url: http://localhost:5055/mcp

rhizome-alkahest (postgres: rhizome-alkahest db)
  └── rhizome.js — writes lifecycle edges on add/complete/cancel/snooze/move/block
  └── observers: hallie, unity-rhizome-alkahest, composite (routed by task.source)
```

## Task anatomy

```
[id] • body [c] {source} ⚑@who @project  (date)
         │        │        │       │
         │        │        │       └── local scope (git repo name), absent = global
         │        │        └── needs attention from @who (absent = no flag)
         │        └── {claude} or {claude:hallie} — who created (absent = hallie/human)
         └── claude-tagged: surfaces in my context via UserPromptSubmit hook
```

## Statuses

| symbol | meaning |
|--------|---------|
| `•` | open |
| `✓` | done |
| `✗` | cancelled |
| `–` | log entry |
| `~` | needs-review |

## CLI

```bash
t                        # list today (global + current repo local)
t ls -a                  # list ALL tasks including done/cancelled (history)
t <text>                 # add global task (bare text)
t add [-l] [-c] [--needs @h] <text>  # add task (-l local, -c claude, --needs @who)
t c <text>               # add claude-tagged, source=claude, defaults local if in git repo (-g for global)
t h <text>               # add on behalf of hallie, source=claude:hallie, composite observer (-g for global)
t edit <id> <new text>   # edit task body in place
t log <text>             # log entry
t cancel <id>            # cancel
t snooze <id> <when>     # snooze: 1d, 2w, 2mo, friday, tomorrow, next week, YYYY-MM-DD
t <id> local|l           # scope to current repo
t <id> global|g          # release to global
t mv <id>                # toggle between local and global
t done <id> [note]       # complete (optional closing note → rhizome salt edge)
t review <id> [@person]  # mark needs-review, create Review: task for person
t block <id> <id2>       # mark task as blocking another
t unblock <id> <id2>     # remove blocking relationship
t notes <id>             # show Qwen annotation + blocking relationships
t ask <id> <text>        # reply + auto-flag @hallie — bot asks human, one verb
t reply <id> <text>      # reply to a task (--needs @h to flag for attention)
t thread <id>            # show reply thread (marks as read)
t attn [@who]            # show tasks needing attention (default @hallie)
t flag <id> [@who]       # flag task for someone's attention
t unflag <id>            # clear attention flag
t oncall @h 1h           # set on-call default (auto-flags new tasks/replies)
t oncall                 # check who's on call
t oncall off             # clear on-call
t signal                 # surface patterns: stuck, avoidance, clusters, velocity
t standup [--hours N]    # draft standup from recent done + open tasks
t loop <repo> <msg>      # signal a Claude loop in another repo
t annotate [--dry-run]   # run Qwen annotation batch on open tasks
t trello [board] [list]  # view Trello boards and cards
t reg NAME VALUE         # store secret in macOS Keychain
t keys                   # list registered key names
t help                   # full reference
```

## Scoping

- **Global** (default): visible from anywhere, `project IS NULL`
- **Local**: scoped to a git repo path, shown when `t list` run from that repo
- `t c` defaults to local when in a git repo — claude-tagged tasks are almost always about current context
- `-g` flag forces global
- **@mentions in body**: `@repo-name` in task body auto-resolves to project path (e.g. `@tasking` → `/Users/hlarsson/repos/tasking`). Skips people names (@hallie, @claude).
- **@global**: use `@global` or `@g` in body to explicitly make a task global (won't inherit parent scope)
- **Reply inheritance**: replies inherit their parent's project scope. `@repo` in body overrides to that repo. `@global` overrides to null. No @mention = inherit parent.

## Rhizome integration

Every task lifecycle event writes an edge to `rhizome-alkahest`:

| event | edge | phase |
|-------|------|-------|
| add | `task:N --records--> body` | fluid |
| add (non-hallie) | `task:N --originated-by--> source` | salt |
| add (local) | `task:N --scoped-to--> /path` | fluid |
| add ([c]) | `task:N --flagged-for--> claude` | fluid |
| complete | `task:N --completed-on--> date` | salt |
| complete (with note) | `task:N --closed-with--> note` | salt |
| cancel | `task:N --cancelled-on--> date` | salt |
| snooze | `task:N --snoozed-to--> date` | fluid |
| move | `task:N --scoped-to--> /path` | fluid |
| block | `task:A --blocks--> task:B` | fluid |
| flag/needs | `task:N --needs-attention-from--> @who` | fluid |
| annotate | `task:N --annotated-by--> qwen` | fluid |
| git commit (refs #N) | `task:N --has-commit--> commit:SHA` | fluid |
| git commit (any) | `commit:SHA --in-repo--> repo-name` | fluid |

Observer is routed by `task.source`: hallie's tasks → `hallie` observer, Claude's → `unity-rhizome-alkahest`, composite → both. This enables parallax — seeing where human and agent attention diverge.

**When Claude adds a task**, always pass `source: 'claude'` to the `add` MCP tool. When adding on behalf of Hallie (e.g. capturing something she said), pass `source: 'claude:hallie'`. Never omit source — null defaults to hallie, which misattributes Claude's work.

Completed tasks dissolve their `records` edge. Snooze patterns accumulate — multiple `snoozed-to` edges on the same task are a signal worth reading. `t signal` surfaces these patterns along with stuck tasks, workfront clusters, and completion velocity.

## Attention routing

Tasks can be flagged for someone's attention with `--needs @who` or `t flag`. This answers "who needs to act next?" — not just "what's unread?"

**Explicit:** `t reply 145 "stuck on X" --needs @hallie` or `t c "check this" --needs @h`
**On-call default:** `t oncall @hallie 1h` — for the next hour, every new task/reply auto-flags for @hallie. Expires naturally.
**Inbox:** `t attn` — shows everything flagged for you, across all repos.

`@h` and `@hallie` both resolve to hallie. Claudes can flag each other with `--needs @claude`.

When a Claude creates a task or reply and wants human input, it should use `--needs @hallie`. When it's just a status update, no flag needed. The distinction between "FYI" and "I need you" is the whole point.

**When Claude needs hallie**, use `t ask <id> "question"`. This is the one verb — it replies and flags `@hallie` in one step. Use it when you're stuck, need clarification, or have an idea worth surfacing. Don't use it for status updates — those are just `t reply`. Gratuitous flags train the human to ignore them.

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
- ~~Git commit integration~~ — global post-commit hook at `~/.git-hooks/post-commit`, parameterized queries
- ~~Standup generator~~ — `t standup`, drafts from recent done + open, queries real blockers
- ~~Cross-loop signals~~ — `t loop <repo> <msg>`, protocol documented in CLAUDE.md
- ~~Signal / avoidance detection~~ — `t signal`, surfaces stuck/deferred/clusters/velocity/snooze patterns
- ~~Source field~~ — `task.source` tracks who created (hallie, claude, claude:hallie), routed to rhizome observers
- ~~Edit + history~~ — `t edit <id> <text>`, `t ls -a` for full history
- ~~Per-request server~~ — concurrent MCP clients safe, no transport collision
- ~~Review workflow~~ — `t review <id>`, creates Review: task for reviewer
- ~~Trello integration~~ — `t trello`, reads boards/cards via Keychain credentials
- ~~Browser extension tools~~ — `rhizome_edge`, `context_push`, `teams_message` for cyber-rhizome
- ~~Attention routing~~ — `--needs @h`, `t flag`, `t attn`, `t oncall` — tasks route to who needs to act
- ~~Reply + thread CLI~~ — `t reply`, `t thread` wired through CLI (were MCP-only before)

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
