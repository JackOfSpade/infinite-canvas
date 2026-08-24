#!/bin/zsh
# Infinite Canvas — ONE icon: rebuild only if the source changed, then launch the
# app straight from the project's build output (no separate .app on the Desktop).
# Loads nvm so npm is on PATH; electron-builder runs only when the source tree's
# content hash differs from the hash recorded after the last SUCCESSFUL build.
# Unchanged launches are instant; a real rebuild can take a few minutes.
#
# This is the canonical, version-controlled launcher. "~/Desktop/Infinite
# Canvas.command" is a thin wrapper that exec's this file — edit THIS one.
# Double-clicking this file directly works too.

# Derived from this script's own location (<repo>/scripts/ -> <repo>) rather
# than hardcoded, so the project can be moved or cloned elsewhere without
# editing the launcher. ${0:A} resolves symlinks to an absolute path; each
# :h strips one trailing path component.
PROJECT_DIR="${0:A:h:h}"
RELEASE_APP="$PROJECT_DIR/release/mac-arm64/infinite-canvas.app"
# release/ is gitignored, so keeping launcher state under it is safe.
STATE_DIR="$PROJECT_DIR/release/.launcher"
STAMP="$STATE_DIR/last-build-ok"
LOCK="$STATE_DIR/build.lock"
LOG="$STATE_DIR/last-build.log"

ticker_pid=""
lock_held=0
stale_pid=""
# A normal Electron quit asks every renderer to finish its beforeunload/save
# work. Give that handshake enough time, but never turn a double-click launch
# into an unbounded wait or fall back to killing a canvas editor.
STALE_QUIT_TIMEOUT_SECONDS=30
STALE_QUIT_POLL_SECONDS=0.5
STALE_QUIT_REQUEST_TIMEOUT_SECONDS=5
APP_BUNDLE_ID="com.antigravity.infinitecanvas"
# Matches only the app's MAIN process: the helpers live under
# Contents/Frameworks/... so they can't collide with this path fragment.
APP_PROC_PATTERN="infinite-canvas.app/Contents/MacOS/infinite-canvas"

# ---- functions (defined up front; execution starts after this block) ----

notify() {
  # $1 gets interpolated into an AppleScript string literal below, so escape
  # backslashes first, then double quotes, or a message containing either
  # could break out of the literal or corrupt the notification text.
  local msg="$1"
  msg="${msg//\\/\\\\}"
  msg="${msg//\"/\\\"}"
  osascript -e "display notification \"$msg\" with title \"Infinite Canvas\" sound name \"$2\"" >/dev/null 2>&1
}

# Prints a sha256 over the project's tracked/untracked-but-not-ignored source
# tree (name|mtime|size per file). Used instead of Info.plist's mtime because
# that mtime survives an interrupted codesign pass and can lie "up to date".
source_manifest() {
  {
    if git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      # -z + --cached --others --exclude-standard: honours .gitignore exactly
      # (node_modules/dist/dist-electron/release/.env/.claude/.DS_Store all
      # excluded automatically) and catches added AND deleted files, which a
      # plain `find -newer` cannot.
      git -C "$PROJECT_DIR" ls-files -z --cached --others --exclude-standard
    else
      find . \( -path './node_modules' -o -path './.git' -o -path './release' \
                 -o -path './dist' -o -path './dist-electron' -o -path './out' \) -prune \
             -o -type f ! -name '.DS_Store' -print0
    fi
    # .env is deliberately gitignored (secrets), so the listing above never
    # sees it — but Vite INLINES the VITE_-prefixed vars at BUILD time into
    # both the renderer and the bundled main process, and .env is not shipped
    # inside the .app. An .env edit therefore needs a rebuild to take effect,
    # and without this it would silently never get one. Only name|mtime|size
    # is hashed here, never file contents, so no secret reaches the stamp.
    for envfile in .env .env.*(N); do
      [[ -f "$envfile" ]] && printf '%s\0' "$envfile"
    done
    # NUL-delimited list is piped straight into xargs below, never captured
    # into a variable/command-substitution — zsh mangles embedded NULs.
  } | xargs -0 stat -f '%N|%m|%z' 2>/dev/null | sort | shasum -a 256 | awk '{print $1}'
}

# Integrity gate: true only if the app exists, its binary is executable, and
# its code signature verifies. Plain --verify (not --deep) stays fast on a
# 385MB bundle. On the known-corrupt half-signed build this fails with
# "code has no resources but signature indicates they must be present".
verify_app() {
  [[ -d "$RELEASE_APP" ]] || return 1
  [[ -x "$RELEASE_APP/Contents/MacOS/infinite-canvas" ]] || return 1
  codesign --verify "$RELEASE_APP" >/dev/null 2>&1
}

fail() {
  echo "x $1"
  if [[ -f "$LOG" ]]; then
    echo "---- last 40 lines of $LOG ----"
    tail -n 40 "$LOG"
  fi
  notify "$1" "Basso"
  echo
  echo "Press any key to close this window..."
  read -k1 2>/dev/null || read -r
  exit 1
}

# electron-builder prints one "signing" line then goes silent for 1-3 minutes
# while it runs ~150 nested codesign invocations. Without a heartbeat that
# silent stretch is indistinguishable from a hung build, so tick every 10s.
start_ticker() {
  (
    t=0
    while true; do
      sleep 10
      t=$((t + 10))
      echo "   ... still building - ${t}s elapsed (the long silent stretch is code-signing ~150 nested binaries)"
    done
  ) &
  ticker_pid=$!
}

stop_ticker() {
  if [[ -n "$ticker_pid" ]]; then
    kill "$ticker_pid" 2>/dev/null
    wait "$ticker_pid" 2>/dev/null
    ticker_pid=""
  fi
}

acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then
    echo $$ > "$LOCK/pid"
    lock_held=1
    return 0
  fi
  local other_pid=""
  [[ -f "$LOCK/pid" ]] && other_pid="$(<"$LOCK/pid")"
  if [[ -n "$other_pid" ]] && kill -0 "$other_pid" 2>/dev/null; then
    echo "x Another build is already running (pid $other_pid) - not starting a second one."
    notify "Another build is already running." "Basso"
    exit 1
  fi
  # Lock dir exists but its owner is gone - a previous build died without
  # cleaning up. It's stale; reclaim it. mkdir is atomic, so if a second
  # process is racing us through this same reclaim (e.g. two near-simultaneous
  # launches finding the same stale lock), only one of us wins it - check
  # the result instead of assuming success, or both processes would believe
  # they exclusively hold the lock and run concurrent builds against the
  # same output directory.
  rm -rf "$LOCK"
  if ! mkdir "$LOCK" 2>/dev/null; then
    echo "x Lock contention while reclaiming a stale lock - not starting a second build."
    notify "Another build is already running." "Basso"
    exit 1
  fi
  echo $$ > "$LOCK/pid"
  lock_held=1
}

release_lock() {
  if [[ "$lock_held" -eq 1 ]]; then
    rm -rf "$LOCK"
    lock_held=0
  fi
}

on_exit() {
  stop_ticker
  release_lock
}
trap on_exit EXIT

# INT/TERM must also actually terminate the script. Trapping them onto
# on_exit alone (as `trap on_exit EXIT INT TERM`) runs the cleanup but does
# NOT stop execution: on_exit never calls exit, so the script resumes right
# where the signal interrupted it (e.g. mid-build) and runs to completion
# regardless - Ctrl-C / kill -TERM would be silently swallowed. Untrap first
# so the re-raised signal below isn't re-caught, then re-deliver it to
# ourselves so the process actually exits with the correct signal status.
on_signal() {
  trap - EXIT INT TERM
  on_exit
  kill -"$1" $$
}
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

sync_dependencies() {
  if [[ ! -d "$PROJECT_DIR/node_modules" ]] || [[ "$PROJECT_DIR/package-lock.json" -nt "$PROJECT_DIR/node_modules/.package-lock.json" ]]; then
    echo "> Dependencies out of date - running npm install..."
    npm install || fail "npm install failed."
  fi
}

# A rebuild replaces the bundle on disk, but `open` activates an already
# running app instead of starting that replacement. Ask the exact app bundle
# to quit only after the new bundle has passed codesign verification, then wait
# for the main PID captured *before* the build. This intentionally gives the
# renderer's save/beforeunload handshake time to complete; never force-kill it.
quit_stale_prebuild_instance() {
  [[ -n "$stale_pid" ]] || return 0
  kill -0 "$stale_pid" 2>/dev/null || return 0

  echo "> Rebuild verified - asking the previous Infinite Canvas instance (pid $stale_pid) to quit and save..."
  # Bound the Apple event itself too. The renderer may need time to complete
  # its save handshake, but an unresponsive app must not leave this launcher
  # blocked indefinitely before the PID wait below can report a clear failure.
  if ! osascript \
    -e "with timeout of $STALE_QUIT_REQUEST_TIMEOUT_SECONDS seconds" \
    -e "tell application id \"$APP_BUNDLE_ID\" to quit" \
    -e 'end timeout' >/dev/null 2>&1; then
    # A timed-out Apple event may still have delivered the quit request while
    # the renderer is completing its save handshake. Do not mistake the lack
    # of an acknowledgement for a failed quit: the bounded PID wait below is
    # the authoritative outcome.
    echo "  Quit request was not acknowledged within ${STALE_QUIT_REQUEST_TIMEOUT_SECONDS}s; waiting for the save/quit handshake..."
  fi

  # Do not rely on the optional zsh/datetime module for EPOCHSECONDS: this
  # launcher is also expected to work in the minimal non-interactive zsh that
  # Finder uses for .command files.
  local deadline=$(( $(date +%s) + STALE_QUIT_TIMEOUT_SECONDS ))
  while kill -0 "$stale_pid" 2>/dev/null; do
    if (( $(date +%s) >= deadline )); then
      return 1
    fi
    sleep "$STALE_QUIT_POLL_SECONDS"
  done

  echo "> Previous instance exited; launching the rebuilt app."
}

# ---- execution starts here ----

cd "$PROJECT_DIR" 2>/dev/null || { echo "ERROR: project directory not found."; notify "Launch failed: project not found." "Basso"; exit 1; }
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
unset ELECTRON_RUN_AS_NODE          # electron-builder must NOT run under ELECTRON_RUN_AS_NODE

mkdir -p "$STATE_DIR"

manifest="$(source_manifest)"

need_build=0
if [[ ! -d "$RELEASE_APP" ]]; then
  need_build=1
elif [[ ! -f "$STAMP" ]]; then
  need_build=1
elif [[ "$(<"$STAMP")" != "$manifest" ]]; then
  need_build=1
elif ! verify_app; then
  need_build=1
fi

if [[ "$need_build" -eq 1 ]]; then
  acquire_lock
  sync_dependencies

  # Remember any instance that predates this build. After a successful build
  # and codesign verification we ask this captured instance to quit gracefully
  # before opening the replacement, so macOS cannot reactivate stale code.
  # We never force-quit: this is a canvas editor and its renderer must retain
  # control of the normal save/beforeunload handshake.
  stale_pid="$(pgrep -f "$APP_PROC_PATTERN" 2>/dev/null | head -1)"

  # npm install can rewrite package-lock.json, which IS a tracked file and so
  # is part of the manifest. Recompute after the install, otherwise we'd record
  # the pre-install hash and every subsequent launch would see a mismatch and
  # rebuild forever.
  manifest="$(source_manifest)"

  # Delete the success sentinel before the build itself touches the app
  # bundle. If this build is interrupted or killed, no stale sentinel
  # survives to fool the next launch into trusting a half-built (or
  # half-signed) app - that mismatch/absence is the core of the fix.
  rm -f "$STAMP"

  echo "> Source changed - building (this can take a few minutes)..."
  start_ticker
  npm run build 2>&1 | tee "$LOG"
  build_status=${pipestatus[1]}   # zsh pipestatus is 1-indexed, unlike bash's PIPESTATUS[0]
  stop_ticker

  if [[ "$build_status" -ne 0 ]]; then
    fail "Build failed (npm run build exited $build_status)."
  fi

  # Only record success after a clean build exit - this is what makes the
  # sentinel trustworthy for the staleness check above.
  print -r -- "$manifest" > "$STAMP"
  notify "Infinite Canvas rebuilt." "Glass"
else
  echo "> Up to date - launching."
fi

# Final pre-launch gate, independent of whether we just built: never launch
# a bundle whose signature doesn't verify.
if ! verify_app; then
  fail "Built app failed integrity verification (codesign --verify failed) - not launching."
fi

# A stale process is only acted on after both the rebuild and this independent
# final signature gate succeeded. On an unchanged launch stale_pid is empty,
# so an already-running current app is simply activated as before.
if ! quit_stale_prebuild_instance; then
  fail "The previous Infinite Canvas instance (pid $stale_pid) did not quit within ${STALE_QUIT_TIMEOUT_SECONDS}s. It may be waiting for a save confirmation. Finish or cancel that save, quit Infinite Canvas with Cmd-Q, then launch again. The rebuilt app was not opened."
fi

open "$RELEASE_APP" || fail "open(1) refused to launch the app."

# open(1) only confirms LaunchServices accepted the request, not that the
# app actually started - poll for the real process instead of trusting it.
launched=0
attempt=0
while (( attempt < 20 )); do
  if pgrep -f "$APP_PROC_PATTERN" >/dev/null 2>&1; then
    launched=1
    break
  fi
  sleep 0.5
  attempt=$((attempt + 1))
done

if [[ "$launched" -ne 1 ]]; then
  fail "App did not start within 10 seconds of open (LaunchServices accepted the request but the process never appeared)."
fi

echo "> Infinite Canvas is running."
