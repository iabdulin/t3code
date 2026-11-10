#!/bin/bash
# Installs (or reinstalls) the launchd job that runs my-t3code-nightly.sh daily at 01:00.
# Uninstall: launchctl bootout gui/$(id -u)/local.my-t3code.nightly
#            && rm ~/Library/LaunchAgents/local.my-t3code.nightly.plist
set -euo pipefail

LABEL="local.my-t3code.nightly"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/my-t3code-nightly.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/my-t3code-nightly.log"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$SCRIPT</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>1</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL: runs $SCRIPT daily at 01:00. Log: $LOG"
