#!/usr/bin/env bash
# install.sh — set up the tasking MCP server on macOS
# Run once after cloning. Idempotent.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
USER="$(whoami)"
NODE="$(which node 2>/dev/null || echo '')"
LABEL="com.${USER}.tasking"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$REPO/tasking.log"

echo "==> tasking installer"
echo "    repo:  $REPO"
echo "    user:  $USER"

# ── Node ─────────────────────────────────────────────────────────────────────
if [ -z "$NODE" ]; then
  echo "✗ node not found. Install Node.js via https://nodejs.org or brew install node"
  exit 1
fi
echo "    node:  $NODE ($(node --version))"

# ── PostgreSQL ────────────────────────────────────────────────────────────────
if ! psql postgres -c '\q' 2>/dev/null; then
  echo "✗ PostgreSQL not reachable. Start it with: brew services start postgresql@17"
  exit 1
fi

if ! psql tasking -c '\q' 2>/dev/null; then
  echo "==> creating tasking database"
  psql postgres -c "CREATE DATABASE tasking;"
fi
echo "    db:    tasking ✓"

# ── npm install ───────────────────────────────────────────────────────────────
echo "==> npm install"
npm install --prefix "$REPO" --silent

# ── CLI symlink ───────────────────────────────────────────────────────────────
# Look for t in a few likely places
CLI_DST="/usr/local/bin/t"
CLI_SRC=""
for candidate in "$REPO/t" "$REPO/../utils/t" "$REPO/utils/t"; do
  if [ -f "$candidate" ]; then
    CLI_SRC="$(realpath "$candidate")"
    break
  fi
done

if [ -n "$CLI_SRC" ]; then
  if [ ! -e "$CLI_DST" ]; then
    echo "==> symlinking t → $CLI_DST (may prompt for password)"
    sudo ln -sf "$CLI_SRC" "$CLI_DST"
    sudo chmod +x "$CLI_DST"
  fi
  echo "    cli:   t ✓  ($CLI_SRC)"
else
  echo "    cli:   t not found — copy it to /usr/local/bin/t manually"
  echo "           (expected at $REPO/t or $REPO/../utils/t)"
fi

# ── launchd plist ─────────────────────────────────────────────────────────────
echo "==> installing launchd service ($LABEL)"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${REPO}/server.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
  <key>WorkingDirectory</key>
  <string>${REPO}</string>
</dict>
</plist>
PLIST

# Unload if already running
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "    launchd: $LABEL loaded ✓"

# ── Health check ──────────────────────────────────────────────────────────────
echo "==> waiting for server..."
for i in $(seq 1 10); do
  if curl -sf http://localhost:5055/health >/dev/null 2>&1; then
    echo "    health: ok ✓"
    break
  fi
  sleep 1
  if [ "$i" -eq 10 ]; then
    echo "✗ server didn't start. Check logs: tail -f $LOG"
    exit 1
  fi
done

# ── Claude Desktop ────────────────────────────────────────────────────────────
CLAUDE_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
if [ -f "$CLAUDE_CFG" ]; then
  if ! grep -q "localhost:5055" "$CLAUDE_CFG" 2>/dev/null; then
    echo ""
    echo "==> Claude Desktop config"
    echo "    Add this to $CLAUDE_CFG under mcpServers:"
    echo '    "tasking": { "url": "http://localhost:5055/mcp" }'
  else
    echo "    claude desktop: already configured ✓"
  fi
fi

echo ""
echo "✓ tasking is running on http://localhost:5055/mcp"
echo ""
echo "  t                  list today's tasks"
echo "  t add <text>       add a task"
echo "  t help             full command reference"
echo ""
echo "  Logs: tail -f $LOG"
echo "  Stop: launchctl unload $PLIST"
