#!/bin/bash
# Nightly updater for "My T3 Code" (this fork, branch `mine`).
#
# 1. Fast-forwards local main to upstream/main and rebases `mine` onto it. Local
#    commits whose subject already landed upstream (a cherry-picked PR that got
#    merged) are dropped. On a conflict the rebase is aborted and nothing changes.
# 2. Rebuilds the desktop app when the branch moved or the last build failed.
# 3. Waits until no T3 Code thread is running, quits the app, replaces
#    /Applications/My T3 Code.app (previous build kept as a zip) and relaunches it.
#
# launchd (local.my-t3code.nightly, see install-nightly.sh) starts it at 01:00;
# it gives up at 05:00. `--now` asks launchd to run it right away with a 3-hour
# window, so quitting the app does not kill the updater. `--force` also rebuilds
# when nothing changed. `--sync-only` runs here and stops after the rebase.
# Log: ~/Library/Logs/my-t3code-nightly.log
set -uo pipefail

LABEL="local.my-t3code.nightly"
REPO="${MY_T3CODE_REPO:-$HOME/Sites/t3code}"
BRANCH="mine"
APP_BUNDLE_ID="com.t3tools.t3code"
APP_NAME="My T3 Code"
APP="/Applications/$APP_NAME.app"
OFFICIAL_APP="/Applications/T3 Code (Beta).app"
STATE_DIR="${MY_T3CODE_STATE_DIR:-$HOME/Library/Application Support/my-t3code-nightly}"
DB="$HOME/.t3/userdata/statev2.sqlite"
WINDOW_START_HOUR=0
WINDOW_END_HOUR=5
RETRY_SECONDS=900

export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
unset T3CODE_DESKTOP_UPDATE_REPOSITORY GITHUB_REPOSITORY

mkdir -p "$STATE_DIR"
RUN_NOW_FLAG="$STATE_DIR/run-now"
FORCE_FLAG="$STATE_DIR/force"

# Manual trigger: hand the run to launchd so it survives the app quitting.
if [[ "${1:-}" == "--now" || "${1:-}" == "--force" ]]; then
  touch "$RUN_NOW_FLAG"
  [[ "${1:-}" == "--force" ]] && touch "$FORCE_FLAG"
  launchctl kickstart "gui/$(id -u)/$LABEL" && echo "Started. Follow: tail -f ~/Library/Logs/my-t3code-nightly.log"
  exit $?
fi

# The rebase below rewrites this file, and bash reads scripts lazily: run from a copy.
if [[ "${MY_T3CODE_NIGHTLY_COPY:-}" != 1 ]]; then
  cp "$0" "$STATE_DIR/run.sh"
  MY_T3CODE_NIGHTLY_COPY=1 exec /bin/bash "$STATE_DIR/run.sh" "$@"
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
notify() {
  log "NOTIFY: $1"
  osascript -e "display notification \"${1//\"/\'}\" with title \"My T3 Code updater\"" >/dev/null 2>&1 || true
}

LOCK="$STATE_DIR/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  log "another run holds $LOCK, exiting"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

manual=false
force=false
sync_only=false
[[ "${1:-}" == "--sync-only" ]] && sync_only=true && manual=true
[[ -e "$RUN_NOW_FLAG" ]] && manual=true && rm -f "$RUN_NOW_FLAG"
[[ -e "$FORCE_FLAG" ]] && force=true && rm -f "$FORCE_FLAG"

if $manual; then
  deadline=$(( $(date +%s) + 3 * 3600 ))
else
  hour=$((10#$(date +%H)))
  if (( hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR )); then
    log "started at $(date +%H:%M), outside the ${WINDOW_START_HOUR}:00-${WINDOW_END_HOUR}:00 window, skipping"
    exit 0
  fi
  deadline=$(date -j -f '%Y-%m-%d %H:%M:%S' "$(date +%Y-%m-%d) $(printf '%02d' $WINDOW_END_HOUR):00:00" +%s)
fi
log "=== start (manual=$manual force=$force) ==="

# Prints the number of unfinished agent runs; fails when the database can't be read.
running_threads() {
  sqlite3 -readonly "file:$DB?mode=ro" \
    "select count(*) from orchestration_v2_projection_runs where status not in ('completed','failed','cancelled','interrupted','rolled_back')"
}

# Returns 0 once T3 Code is idle, 1 when the deadline passes first.
# An unreadable database counts as busy.
wait_until_idle() {
  local count
  while :; do
    if count=$(running_threads 2>&1) && [[ "$count" =~ ^[0-9]+$ ]]; then
      (( count == 0 )) && return 0
      log "$count thread(s) running"
    else
      log "could not read thread status: $count"
    fi
    (( $(date +%s) + RETRY_SECONDS > deadline )) && return 1
    sleep "$RETRY_SECONDS"
  done
}

cd "$REPO" || { notify "Repo $REPO is missing"; exit 1; }
if [[ "$(git branch --show-current)" != "$BRANCH" ]]; then
  notify "Skipped: $REPO is not on branch $BRANCH"
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  notify "Skipped: $REPO has uncommitted changes"
  exit 1
fi

# --- Sync with upstream -------------------------------------------------------
if ! git fetch --quiet upstream; then
  notify "Skipped: git fetch upstream failed"
  exit 1
fi
if ! git merge-base --is-ancestor main upstream/main; then
  notify "Skipped: local main has commits that are not upstream"
  exit 1
fi
git branch -f main upstream/main

drop_file="$STATE_DIR/drop-commits"
: > "$drop_file"
upstream_subjects=$(git log --format=%s -n 3000 upstream/main)
while read -r sha subject; do
  [[ -z "$sha" ]] && continue
  if grep -Fxq -e "$subject" <<<"$upstream_subjects" || grep -Fq -e "$subject (#" <<<"$upstream_subjects"; then
    log "dropping local commit already upstream: $subject"
    echo "$sha" >> "$drop_file"
  fi
done < <(git log --reverse --format='%H %s' "main..$BRANCH")

before=$(git rev-parse HEAD)
if [[ -s "$drop_file" ]]; then
  editor="$STATE_DIR/drop-editor.sh"
  cat > "$editor" <<EOF
#!/bin/bash
todo="\$1"
while IFS= read -r line; do
  set -- \$line
  if [[ "\${1:-}" == pick ]] && grep -Fxq "\$(git rev-parse "\$2")" "$drop_file"; then
    echo "drop \${*:2}"
  else
    echo "\$line"
  fi
done < "\$todo" > "\$todo.new" && mv "\$todo.new" "\$todo"
EOF
  chmod +x "$editor"
  GIT_SEQUENCE_EDITOR="$editor" git rebase -i --quiet main
else
  git rebase --quiet main
fi
if (( $? != 0 )); then
  git rebase --abort 2>/dev/null
  notify "Upstream conflicts with your changes. Kept the current app. See the log."
  exit 1
fi
after=$(git rev-parse HEAD)
log "branch $BRANCH: $(git rev-parse --short "$before") -> $(git rev-parse --short "$after"), $(git rev-list --count "main..$BRANCH") local commit(s) on top of upstream $(git rev-parse --short main)"
$sync_only && exit 0

# --- Build --------------------------------------------------------------------
last_built=$(cat "$STATE_DIR/last-built" 2>/dev/null || true)
last_installed=$(cat "$STATE_DIR/last-installed" 2>/dev/null || true)
zip=$(ls -t release/*-arm64.zip 2>/dev/null | head -1)

if ! $force && [[ "$last_installed" == "$after" && -d "$APP" ]]; then
  log "already installed $(git rev-parse --short "$after"), nothing to do"
  exit 0
fi

if $force || [[ "$last_built" != "$after" || -z "$zip" ]]; then
  node_version=$(sed -n 's/^ *"node": "\([0-9.]*\)".*/\1/p' package.json | head -1)
  log "building with Node $node_version"
  if ! vp env exec --node "$node_version" vp i; then
    notify "Build failed (dependency install). Kept the current app."
    exit 1
  fi
  # A rebase can apply cleanly and still break the fork's changes. This runs the repo's
  # checks (types, lint, tests) for the files the fork changed.
  if ! vp env exec --node "$node_version" vp run check:changed; then
    notify "Fork checks failed after the upstream sync. Kept the current app. See the log."
    exit 1
  fi
  if ! vp env exec --node "$node_version" vp run dist:desktop:dmg; then
    notify "Build failed. Kept the current app. See the log."
    exit 1
  fi
  zip=$(ls -t release/*-arm64.zip 2>/dev/null | head -1)
  echo "$after" > "$STATE_DIR/last-built"
fi
log "artifact: $zip"

staging="$STATE_DIR/staging"
rm -rf "$staging" && mkdir -p "$staging"
if ! ditto -x -k "$zip" "$staging" || [[ ! -d "$staging/$APP_NAME.app" ]]; then
  notify "Build output has no $APP_NAME.app. Kept the current app."
  exit 1
fi

# Sign with the local identity from setup-signing.sh, so the app's identity (and with
# it Keychain "Always Allow" and privacy permissions) stays the same across builds.
SIGNING_IDENTITY="My T3 Code Local Signing"
SIGNING_KEYCHAIN="$HOME/Library/Keychains/my-t3code-signing.keychain-db"
SIGNING_PASSWORD_FILE="$STATE_DIR/signing-keychain-password"
if [[ -f "$SIGNING_KEYCHAIN" && -f "$SIGNING_PASSWORD_FILE" ]]; then
  if ! { security unlock-keychain -p "$(cat "$SIGNING_PASSWORD_FILE")" "$SIGNING_KEYCHAIN" &&
    codesign --force --deep --sign "$SIGNING_IDENTITY" --keychain "$SIGNING_KEYCHAIN" "$staging/$APP_NAME.app" &&
    codesign --verify --deep --strict "$staging/$APP_NAME.app"; }; then
    notify "Signing failed. Kept the current app. See the log."
    exit 1
  fi
  log "signed with \"$SIGNING_IDENTITY\""
else
  log "no local signing identity (run fork/setup-signing.sh), installing the ad-hoc build"
fi

# --- Install when idle --------------------------------------------------------
if ! wait_until_idle; then
  notify "Built, but threads kept running. Will install on the next run."
  exit 0
fi

APP_MAIN_PATTERN="/Applications/($APP_NAME|T3 Code \\(Beta\\))\\.app/Contents/MacOS/[^/]+$"
app_pids() { pgrep -f "$APP_MAIN_PATTERN"; }
if [[ -n "$(app_pids)" ]]; then
  log "quitting the app"
  osascript -e "with timeout of 30 seconds" -e "tell application id \"$APP_BUNDLE_ID\" to quit" -e "end timeout" >/dev/null 2>&1 \
    || pkill -TERM -f "$APP_MAIN_PATTERN"
  for _ in $(seq 1 90); do [[ -z "$(app_pids)" ]] && break; sleep 1; done
  if [[ -n "$(app_pids)" ]]; then
    notify "The app did not quit. Install skipped."
    exit 1
  fi
fi

if [[ -d "$OFFICIAL_APP" ]]; then
  log "moving the official app out of /Applications (backup: official-T3-Code-Beta.zip)"
  ditto -c -k --keepParent "$OFFICIAL_APP" "$STATE_DIR/official-T3-Code-Beta.zip" && rm -rf "$OFFICIAL_APP"
fi
if [[ -d "$APP" ]]; then
  ditto -c -k --keepParent "$APP" "$STATE_DIR/previous.zip" && rm -rf "$APP"
fi
mv "$staging/$APP_NAME.app" "$APP"
open "$APP"

for _ in $(seq 1 60); do [[ -n "$(app_pids)" ]] && break; sleep 1; done
if [[ -z "$(app_pids)" ]]; then
  log "new build did not start, restoring the previous one"
  if [[ -f "$STATE_DIR/previous.zip" ]]; then
    rm -rf "$APP" && ditto -x -k "$STATE_DIR/previous.zip" /Applications && open "$APP"
  fi
  notify "New build did not start. Restored the previous app."
  exit 1
fi

echo "$after" > "$STATE_DIR/last-installed"
notify "Updated: upstream $(git log -1 --format='%h %s' main | cut -c1-70)"
log "=== done ==="
