#!/bin/bash
# Installs a macOS LaunchAgent that sends the weekly digest every Monday at 8am.
# The Mac can be asleep — launchd will wake it to run the job.
#
# Usage: bash scripts/install-weekly-digest.sh
# To uninstall: launchctl unload ~/Library/LaunchAgents/com.jobagent.weekly-digest.plist

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
NODE_PATH="$(which node)"
PLIST="$HOME/Library/LaunchAgents/com.jobagent.weekly-digest.plist"

if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found in PATH. Install Node.js first."
  exit 1
fi

echo "Project: $PROJECT_DIR"
echo "Node:    $NODE_PATH"
echo "Plist:   $PLIST"
echo ""

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.jobagent.weekly-digest</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$PROJECT_DIR/scripts/send-digest.mjs</string>
  </array>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>8</integer>
    <key>Minute</key><integer>0</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>/tmp/jobagent-digest.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/jobagent-digest.log</string>

  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✓ Installed. Weekly digest will run every Monday at 8am."
echo "  Logs: /tmp/jobagent-digest.log"
echo ""
echo "To test immediately: node $PROJECT_DIR/scripts/send-digest.mjs"
echo "To uninstall:        launchctl unload $PLIST && rm $PLIST"
