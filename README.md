# tasking

A persistent bullet-journal task system for terminal natives with ADHD.

Tasks go in fast. The system surfaces them to you — in your terminal, in Claude — rather than waiting for you to remember to look.

→ **[Interactive docs](docs/index.html)**

## Install

```bash
# requires: Node.js, PostgreSQL running locally
git clone https://github.com/Unity-Environmental-University/tasking
cd tasking
bash install.sh
```

`install.sh` creates the database, installs the MCP server as a launchd service, symlinks `t` to `/usr/local/bin/t`, and installs the global git post-commit hook. Idempotent — safe to run again.

## Usage

```bash
t                          # list today's tasks (global + current repo)
t buy oat milk             # add a task (bare text = global)
t c follow up with Sam     # add claude-tagged task (local to current repo)
t done 5                   # mark done
t snooze 5 friday          # snooze: tomorrow, friday, next week, 1d, 2w, YYYY-MM-DD
t mv 5                     # toggle local/global
t standup                  # draft standup from recent done + open tasks
t loop ghostty "message"   # signal a Claude loop in another repo
t log shipped the thing    # log entry
t help                     # full command reference
```

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tasking": { "url": "http://localhost:5055/mcp" }
  }
}
```

## Claude Code hooks

See `CLAUDE.md` for the full hook configuration. The short version:

- **UserPromptSubmit** — injects `[c]`-tagged tasks into Claude's context before every prompt
- **Stop** — shows your task list every 5 minutes in the terminal

## Philosophy

The system needs to come to you, not the other way around. Every design decision — the shell hook, the Claude context injection, the low-friction `t <text>` capture — exists to reduce the gap between thought and record, and between list and awareness.

Snoozed tasks accumulate as signal in rhizome. Completed tasks crystallize as salt. The pattern is readable over time.
