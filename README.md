# tasking

A persistent bullet-journal task system for terminal natives with ADHD.

Tasks go in fast. The system surfaces them to you — in your terminal, in Claude — rather than waiting for you to remember to look.

## What it does

- **`t <anything>`** — capture a task in under 2 seconds from the terminal
- **Always-running MCP server** — Claude Desktop and Claude Code both connect to it
- **Shell hook** — task list appears when you open a new terminal tab
- **Claude hook** — tasks flagged `[c]` appear in Claude's context before every response
- **Repo-scoped tasks** — tasks can be local to a git repo or global
- **rhizome-alkahest integration** — lifecycle events write into the knowledge graph

## Install

```bash
# requires: Node.js, PostgreSQL running locally

git clone https://github.com/unity-hallie/tasking
cd tasking
npm install

# create the database
psql postgres -c "CREATE DATABASE tasking;"

# start the server (or load launchd to keep it running)
node server.js

# or permanently via launchd
cp com.hlarsson.tasking.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.hlarsson.tasking.plist
```

Put `t` in your PATH:
```bash
ln -s $(pwd)/../utils/t /usr/local/bin/t  # or copy ~/utils/t wherever
```

## Usage

```bash
t                          # list today's tasks
t buy oat milk             # add a task (bare text = global)
t c follow up with Sam     # add claude-tagged task (local to current repo)
t done 5                   # mark done
t snooze 5 2026-03-25      # snooze to date
t 5 local                  # scope to current git repo
t mv 5                     # toggle local/global
t log shipped the thing    # log entry
t reg API_KEY "sk-..."     # store secret in macOS Keychain
t help                     # full command reference
```

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tasking": {
      "url": "http://localhost:5055/mcp"
    }
  }
}
```

## Claude Code

The `UserPromptSubmit` hook injects `[c]`-tagged tasks into Claude's context before every prompt. The `Stop` hook shows your task list every 5 minutes. Add to `~/.claude/settings.json` — see `CLAUDE.md` for the full hook config.

## Philosophy

The system needs to come to you, not the other way around. Every design decision — the shell hook, the Claude context injection, the low-friction `t <text>` capture — exists to reduce the gap between thought and record, and between list and awareness.

Snoozed tasks accumulate as signal in rhizome. Completed tasks crystallize as salt. The pattern is readable over time.
