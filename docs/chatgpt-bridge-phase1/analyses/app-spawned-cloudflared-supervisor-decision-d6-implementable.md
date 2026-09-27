# App-spawned cloudflared supervisor (decision D6): implementable specification

The bridge needs a tunnel supervisor inside Electron main that finds, verifies, configures, spawns, health-checks, restarts and reaps cloudflared. The design is a set of DI modules under electron/ipc/handoffBridge/tunnel/. It uses an app-owned generated config (never the user's ~/.cloudflared/config.yml) that is checked offline by the real binary (`ingress validate` and `ingress rule`, both run and verified today). Its spawn contract is fixed: no shell, whitelisted env, no secret in argv, no debug logging. Binary trust is a SHA-256 pin approved through a native dialog, because the Homebrew binary is ad-hoc signed with no Team ID (verified), so a Team-ID check is not feasible there. Orphans are handled by a pidfile plus a `ps` command-line scan (PID-reuse safe) at launch and before every start, and by stop hooks inside the existing quit Promise.allSettled, since app.exit(0) skips will-quit and no will-quit handler exists. Not done yet: no bridge code exists in the repo (electron/ipc/handoffBridge/ is absent), so no production plugin can run until Phase 1 is built. The run-time facts I could not exercise without the network (/ready shape, log strings, edge status codes, SIGTERM behaviour) are tagged provisional and each has a manual check.

## Verified facts

- There are no CLAUDE.md or AGENTS.md files anywhere in the repo (find, excluding node_modules). Conventions were taken from MEMORY.md, the code and the test runner. .claude/settings.json only holds a design-system PostToolUse hook.
- No bridge code exists yet: /Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/ is absent, and no cloudflared/tunnel reference exists in electron/, src/, scripts/*.js/mjs/command or package.json outside scripts/chatgpt-handoff-spike/. git status is clean at cbec68f.
- Platform is macOS Apple Silicon only: package.json:23-26 (`mac.target: dir`, identity 'AI Chalkboard Local Code Signing', forceCodeSigning), scripts/launch-app.command:17 (release/mac-arm64/infinite-canvas.app), and `codesign -dv` on that app reports 'Mach-O thin (arm64)'. No win/linux build config exists. CI is ubuntu-latest on Node 22 (.github/workflows/ci.yml), so unit tests must also run on Linux.
- The app is launched with `open "$RELEASE_APP"` (scripts/launch-app.command:305), so it gets LaunchServices' environment, not the shell's; nvm is sourced only inside the launcher script (:230-233). PATH lookup for cloudflared is therefore unreliable, and the Homebrew arm64 location is used instead: /opt/homebrew/bin/cloudflared is a symlink to /opt/homebrew/Cellar/cloudflared/2026.9.3/bin/cloudflared (`ls -la`, 2026-09-26).
- `codesign -dv --verbose=4` on the app: Authority=AI Chalkboard Local Code Signing, TeamIdentifier=not set, flags=0x10000(runtime), entitlements allow-jit, allow-unsigned-executable-memory, disable-library-validation. The app has no Apple Team ID, and the hardened runtime does not constrain a child process, so nothing needs signing for the child.
- The installed cloudflared (2026.9.3, built 2026-09-24T15:31:10Z, Mach-O arm64, 26,039,522 bytes, mode 0555 jack:admin): `codesign -dv` reports Signature=adhoc, flags 0x20002(adhoc,linker-signed), TeamIdentifier=not set. `codesign --verify --strict` exits 0 ('valid on disk'). `xattr -p com.apple.quarantine` exits 1 (absent). SHA-256 is 8b8d3c28859fc4383cc87497f581049cf9f77d3a7de16564d159fe75b2c9429b. So a code-signature Team-ID check is NOT feasible for the Homebrew build; only a hash pin plus path checks is possible.
- Directory permissions on the binary's chain: /opt/homebrew jack:admin 0755, /opt/homebrew/Cellar and /opt/homebrew/bin jack:admin 0775 (group-writable by admin, gid 80 per `dscl`), Cellar/cloudflared/2026.9.3 0755. A 'not group/world writable' rule must allow gid 80 or it would reject every Homebrew install.
- ~/.cloudflared is 0700 and holds the lab credentials JSON (mode 0400, 175 bytes, not opened) and config.yml (0600). The config has tunnel: 88bf3f23-dfa9-4a0c-8850-4257fa8e9778, credentials-file, ingress bridge-lab.lullascape.com -> http://127.0.0.1:8787, then http_status:404. There is no cert.pem, so it was deleted as the progress log says.
- cloudflared 2026.9.3 offline behaviour, run in a scratchpad copy with `env -i HOME=... PATH=/usr/bin:/bin`: `tunnel --config C --no-autoupdate --loglevel info --metrics 127.0.0.1:51234 --grace-period 2s --label infinite-canvas --management-diagnostics=false ingress validate` prints 'Validating rules from <C>' then 'OK', exit 0. So every planned tunnel-level flag is accepted before a subcommand, including a config path containing a space and a double-quoted credentials-file path with spaces. An unknown flag is rejected ('flag provided but not defined: -bogus-flag').
- `ingress validate` fails (exit 1) when the last rule is not a catch-all, but an unknown key inside originRequest yields only a 'Warning: unused keys detected' with EXIT 0. So an exit-code check alone is not enough. The supervisor must require the exact two-line output. `ingress rule <URL>` prints 'Using rules from <path>', 'Matched rule #N' and the rule's fields; https://bridge.lullascape.com/mcp matched rule #0 (hostname + service http://127.0.0.1:43193) and https://other.example.com/mcp matched rule #1 (service: http_status:404).
- cloudflared's own help text (2026.9.3) shows: many flags are also read from TUNNEL_* environment variables (TUNNEL_TOKEN, TUNNEL_URL, TUNNEL_ORIGIN_CERT, TUNNEL_CRED_CONTENTS, TUNNEL_LOGFILE, TUNNEL_HOSTNAME, NO_AUTOUPDATE...), so an inherited environment can silently override an argv. `--token` and `--credentials-contents` carry secrets in argv/env. `--loglevel debug` logs request URLs and all headers (which would include OAuth codes and bearer tokens). `--pidfile` is written only after the first successful connection. `--grace-period` (default 30s) is how long SIGTERM waits for in-flight requests, and a second SIGTERM ends the wait. `--metrics` defaults to a localhost address that tries 20241-20245. `tunnel ready` exists and calls the local /ready endpoint. `--http-host-header` is documented as an originRequest property.
- Quit path (electron/main.js): before-quit calls preventDefault (:1273); the cleanup is `await closeAllAuthWindows(); await Promise.allSettled([closeAllPages(), closeStealthBrowser(true), stopApplicationSyncServer()])` (:1360-1365), raced against a 25 s timeout (:1377), and ends with app.exit(0) (:1385). A grep finds no will-quit handler anywhere in electron/. `process.on('uncaughtException')` only logs and does not exit (:215-218). Single-instance lock at :246 with `if (!gotTheLock) app.quit()` at :889-891, so a second launch never reaches whenReady. registerNonApiAiHandlers() is at :1178 and createWindow({mode:'auto'}) at :1203, matching the design doc's hunk anchors.
- No powerMonitor or powerSaveBlocker is used anywhere in electron/ or src/ (grep). The unit-test electron stub (scripts/test-stubs/electron.mjs:34-141) exports only app (isPackaged false), ipcMain, dialog (showMessageBox resolves {response:0}), shell, BrowserWindow, BrowserView, protocol, Menu, nativeImage, contextBridge, ipcRenderer and safeStorage. It has no clipboard, powerMonitor or net, so all of those must be injected. scripts/test-stubs/register.mjs:16 replaces globalThis.fetch with a throwing guard in the unit runner.
- The design doc's 'no deterministic test binds a port or spawns a process' is a convention, not an absolute: scripts/tests/job-api-probe.js:243 spawns `process.execPath` with spawnSync inside npm test. Test files must be registered in scripts/test-runner.js (validateTestRegistry throws on unregistered or duplicate files or test names).
- scripts/launch-app.command detects the running app with `pgrep -f "infinite-canvas.app/Contents/MacOS/infinite-canvas"` (:36, :260, :312). Any helper started from the app's own executable (an ELECTRON_RUN_AS_NODE guardian) would match that pattern and confuse the launcher's stale-instance and start-up logic, which is why a guardian process is rejected.
- `/bin/ps -axww -o pid=,ppid=,pgid=,lstart=,command=` works on this Mac (macOS 27.0 / arm64). It prints full untruncated commands including spaces, and lstart looks like 'Sat Sep 26 18:24:14 2026'. /bin/ps is setuid root; launchd is pid 1, so orphans reparent to ppid 1. uid 501, admin gid 80.
- userData is /Users/jack/Library/Application Support/infinite-canvas (the path contains a space), so the config path on a command line contains a space and the orphan matcher must use substring matching, not argv tokenising. app.getPath('userData') throws before whenReady (see the note at electron/ipc/bugReport/reportFile.js:41).
- Tunnelled requests reach the origin from the loopback TCP peer but carry cf-connecting-ip: the lab server records `cf-connecting-ip ?? x-forwarded-for ?? socket.remoteAddress` (scripts/chatgpt-handoff-spike/server.js:385), and the local spike-log.jsonl holds only non-loopback addresses for tunnelled traffic (302 from one Azure-range prefix and 30 from Jack's ISP). Per-source rate keys in the real bridge must therefore use CF-Connecting-IP, not the socket address.
- The lab's protected-resource metadata is served at both /.well-known/oauth-protected-resource and /.well-known/oauth-protected-resource/mcp and is {resource: issuer+resourcePath, authorization_servers:[issuer], ...} (scripts/chatgpt-handoff-spike/oauth.js:1106-1107, :1149-1150). ChatGPT itself fetched the /mcp-suffixed path (RESULTS.md:150). That is the natural public health-probe target, with expected resource 'https://<host>/mcp'.
- Existing reusable helpers: ensureDirectoryWithinRoot(root, target, {mode:0o700}) and atomicWriteJson(target, data, {mode:0o600}) in electron/utils/pathSafety.js:49 and :106 (JSON only, so the YAML config needs a small text twin), and closeOwnedBrowserProcess in electron/ipc/stealthBrowser.js:340-367, whose graceful -> SIGTERM -> SIGKILL with bounded waits is the house pattern for owned child processes. The existing native file chooser pattern with an E2E guard is at main.js:734-743.
- The smoke test asserts the ABSENCE of specific Settings labels (scripts/electron-smoke.js:1114 and :1124: 'Browse…', 'Check availability', 'Local AI', 'Gemini API', 'Local AI Handoff', ...). New UI must use 'Choose file…' and avoid those strings. The smoke launches unpackaged with INFINITE_CANVAS_E2E=1 and INFINITE_CANVAS_E2E_BACKGROUND=1 (:30-31, :241), so the packaged-only and E2E gates keep the tunnel inert there.
- Doc drift inside docs/: chatgpt-bridge-hostname-runbook.md section 4 describes a dashboard-created tunnel run with `cloudflared tunnel run --token <TOKEN>`, but the same runbook's sibling docs/chatgpt-bridge-hostname-chrome-prompts.md progress log records that the tunnel was actually created from the CLI (locally-managed, credentials JSON, cert.pem deleted). The app-supervised design uses the credentials-file form, so runbook section 4 does not apply.

## Design claims that no longer hold

- Design doc section 2 'SETTLED BY ME' item 2 ('No relay, no app-spawned tunnel...') and section 8 ('The app never spawns, supervises, configures or holds credentials for cloudflared') are superseded by D6. The app now spawns cloudflared, writes its config, and holds the PATH (never the contents) of the tunnel credentials JSON. It reads that file only for a bounded validation of its TunnelID.
- Section 5 topology ('cloudflared (Jack-run launchd agent...)'), section 8 ('Run cloudflared as a per-login launchd agent (`cloudflared service install`)') and D6's recommended option are replaced by an app-owned supervised child. The 'prefer a unix-socket origin' note is unmeasured: E9 was never run (RESULTS.md lists it neither as run nor as done), so the default stays TCP 127.0.0.1.
- Section 9 KILL ('A Force Quit or crash leaves no listener (the app spawns no process and holds no port after death)'), section 10 T1 ('Because the app spawns nothing, S2-type guarantees hold after a crash or force-quit (no orphan tunnel)') and section 13 ('S1/S2 false after crash/force-quit... the app spawns nothing') no longer hold. macOS has no parent-death signal, and a SIGKILL/Force Quit skips every JS hook (app.exit(0) also skips will-quit). cloudflared can outlive the app until the next launch's reap. Harm: it forwards to a closed port, and if a second connector for the same tunnel starts it splits requests and produces intermittent 502s. Replacement controls are the pidfile + ps reap, stop hooks in the quit allSettled, and a periodic untracked-child audit.
- Section 14 item 2 gave five reasons to reject an app-spawned tunnel. Each now has an answer: orphan (reap + quit hook), cert.pem/credentials (cert.pem is never read or referenced, and credentials are passed as a validated file path), YAML injection (app-owned config from validated primitives, verified by the real binary's ingress validate/rule), GUI PATH (absolute candidates + native chooser, PATH never consulted), inherited process.env secrets (env whitelist of PATH/HOME/TMPDIR), and 'a binary to trust or sign under the pinned identity' (nothing needs signing: the child is independent of the app's hardened runtime; trust is a SHA-256 pin, because Team-ID verification is impossible for the ad-hoc-signed Homebrew build).
- The runbook rule 'no --token in launchd argv' generalises to 'no secret in argv or env' for an app-spawned child: `ps` shows every user's argv on macOS (/bin/ps is setuid). The app passes only a config path and a tunnel UUID, never --token, --credentials-contents or TUNNEL_TOKEN.
- Section 5/9/10 (listener bound ONLY while a session or pairing window is open; session ends after 10 minutes unreachable; 'suspend' ends the session; tunnel health probe only 'while a session is live with an outstanding handoff') were written for armed sessions. D5 removes the session, so the tunnel is now up whenever the bridge is enabled and the app is open. The health probe runs continuously (every 60 s), 'unreachable' produces a visible degraded state instead of ending a session, and suspend does not stop the tunnel (a sleeping Mac is unreachable anyway; on resume the supervisor re-probes and restarts only if needed).
- Section 9 'TUNNEL HEALTH: probe the public URL every 60 s' and section 5 'self-probe the public /.well-known/oauth-protected-resource' understate what a useful probe must do. Because Cloudflare load-balances connectors of one tunnel, a bare 'reachable' check can succeed against a stale orphan. The probe must validate the JSON `resource` equals https://<host>/mcp, and orphan removal cannot rely on probing.
- The design doc's test rule ('no deterministic test binds a port or spawns a process (applicationSync convention)') is stricter than the repo actually is (scripts/tests/job-api-probe.js:243 spawns a process in npm test). This spec keeps port-binding tests out of npm test but proposes one registered, port-free, real-spawn fake-binary test group with that precedent.
- Design section 17 line about 'the tunnel credential on the Mac' and D2/D6 text assume the credential is held by a launchd agent. In the app-spawned model the same file is read by a child the app starts, but the file, its mode (0400) and its blast radius (can only run that one tunnel) are unchanged. The trust-root risk T10 is not reduced or increased by D6 except for the new binary-swap surface, which the SHA-256 pin addresses.
- Runbook docs/chatgpt-bridge-hostname-runbook.md section 4 (dashboard tunnel token, `cloudflared tunnel run --token`) is stale relative to what was built (CLI-created locally-managed tunnel with a credentials JSON, per docs/chatgpt-bridge-hostname-chrome-prompts.md progress log). The app supervisor supports only locally-managed tunnels with credentials JSON.

## Specification

# App-spawned cloudflared supervisor (decision D6): implementable specification

Status: specification only; nothing is built and nothing was written to the repo. Scope: the packaged macOS (Apple Silicon) app, Electron main process. Evidence tags: **[V]** verified on this Mac on 2026-09-26 with read-only or offline commands (cloudflared checks ran with `env -i`, only against scratchpad files, no network); **[R]** read in repo code (file:line); **[P]** provisional: cloudflared or macOS run-time behaviour I could not exercise without the network or the app, each closed by a manual check M# in section 13; **[D]** decision made by this spec.

---

## 0. Shape of the answer

A supervisor with dependency injection, in `electron/ipc/handoffBridge/tunnel/`, owned by the bridge controller. It does five jobs. (1) Find and verify one cloudflared binary. (2) Generate an app-owned config from validated primitives and have the real binary check it offline. (3) Spawn it with a fixed argv, a whitelisted environment, no shell and its own process group. (4) Track its health locally (`/ready`) and end to end (public hostname), restart with backoff, stop it on disable and quit. (5) Reap orphans left by a crash or Force Quit before every start and at launch. It never reads the user's `~/.cloudflared/config.yml`, never puts a secret in argv, env, logs, IPC or status, and only ever runs while the bridge listener owns the local port.

Answer to "read the user's config vs write an app-owned one" **[D]**: write an app-owned config in userData. Reasons: cloudflared's config file can carry more than tunnel/credentials/ingress (flag-named settings, extra ingress rules, private-network routing **[P: cloudflared docs, not re-verified]**), and unknown keys are only a *warning* with exit 0 **[V]**, so whatever is in the user's file would silently take effect. The user's lab file also points at port 8787 **[V]**. The user's file is never opened by the app.

---

## 1. Invariants (the contract the rest of the bridge can rely on)

| # | Invariant |
|---|---|
| I-1 | A cloudflared child exists only while the bridge listener is bound to `127.0.0.1:<port>` **and** a self-probe of that local listener returned the expected protected-resource document. Listener close/error stops the tunnel first (`await tunnel.stop('listener-closed')`), then releases the port. A foreign process squatting the port therefore never receives public traffic. |
| I-2 | At most one app-owned cloudflared per userData. Every start runs `reapOrphans('start')` first. Only this supervisor spawns; `child_process` is imported in exactly one file (`tunnel/exec.js`). |
| I-3 | Every argv element is either a literal constant or the output of a validator in `validate.js`. No argv element from data starts with `-`. No shell. Env is the whitelist `PATH`, `HOME`, `TMPDIR`. |
| I-4 | No secret in argv, env, logs, IPC, status snapshots or bug reports. Forbidden forever: `--token`, `--credentials-contents`, `TUNNEL_TOKEN`, `--loglevel debug/trace`, `--logfile`, `--pidfile`, `--origincert`, `--url`, `--hello-world`, `--unix-socket`. |
| I-5 | The binary is hashed and compared to the approved pin immediately before every spawn (initial start and every restart). |
| I-6 | No path or command line ever comes from the renderer. The renderer can only trigger actions; native dialogs in main choose files and confirm trust. |
| I-7 | Stopping is bounded (worst case 5.5 s) and is wired into the existing quit `Promise.allSettled` (`main.js:1361-1365`). `will-quit` is never relied on (none exists and `app.exit(0)` at :1385 skips it **[P: Electron docs]**). |
| I-8 | Refused (state `blocked`) when: `process.platform !== 'darwin' \|\| process.arch !== 'arm64'`; `INFINITE_CANVAS_E2E === '1'` or `isBackgroundE2E()`; not `app.isPackaged` unless `INFINITE_CANVAS_HANDOFF_BRIDGE_DEV === '1'`; `INFINITE_CANVAS_HANDOFF_BRIDGE === '0'`. |
| I-9 | Public claim `online` requires a 200 whose JSON `resource` equals `https://<host>/mcp`. Anything else is a named degraded code. |
| I-10 | Unit tests never touch the network or bind a port: `fetch`, `spawn`, `execFile`, `fs` clock and timers are injected. |

---

## 2. Modules and dependency injection

Directory `electron/ipc/handoffBridge/tunnel/` (all new, none source-pinned). None of these are in the bridge's pre-auth layer, so the design's "http/mcp/oauth import only node:http/crypto" scan is unaffected; add a scan that http/mcp/oauth/preflight/framing never import `tunnel/`.

| File | Purity | Contents |
|---|---|---|
| `constants.js` | pure | every number, regex, fixed string, the code enum and `MESSAGES[code]` |
| `validate.js` | pure | `validateHostname`, `validateTunnelId`, `validatePort`, `validateAbsolutePath`, `validateTunnelParams` |
| `config.js` | pure | `renderTunnelConfig(params)`, `buildRunArgv(p, opt)`, `buildDryRunArgv(p, opt)`, `buildChildEnv(os)` |
| `redact.js` | pure | `redactLine(line, ctx)` |
| `logRing.js` | pure | `createLogRing({maxLines,maxBytes,maxLine,redact})`, chunk-to-line splitter |
| `classify.js` | pure | `classifyExit(...)`, `classifyProbe(...)` |
| `psParse.js` | pure | `parsePsRows(text)`, `isOwnedCloudflaredCommand(cmd, configPath)`, `isCloudflaredCommand(cmd)` |
| `files.js` | fs (injected) | `ensureTunnelDir`, `writeFileAtomic0600` (text twin of pathSafety.js:106), `readJsonBounded`, mode/owner checks |
| `binary.js` | fs+exec (injected) | `discoverCandidates`, `inspectBinary`, `decideTrust` |
| `credentials.js` | fs (injected) | `inspectCredentials` |
| `exec.js` | **only** importer of `node:child_process` | `spawnCloudflared`, `execFixed` |
| `reap.js` | | pidfile + ps scan + kill sequence |
| `probe.js` | injected fetch | `probeLocalReady`, `probePublic`, `pickFreePort` (uses node:net) |
| `supervisor.js` | injected everything | state machine |
| `index.js` | wiring | `createRealTunnelSupervisor(ctx)` binds real fs/child_process/fetch/timers |

`createTunnelSupervisor(deps)`, deps: `paths {dir, configPath, pidPath, settingsPath, logPath}` (absolute, derived from `app.getPath('userData')` after ready), `getParams() -> {hostname, localPort, listenerBound}`, `fs`, `spawn`, `execFile`, `fetch`, `now`, `timers {setTimeout, clearTimeout}`, `random`, `os {homedir, tmpdir, uid, gid, platform, arch}`, `processApi {pid, kill}`, `confirmTrust(info) -> Promise<boolean>` (native dialog owned by main), `isOnline()`, `log(code, fields?)` (bridge private logger, enumerated codes only), `onStatus(snapshot)`, `env {INFINITE_CANVAS_E2E, INFINITE_CANVAS_E2E_BACKGROUND, INFINITE_CANVAS_HANDOFF_BRIDGE, INFINITE_CANVAS_HANDOFF_BRIDGE_DEV}`, `isPackaged`.
Returns `{ start(), stop(reason), pause(), resume(), restart(), getStatus(), trustBinary(), setBinaryPath(p), setCredentialsFile(p), reapOrphans(reason), copyLog(), getDiagnostics(), killNowSync(), dispose() }`. Every method returns a promise of `{ok, code}` and **never throws**. Lifecycle operations run through one serial queue; each start increments a `generation`, and every async continuation aborts if its generation is stale.

State directory `TUNNEL_DIR = <userData>/handoff-bridge/tunnel/` created with `ensureDirectoryWithinRoot(userData, TUNNEL_DIR, {mode:0o700})` (`pathSafety.js:49`, refuses symlink components). On every start `lstat` it: must be a real directory, `uid === process.getuid()`, `(mode & 0o077) === 0` (one `chmod 0700` attempt, else `state-dir-unsafe`).

| File | Mode | Content |
|---|---|---|
| `config.yml` | 0600 | generated, section 5 |
| `tunnel.pid.json` | 0600 | pidfile, section 9 |
| `tunnel.json` | 0600 | `{v:1, binaryPath: string\|null, credentialsFile: string\|null, trust: {realPath, sha256, sizeBytes, version, sign:{kind,teamId\|null}, trustedAt}\|null}`; unknown `v` is treated as empty |
| `cloudflared.log`, `.log.1` | 0600 | redacted lines only, rotate at 262,144 bytes, keep one |

Nothing goes in electron-store (`get-settings` returns the whole store to the renderer, settings.js:186-190) or in node data.

---

## 3. Constants (all in `constants.js`; provisional values are tuned by M5/M7)

| Name | Value | Basis |
|---|---|---|
| `DEFAULT_LISTENER_PORT` (owned by the bridge) | 43193; 43192 is reserved (applicationSync.js:31) | design section 5 |
| `PUBLIC_PROBE_PATH` | `/.well-known/oauth-protected-resource/mcp` | RESULTS.md:150 |
| `PUBLIC_PROBE_INTERVAL_MS` | 60,000 steady; 5,000 for the first 30 s after `ready-local`; 15,000 after a failure | design section 9 (60 s) |
| `PUBLIC_PROBE_TIMEOUT_MS` / body cap | 8,000 / 16,384 bytes | [D] |
| `LOCAL_READY_POLL_MS` | 1,000 while connecting; 30,000 steady | [D] |
| `START_READY_TIMEOUT_MS` | 60,000 | [D], M5 |
| `EXEC_TIMEOUT_MS` (version, ps, codesign, xattr, dry-run) | 5,000 each | [D] |
| `STOP_TERM1_MS`, `STOP_TERM2_MS`, `STOP_KILL_MS` | 1,500, 2,500, 1,500 (worst case 5,500) | `--grace-period 2s`; quit race is 25 s (main.js:1377) |
| `EARLY_EXIT_MS` | 5,000 | [D] |
| `BACKOFF_MS` | [1000, 2000, 4000, 8000, 16000, 30000], jitter x(0.8 + 0.4*random) | [D] |
| `BACKOFF_RESET_AFTER_MS` | 120,000 continuously `ready` | [D] |
| `CRASH_LOOP_MAX / WINDOW_MS` | 5 unexpected exits / 600,000 | [D] |
| `PROBE_RESTART_MIN_INTERVAL_MS` | 600,000 (at most one probe-triggered restart per 10 min) | [D] |
| `MANUAL_RESTART_MIN_INTERVAL_MS` | 5,000 (a compromised renderer cannot loop restarts) | [D] |
| `LOG_RING_LINES / BYTES / LINE_MAX` | 400 / 131,072 / 1,024 | [D] |
| `BINARY_MIN_BYTES / MAX_BYTES` | 5,242,880 / 268,435,456 (observed 26,039,522) | [V] |
| `CRED_MAX_BYTES` | 4,096 (observed 175) | [V] |
| `AUDIT_EVERY_N_PROBES` | 10 (untracked-own-child audit, about every 10 min) | [D] |
| `BINARY_STALE_DAYS` (advisory notice only) | 180 | autoupdate is disabled, so binaries age |

---

## 4. Finding and verifying the binary

### 4.1 Discovery **[D]**
Candidates in this order; PATH is never read, and no login shell, `which` or `command -v` is executed:
1. `tunnel.json.binaryPath` if set (chosen through a native `dialog.showOpenDialog` in main). If set but unusable: fail loudly with `binary-not-found`; do not fall through silently to a different binary.
2. `/opt/homebrew/bin/cloudflared`
3. `/usr/local/bin/cloudflared` (only reachable by a manual Intel-style install; cheap to include)
No match: `binary-not-found` with the searched locations in the message. (Bundling a binary in Resources is a possible later option; rejected now: +26 MB, manual updates, and a nested Mach-O for the deep-codesign gate in scripts/build-macos.mjs.)

### 4.2 Inspection `inspectBinary(candidate)` (returns `{ok, code, info}`), in order
1. `realpath` -> `real`. Spawn `real`, never the symlink (closes the symlink-swap TOCTOU between check and exec).
2. `stat(real)`: regular file; owner exec bit set; `BINARY_MIN_BYTES <= size <= BINARY_MAX_BYTES`; `uid` is 0 or `getuid()`; `(mode & 0o022) === 0`.
3. Ancestors of `real` up to `/`: each directory `uid` is 0 or `getuid()`; not world-writable (unless sticky); group-writable **only if gid is 80 (admin)** [V: Homebrew's Cellar is jack:admin 0775]. Violation: `binary-unsafe-path`.
4. Quarantine: `/usr/bin/xattr -p com.apple.quarantine real`. Exit 0 = present -> `binary-quarantined` (message tells the user the exact `xattr -d` command to run after inspecting the file). Exit 1 with "No such xattr" = absent [V]. Any other failure: treat as unknown, log code, continue.
5. Signature: `/usr/bin/codesign -dv --verbose=4 real` (parse stderr) into `sign.kind`: `adhoc` (`Signature=adhoc`) [V for Homebrew], `developer-id` (an `Authority=Developer ID Application` line and a `TeamIdentifier=<10 chars>`), `other-signed`, `unsigned` (exit 1, "not signed at all"). Then `/usr/bin/codesign --verify --strict real` must exit 0 for every signed kind [V for adhoc], else `binary-signature-invalid`. `adhoc` passing proves only internal consistency, not authenticity.
6. SHA-256 by streaming the file.
7. `real --version` (env whitelist, cwd `TUNNEL_DIR`, 5 s, `maxBuffer` 16 KiB) parsed with `/^cloudflared version (\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9A-Za-z.]{1,20})?)(?: \(built ([0-9TZ:.-]{10,32})\))?\s*$/` [V output: `cloudflared version 2026.9.3 (built 2026-09-24T15:31:10Z)`]. No match: `binary-unrecognized`. Built date older than 180 days: advisory notice `binary-old`, not a block. Running `--version` before trust is accepted because the file already passed steps 1-6 and is at Homebrew's prefix or was chosen by the user; nothing else runs before trust.

### 4.3 Trust pin `decideTrust(info, pin)` **[D]**
A Team-ID check is infeasible for the installed build [V]. The enforced control is a SHA-256 pin approved by the user in a native dialog.

| Condition | Result |
|---|---|
| no pin | `binary-untrusted` -> native review dialog |
| `pin.sha256 === info.sha256` | ok |
| hash differs, pin and current are both `developer-id`, `teamId` equal, and `codesign --verify --strict -R='anchor apple generic and certificate leaf[subject.OU] = "<TEAM>"'` exits 0 | auto-accept and update pin (Tier A). **[P]** unexercised here: no Developer-ID cloudflared is installed; if Cloudflare's own release binaries turn out to be ad-hoc too, delete this row |
| anything else (Homebrew `brew upgrade` lands here) | `binary-changed` -> native dialog showing old and new version + hash |

Native dialog (main-owned, `dialog.showMessageBox`, buttons `['Cancel','Trust and use this cloudflared']`, default and cancelId 0). Detail lists: path, version, size, full SHA-256, signature summary ("Ad hoc signature, no team identifier" / "Developer ID ... Team X" / "Not signed"), and one sentence: "Homebrew builds are ad hoc signed, so Infinite Canvas remembers this file's hash and asks again when it changes." The approval is stored in `tunnel.json.trust`. `brew pin cloudflared` avoids re-prompts between deliberate upgrades. A same-UID attacker can edit `tunnel.json`; this pin gives change-detection and accident protection, not protection from code already running as Jack (documented residual).

### 4.4 Credentials `inspectCredentials(path)`
Chosen by a native file dialog (`defaultPath ~/.cloudflared`, filter `json`), then: `realpath`; basename matches `^<uuid>\.json$` (uuid lower-case, `TUNNEL_UUID_RE`); regular file; `uid === getuid()`; `(mode & 0o077) === 0` (0400 or 0600 [V for the lab file]); size 64..4096; path chars only `[A-Za-z0-9 _.@+=,()~/-]` (spaces allowed; quotes, backslash, `#`, `:`, `$`, control chars, U+2028/9 rejected -> `credentials-unsafe`); read, `JSON.parse` in try/catch, require `TunnelID` (string) equal to the filename UUID and a non-empty `TunnelSecret` string, then discard the object (never logged, never in IPC). Codes: `no-credentials`, `credentials-missing`, `credentials-unsafe`, `credentials-invalid`. Keep credentials out of Desktop/Documents/Downloads (TCC would prompt for the app); advisory only.

---

## 5. Tunnel configuration (app-owned, verified offline by the real binary)

### 5.1 Inputs and validators
| Field | Source | Validator |
|---|---|---|
| tunnel id | credentials filename, cross-checked with JSON `TunnelID` | lower-case `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` |
| credentials path | section 4.4 result (a realpath) | absolute; <=1024 chars; charset above |
| hostname | bridge `publicBase` host (never a second setting) | lower-cased; `^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63}$` (>= 3 labels, not an IP literal, no port, no wildcard, no trailing dot) |
| local port | bridge listener | integer 1024..65535, not 43192, not equal to the metrics port |
| metrics port | `pickFreePort()` on 127.0.0.1 (bind 0, read, close); retried up to 3 times on `metrics-port-in-use` | integer 1024..65535 |
Any failure throws before any file is written: `bad-hostname`, `bad-port`, `credentials-unsafe`.

### 5.2 Generated file (byte-exact golden; the only place values are interpolated)
```
# Generated by Infinite Canvas. Do not edit: overwritten on every start.
tunnel: <UUID>
credentials-file: <JSON.stringify(credentialsPath)>
ingress:
  - hostname: <HOSTNAME>
    service: http://127.0.0.1:<PORT>
    originRequest:
      httpHostHeader: <HOSTNAME>
      connectTimeout: 5s
  - service: http_status:404
```
`httpHostHeader` pins the Host header to the public hostname so the listener's Host check (design section 5) is deterministic, independent of unverified default forwarding behaviour. This exact file with a placeholder UUID and quoted spaced path validates and routes correctly on 2026.9.3 [V]. No other top-level keys are ever emitted (no `warp-routing`, `logfile`, `pidfile`, `metrics`, `url`).

Write: `writeFileAtomic0600` (temp + rename in `TUNNEL_DIR`, mode 0600, refuse if the target is a directory), re-read and compare bytes to the rendered string.

### 5.3 Effective-config dry run (offline, real binary) **[V mechanism]**
After writing and before spawning, run three calls with the same env/cwd (fixed args, 5 s timeouts):
1. `<real> tunnel <flags as in the run argv> ingress validate`. Output must be exactly `Validating rules from <configPath>` then `OK`, exit 0. Anything else, including a `Warning: unused keys detected` block (exit 0 [V]), fails with `config-rejected`. If stderr says `flag provided but not defined: -X` and X is an OPTIONAL flag, drop that flag from the argv and retry (max 3); if X is required: `binary-flag-unsupported`.
2. `<real> tunnel --config <C> --no-autoupdate ingress rule https://<HOST>/mcp` must report `Matched rule #0` with `hostname: <HOST>` and `service: http://127.0.0.1:<PORT>` and nothing else besides the `Using rules from <C>` header.
3. `... ingress rule https://not-the-bridge.invalid/` must report `Matched rule #1` with only `service: http_status:404`.
This proves the config does what the app intended, whatever the YAML contained.

---

## 6. Spawn contract

```
argv = ['tunnel',
  '--config', CONFIG_PATH,
  '--no-autoupdate',
  '--loglevel', 'info',
  '--metrics', '127.0.0.1:' + metricsPort,
  '--grace-period', '2s',              // optional (dropped if the binary rejects it)
  '--label', 'infinite-canvas',        // optional
  '--management-diagnostics=false',    // optional
  'run', TUNNEL_UUID]
spawn(real, argv, { shell:false, cwd:TUNNEL_DIR, env: childEnv, detached:true,
                    stdio:['ignore','pipe','pipe'], windowsHide:true })
```
All flags accepted by 2026.9.3 [V offline]. `env = { PATH:'/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), TMPDIR: os.tmpdir() }` and nothing else, so an inherited `TUNNEL_*`/`NO_AUTOUPDATE` cannot override argv [V help text] and no app secret leaks into the child. Env does not stop a malicious binary (same UID); it prevents accidental override and leakage. `detached:true` makes the child a session/process-group leader (`pgid === pid`) so the group can be signalled. No `argv0` override (so `ps` shows the real path). `--no-autoupdate` is mandatory: an auto-updater would swap the pinned binary and restart it. The dry-run argv is the same list with `['ingress','validate']` instead of `['run', UUID]`. If `~/.cloudflared/cert.pem` exists, show notice `cert-present` (harmless to the run, but it is a broad credential the app does not need).

After the `spawn` event: fetch the child's lstart and pgid with `ps` and require `pgid === pid`. Group signalling (`process.kill(-pid, sig)`) is used only when that holds; otherwise `child.kill(sig)`. Code invariant, unit tested: the only negative number ever passed to `process.kill` is `-child.pid` with `child.pid > 1 && child.pid !== process.pid`.

`exec.js` exports exactly two functions; a source-scan test asserts: `child_process` is imported only there, `spawn(` appears once, no `shell: true`, no `exec(`/`execSync`/`spawnSync`, no `--token`, `credentials-contents`, `TUNNEL_TOKEN`, no loglevel other than `'info'`.

---

## 7. Output capture and redaction

stdout and stderr are both consumed (backpressure would otherwise stall the child). A splitter handles partial chunks and CRLF, truncates each line to 1,024 chars (drops the rest of an overlong line), strips ANSI and control characters, then redacts **before storage anywhere**. Ring buffer: newest 400 lines / 131,072 bytes. The redacted line is also appended to `cloudflared.log` (0600, rotated at 262,144 bytes; a write error disables file logging silently).

`redactLine` rules, in order: home dir -> `~`, userData -> `<userData>`; JWT/base64-JSON-looking tokens `\beyJ[A-Za-z0-9_-]{16,}(\.[A-Za-z0-9_-]+){0,2}` -> `[redacted-token]`; `(secret|token|authorization|bearer|password|key|TunnelSecret|AccountTag)\s*[:=]\s*\S+` -> key kept, value `[redacted]`; any opaque run `[A-Za-z0-9+/_-]{40,}={0,2}` -> `[redacted-blob]`; UUIDs -> first 8 hex + `-...`; the configured hostname -> `<host>`; query strings `\?\S+` -> `?...`. Redaction is pattern-based and can miss an unknown secret format. That is why: level is `info` (cloudflared's own help says only debug logs request URLs and headers), raw lines never enter `logger`/bug reports, and export is user-gesture only (`copyLog()` puts the redacted ring on the clipboard from main). The supervisor logs only enumerated codes through the bridge's private logger (design T7); it never calls `logger.*` with cloudflared output, paths, hostnames, UUIDs or hashes.

Exit classification input is the last 30 redacted lines: `classifyExit({code, signal, uptimeMs, tail, stopping})`. Patterns are hints **[P: M6 records the real strings]**: auth (`unauthorized|invalid tunnel secret|tunnel not found|authentication failed`) -> `tunnel-auth-rejected` (permanent); credentials-parse (`credentials? file|error (reading|parsing)`) -> `credentials-invalid` (permanent); network (`no such host|network is unreachable|no route to host|i/o timeout|dial tcp`) -> `network-unreachable` (transient); port (`address already in use`) -> `metrics-port-in-use` (retry with a new port); otherwise `exited-early` (uptime < 5 s) or `exited`. `stopping === true` -> `expected` (never restarts).

---

## 8. Lifecycle

### 8.1 States
| State | Meaning | Leaves on |
|---|---|---|
| `off` | not enabled | `start()` |
| `blocked` | gate (I-8) or `listener-not-bound` | conditions change + `start()` |
| `needs-setup` | no credentials chosen | `setCredentialsFile()` |
| `needs-trust` | `binary-untrusted` / `binary-changed` | `trustBinary()` |
| `starting` | preflight, reap, config, dry run, spawn | `connecting` or `failed` |
| `connecting` | process alive, `/ready` not 200 | `checking-public`; timeout -> `degraded(not-ready)`; exit -> exit handler |
| `checking-public` | edge registered, public probe pending | `online` or `degraded` |
| `online` | last public probe ok | 3 consecutive failures -> `degraded`; exit -> exit handler |
| `degraded` | running, with a named code | probe ok -> `online`; exit -> handler |
| `backoff` | waiting to restart | timer -> `starting` |
| `paused` | user paused public access | `resume()` |
| `stopping` | signals sent | `off` / `paused` / `failed(stop-stuck)` |
| `failed` | permanent until user action | `restart()` or the fix action |

### 8.2 Start sequence (`runStart`, serial queue, each step checks `generation`)
1. Gate (I-8); `getParams()` and `validateTunnelParams`; require `listenerBound` (I-1).
2. `ensureTunnelDir` checks.
3. `reapOrphans('start')`; abort with `owned-elsewhere` if a live other owner exists.
4. `inspectCredentials`.
5. `discoverCandidates` -> `inspectBinary` -> `decideTrust` (needs-trust/failed stop here; the native dialog lives behind `trustBinary()`).
6. Pick metrics port; render config; atomic write; re-read compare.
7. Dry run (section 5.3), dropping unsupported optional flags.
8. Re-hash the binary (I-5) and compare with the pin; write the pre-spawn intent record `{v:1, phase:'spawning', ownerPid, ownerStart, at}` to the pidfile.
9. `spawnCloudflared`. On `error` (ENOENT/EACCES/EBADARCH/EPERM) -> `failed(spawn-failed)` with the errno enum in the message. On `spawn`: fetch lstart/pgid via `ps`, write the full pidfile (section 9), attach stream consumers and exit handlers, state `connecting`.
10. Poll `GET http://127.0.0.1:<metricsPort>/ready` each 1 s (`200` = ready **[P: M5]**; `tunnel ready` exists [V], its body/shape is unverified). If `/ready` is 404/refused for 30 s while the process lives, fall back to public-probe-only mode and note `readyEndpoint:'absent'`.
11. On ready -> `checking-public`. Probes: +2 s, then every 5 s; first ok -> `online`; none ok in 30 s -> `degraded` with the classified code.
Total preflight before spawn is bounded by about 10 s of 5 s-capped steps; app startup never waits on it (see section 11 for the 3 s deferral).

### 8.3 Public probe
`GET https://<host><PUBLIC_PROBE_PATH>` with `redirect:'manual'`, `AbortSignal.timeout(8000)`, default TLS verification (never disabled), UA `InfiniteCanvasTunnelProbe/1`, body capped at 16 KiB. Classification (`classifyProbe`); status/code mappings are **[P: M7 confirms each]**:

| Observation | Code | Restarts the tunnel? |
|---|---|---|
| 200, JSON `resource === 'https://<host>/mcp'` | `ok` | n/a |
| 200 but not JSON / other resource | `wrong-origin` (danger colour: something else answers there) | no |
| ENOTFOUND | `dns-not-found` | no |
| `isOnline()` false | `offline` | no |
| ECONNREFUSED / ETIMEDOUT / TLS error | `edge-unreachable` | no |
| HTTP 530 (Cloudflare 1033: no connector) | `tunnel-not-serving` | yes, once per 10 min, only if local `/ready` is ok or the process just restarted |
| HTTP 502/503/504 | `origin-unreachable` (edge reached the tunnel, listener silent) | no; if the listener is gone, I-1 stops the tunnel |
| HTTP 404 without our JSON | `ingress-mismatch` (config hostname is not what DNS routes here) | no |
| HTTP 403/429 with `server: cloudflare` | `edge-blocked` (WAF/bot rule) | no |
| 3xx | `unexpected-redirect` | no |
| anything else / timeout | `unexpected-status` / `probe-timeout` | no |
Three consecutive non-ok -> `degraded(<code>)`; one ok -> `online`. In steady state, if local `/ready` is non-200 for >= 90 s with the process alive and `isOnline()` true -> one restart (same 10 min limiter).

### 8.4 Exit handling and backoff
Unexpected exit (not `stopping`): classify; permanent codes -> `failed`; else count toward `CRASH_LOOP` (network-unreachable exits are not counted) -> 5 in 10 min = `failed(crash-loop)`; otherwise `backoff` with `BACKOFF_MS[min(n-1,5)]*jitter`. Backoff resets after 120 s continuously `ready`. Each restart re-runs the full start sequence including the hash check, so a swapped binary stops the loop with `binary-changed`. cloudflared retries its own edge connections internally, so "alive but not ready" (no network) is a state, not a restart trigger.

### 8.5 Pause / resume
`pause()` = `stop('pause')` into `paused` (listener stays bound locally; the public path is cut immediately). `resume()` = start. Not persisted: a relaunch starts the tunnel if the bridge is enabled. This is the one-click exposure control that replaces the session timers under D5.

### 8.6 Stop and quit
```
stop(reason):                          // idempotent, serial queue, cancels backoff/probes, aborts in-flight execs
  state = stopping
  signalGroup('SIGTERM');  wait exit <= 1500 ms
  if alive: signalGroup('SIGTERM')     // a second SIGTERM ends cloudflared's grace wait [V help text; P: M11]
            wait exit <= 2500 ms
  if alive: signalGroup('SIGKILL');    wait exit <= 1500 ms
  if alive: state = failed(stop-stuck); keep pidfile (next launch reaps)
  else: delete pidfile; child = null
```
Quit ordering, executed inside the design's single `stopHandoffBridge()` entry appended to the quit `Promise.allSettled` (main.js:1361-1365): (1) `tunnel.stop('quit')` first, which cuts the public path at once, in parallel with the engine's refuse-new-RPCs and drain (<= 10 s, design section 9); (2) close the listener; (3) `killNowSync()` registered on `process.on('exit')` as last-chance `SIGKILL` of the group **[P: whether 'exit' fires after app.exit(0) is unverified, M11; the pidfile reap is the real guarantee]**. Worst case tunnel stop is 5.5 s, inside the existing 25 s race. Do not add `process.on('SIGTERM')` handlers (Electron may already convert SIGTERM into a normal quit **[P: M11]**; changing that is out of scope).

### 8.7 Sleep, wake, App Nap
`powerMonitor` is optional-chained (absent in the test stub). On `resume`: `probeNow('resume')` after 5 s; restart only per the 10 min limiter. The tunnel is not stopped on `suspend`. Optional, default OFF, opt-in: `pause while the screen is locked` using `lock-screen`/`unlock-screen`. Risk **[P: M12]**: macOS App Nap can coalesce the supervisor's timers when the app is hidden; if measured, hold `powerSaveBlocker.start('prevent-app-suspension')` while enabled (design Phase 2 item, promoted).

### 8.8 Concurrency
One serial queue for start/stop/restart/pause/resume/exit-handling; `start()` while running returns the current snapshot; `stop()` during `starting` aborts the sequence via `generation` and kills any exec child.

---

## 9. Orphans (crash, SIGKILL, Force Quit)

macOS has no parent-death signal, `app.exit(0)` and SIGKILL skip JS hooks, and cloudflared does not watch its parent, so an orphan is possible. Harm is bounded: it forwards to a dead port, but a second connector for the same tunnel gets a share of requests, so an orphan causes intermittent 502s until it is reaped. Rejected mitigations: an ELECTRON_RUN_AS_NODE guardian (matches the launcher's `pgrep -f` pattern at launch-app.command:36/:260/:312 and breaks its stale-instance logic; adds a process to supervise) and a `perl -e 'alarm ...; exec'` trampoline (deprecated system perl, and `ps` would then show perl as the executable, defeating command-line identification).

### 9.1 Pidfile `tunnel.pid.json` (0600)
`{v:1, childPid, childStart, pgid, exe, configPath, ownerPid, ownerStart, startedAt, metricsPort}`. `childStart`/`ownerStart` are `ps -o lstart=` strings (guard against PID reuse). Written as an intent record before spawn, completed after the `spawn` event. Deleted only after the child is confirmed gone.

### 9.2 Identification (the config path is the marker)
`ps -axww -o pid=,ppid=,pgid=,lstart=,command=` (`/bin/ps`, fixed args, 5 s, 4 MiB buffer) -> rows `{pid, ppid, pgid, lstart, command}` (regex `^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$`). A row is **ours** iff `command.includes(' tunnel --config ' + CONFIG_PATH + ' --no-autoupdate ')` and the text before that marker ends with `/cloudflared`. Substring matching only (the path contains a space), never a regex built from data. The lab tunnel (`cloudflared tunnel run lullascape-bridge-lab`, default config) does not match and is never touched.

### 9.3 `reapOrphans(reason)` (at launch, at every start, and every 10th probe as an audit)
```
rows = ps scan (failure -> return 'reap-unverified', continue with a warning; never blocks start)
for row in rows where isOwned(row):
   if row.pid === child?.pid                           -> skip (ours, live)
   if row.ppid === process.pid                          -> untracked own child: reap
   else if row.ppid === 1                               -> orphan: reap
   else if rows[row.ppid] is alive and looks like another Infinite Canvas process
                                                        -> notice 'owned-elsewhere', do NOT touch
   else                                                 -> notice 'foreign', do NOT touch
 reap(row): re-run `ps -p pid -o lstart=,command=`; must equal the scanned row (PID-reuse guard);
            SIGTERM (group if row.pgid === row.pid, else pid); wait 2 s; SIGTERM again; wait 2 s; SIGKILL; wait 1.5 s;
            success -> notice 'orphan-stopped'; failure -> notice 'orphan-stuck'
pidfile present but no row matches its childPid+childStart -> stale: delete it (never signal by pid alone)
other cloudflared rows that are not ours -> advisory notice 'foreign-connector' (two connectors on one tunnel split traffic); never killed
```
At app launch (after `whenReady`, deferred 3 s, non-blocking) `reapOrphans('launch')` runs whenever a pidfile exists or the bridge is enabled, even if the bridge is then disabled. Under the single-instance lock (main.js:246, :889) only the primary instance reaches this code.

### 9.4 What remains unfixable
Between a SIGKILL of the app and the next launch the orphan runs. It is harmless to secrets (no listener, and I-1 forbids a tunnel to a foreign squatter after a *clean* stop), and the emergency command is in section 12. Verified manually by M4.

---

## 10. What the user sees

All text is fixed in `MESSAGES[code]`; only validated scalars are interpolated (seconds, counts, exit code, signal name, version string matching the regex above, validated hostname, errno enum). Wording states observations, not causes. The renderer never composes text from raw data.

| State / code | Text | Action |
|---|---|---|
| `off` | Tunnel is off. | Enable |
| `blocked/e2e-disabled` | Disabled during automated tests. | none |
| `blocked/dev-build-disabled` | The tunnel runs only in the packaged app. | none |
| `blocked/unsupported-platform` | The tunnel supports Apple Silicon Macs only. | none |
| `blocked/listener-not-bound` | The bridge is not listening locally, so the tunnel was not started. | none |
| `needs-setup/no-credentials` | Choose the tunnel credentials file. | Choose file... |
| `failed/credentials-missing` | The credentials file is not at the chosen location. | Choose file... |
| `failed/credentials-unsafe` | The credentials file must belong to you and be readable only by you. | Choose file... |
| `failed/credentials-invalid` | That file is not the credentials file for the tunnel named in its filename. | Choose file... |
| `failed/bad-hostname`, `bad-port` | The public hostname / port is not valid. | Edit |
| `failed/binary-not-found` | cloudflared was not found at /opt/homebrew/bin or /usr/local/bin. | Choose cloudflared... |
| `failed/binary-unsafe-path` | cloudflared, or a folder above it, can be modified by other users. | Choose cloudflared... |
| `failed/binary-quarantined` | macOS has quarantined this cloudflared file. | show command |
| `failed/binary-signature-invalid` | The code signature on cloudflared does not verify. | Choose cloudflared... |
| `failed/binary-unrecognized` | This file did not identify itself as cloudflared. | Choose cloudflared... |
| `failed/binary-flag-unsupported` | This cloudflared does not accept a required option. Update it. | none |
| `needs-trust/binary-untrusted` | cloudflared {version} has not been approved to run. | Review and trust... |
| `needs-trust/binary-changed` | cloudflared changed since you approved it ({old} -> {new}). It will not run until you approve it again. | Review and trust... |
| `failed/config-rejected` | cloudflared rejected the generated configuration. | Copy log |
| `failed/spawn-failed` | cloudflared could not be started ({errno}). | Retry |
| `starting` / `connecting` | Starting tunnel... / Connecting to Cloudflare ({n} s). | Pause |
| `checking-public` | Connected to Cloudflare. Checking https://{host}. | Pause |
| `online` | Online at https://{host}, last check {n} s ago. | Pause, Restart |
| `degraded/not-ready` | cloudflared is running but has not registered a connection after {n} s. | Restart, Copy log |
| `degraded/tunnel-not-serving` | Cloudflare reports no tunnel is serving {host} (HTTP 530 on the last 3 checks). | Restart |
| `degraded/origin-unreachable` | Cloudflare reached the tunnel but the bridge did not answer (HTTP 502). | Restart |
| `degraded/ingress-mismatch` | The tunnel answered 404 for {host}: the hostname routed to this tunnel differs from the configured one. | Edit |
| `degraded/edge-blocked` | Cloudflare blocked the check (HTTP 403). Look at Bot Fight Mode and WAF rules. | none |
| `degraded/wrong-origin` | Something answered at {host} that is not this app's bridge. | Pause (danger) |
| `degraded/dns-not-found`, `edge-unreachable`, `offline` | The name {host} does not resolve / could not be reached / this Mac reports no network. | Restart |
| `backoff` | cloudflared exited ({exit}). Restarting in {n} s (attempt {k}). | Restart now |
| `failed/tunnel-auth-rejected` | Cloudflare did not accept the tunnel credentials. | Choose file... |
| `failed/crash-loop` | cloudflared stopped 5 times in 10 minutes. Not restarting automatically. | Retry, Copy log |
| `paused` | Public access is paused. ChatGPT cannot reach this Mac. | Resume |
| `stopping` | Stopping the tunnel. | none |
| `failed/stop-stuck` | cloudflared did not exit after SIGKILL; it will be checked at next launch. | none |
| `failed/owned-elsewhere` | Another running Infinite Canvas process owns this tunnel. | none |
| notice `orphan-stopped` / `orphan-stuck` | Stopped a leftover cloudflared (pid {pid}) from an earlier session. / Could not stop a leftover cloudflared (pid {pid}). | Dismiss |
| notice `foreign-connector` | Another cloudflared (pid {pid}) is running; if it serves the same tunnel, requests are split between the two. | Dismiss |
| notice `cert-present` | ~/.cloudflared/cert.pem exists; the app does not need it. | Dismiss |
| notice `binary-old` | This cloudflared was built more than 180 days ago and auto-update is off. | Dismiss |

The status snapshot that crosses IPC: `{v:1, state, code, message, since, hostname, uptimeMs|null, lastPublicOkAt|null, lastPublicCode|null, restarts:{lastHour,total}, lastExit:{code,signal,at}|null, binary:{version, signKind, trusted}|null, credentials:{fileName masked}, notices:[...], actions:[ids]}`. It never contains raw log lines, full paths beyond the two display paths, credentials contents, hash beyond 12 hex chars, or pids other than in notices. The bridge pill shows the worst tunnel state ("ChatGPT cannot reach this Mac" when not `online`) plus "Public since HH:MM".

---

## 11. Integration points

**main.js (design's three hunks; no fourth):** register inside the design's try/catch after `registerNonApiAiHandlers()` (:1178); after `createWindow({mode:'auto'})` (:1203) schedule `setTimeout(..., 3000)` for `reapOrphans('launch')` and auto-start-if-enabled (so boot is never delayed; failures are caught); `stopHandoffBridge()` (which contains `tunnel.stop`) is the fourth entry of the quit `Promise.allSettled` (:1361-1365).

**preload.js (additive):** `handoffBridgeTunnelChooseBinary`, `handoffBridgeTunnelChooseCredentials`, `handoffBridgeTunnelTrustBinary`, `handoffBridgeTunnelRestart`, `handoffBridgeTunnelPause`, `handoffBridgeTunnelResume`, `handoffBridgeTunnelCopyLog`, `handoffBridgeTunnelDismissNotice` (all `ipcRenderer.invoke('handoff-bridge:tunnel-...')`) and the listener `onHandoffBridgeTunnelStatus` on `handoff-bridge:tunnel-status` (throttled >= 250 ms). Handlers accept no payload fields (extra fields ignored), never accept a path or command string, return `{ok, code}` only, and use `ipcMain.handle`. The file choosers open `dialog.showOpenDialog` in main with the existing E2E guard pattern (main.js:734); `copyLog` writes the clipboard from main. Any settings change that affects the tunnel (credentials, binary, hostname) is confirmed by a main-owned native dialog (Cancel default), because the renderer has no CSP and no sender-frame checks.

**UI (additive, inside the design's HandoffBridgeSetup.jsx and Panel):** a "Tunnel" subsection (status row, the buttons in section 10) and the pill text. Use "Choose file..." (not the smoke-asserted-absent 'Browse…', electron-smoke.js:1114). Inline useRef/useState only, hooks above early returns (React Compiler rules).

**Bridge contract:** the controller calls `tunnel.start()` only after the listener bound and self-probed; calls `await tunnel.stop()` before closing the listener; passes `hostname` from `publicBase` and `localPort`; calls `restart('params-changed')` after a confirmed change. The engine reads `tunnel.getStatus().state` so a stall message reads "the public address was unreachable for N min" instead of "may have been blocked" when the tunnel is not `online`. The HTTP layer's per-source limits and source-class alarm must key on `CF-Connecting-IP` (trusted only because the TCP peer is loopback), not the socket address [V, server.js:385]. `getDiagnostics()` returns only enums, counters and timestamps for the design's optional bug-report block (D10).

**Under D5 (no timers), the tunnel-side controls are:** Pause/Resume (8.5), continuous `online` validation (I-9), "Public since" indicator, quit/disable = down (I-7), reap at launch, the opt-in lock-screen pause, and the recommended Cloudflare edge rate-limit rule for `/oauth/*` **[P: free-plan quota unverified]**. A dead-man timer was deliberately not added because D5 says no timers (open question Q4).

---

## 12. One-time setup Jack must do himself (I ran none of this; it needs a browser and the network)

Already true **[V]**: cloudflared 2026.9.3 at /opt/homebrew/bin; ~/.cloudflared is 0700 with the lab credentials (0400) and no cert.pem; the zone is on Cloudflare with bot/AI-crawler blocks off (progress log). Recommended: a **new dedicated production tunnel** (own credentials, so the lab can be deleted independently).

```bash
# 1. one-time browser authorization for lullascape.com; writes ~/.cloudflared/cert.pem
cloudflared tunnel login
# 2. create the production tunnel; note the UUID it prints; writes ~/.cloudflared/<UUID>.json (mode 0400)
cloudflared tunnel create lullascape-bridge
# 3. route the hostname with the UUID printed by create (creates a proxied CNAME bridge -> <UUID>.cfargotunnel.com)
# Do not route by name: a default config's readable credentials-file can select that configured tunnel first.
cloudflared tunnel route dns <UUID_FROM_CREATE_OUTPUT> bridge.lullascape.com
# 4. delete the broad certificate again (it can create/delete every tunnel in the zone)
rm -f ~/.cloudflared/cert.pem
# 5. checks
ls -l ~/.cloudflared                        # expect <UUID>.json with -r--------, no cert.pem
dig +short bridge.lullascape.com @1.1.1.1       # expect Cloudflare addresses, not NXDOMAIN; verify the dashboard target is <UUID>.cfargotunnel.com
# optional: stop Homebrew from upgrading (each upgrade needs a re-approval in the app)
brew pin cloudflared
```
Do NOT edit ~/.cloudflared/config.yml (it stays the lab's; the app ignores it). Do NOT run `cloudflared tunnel run` by hand for the tunnel the app is using: two connectors split traffic and produce 502s (the app shows notice `foreign-connector`). Rehearsal without new Cloudflare setup: point the app at the lab tunnel (choose `88bf3f23-dfa9-4a0c-8850-4257fa8e9778.json`, hostname `bridge-lab.lullascape.com`) with the manual lab connector stopped. Then, once Phase 1 exists: Settings -> ChatGPT bridge -> Choose credentials file... (`<UUID>.json`), set the hostname, Enable, review and trust the cloudflared binary dialog. Create the ChatGPT plugin at `https://bridge.lullascape.com/mcp` with OAuth (design section 8); do not put Cloudflare Access in front.

Emergency stop, most to least gentle: Pause in the app; quit the app; `pkill -f 'handoff-bridge/tunnel/config.yml'`; delete the DNS route or the tunnel in Cloudflare (`cloudflared tunnel delete lullascape-bridge` needs a fresh `tunnel login`).

---

## 13. Testing

### 13.1 Registered unit tests (`scripts/tests/handoff-tunnel.js`, register in scripts/test-runner.js; unique names prefixed `tunnel:`; no network, no ports)
1. Validators: hostname accepts `bridge.lullascape.com`, rejects `a.b`, `-x.example.com`, `x..example.com`, IPs, `x.com:443`, `*.x.com`, trailing dot, uppercase-normalisation, non-ASCII, >253 chars, label >63, and every hostile string containing newline, `: `, `#`, quotes, `${}`, NUL, U+2028/2029, leading `-`, `..`. Same fuzz table for UUID, port and credentials path; a failure throws before any file write.
2. Config golden: byte-exact text for fixed params (including a path with a space); structural check that any accepted params render exactly the three top-level keys and two ingress rules.
3. Argv/env golden: exact argv arrays (run and dry run); no element starts with `-` except constants; none of the forbidden flags; env keys are exactly PATH/HOME/TMPDIR when the fake `process.env` contains `TUNNEL_TOKEN`, `NO_AUTOUPDATE`, `ELECTRON_*`, `VITE_*`, `npm_*`, `*SECRET*`.
4. Redaction sentinels: fake token, base64 blob, UUID, home path, hostname, query string; ring caps under a 5 MB flood; partial lines, CRLF, ANSI, overlong lines; nothing unredacted reaches ring, log file or `copyLog()`.
5. Classifiers: exit table (auth, credentials, network, port, early, expected) and probe table (every row of 8.3).
6. `psParse`: this Mac's real row shape, a Linux-shaped row, commands with spaces; marker matches the exact path but not `config.yml.bak`, another directory, a prefix, or the lab `cloudflared tunnel run lullascape-bridge-lab`.
7. Binary inspection with a fake fs/exec: permission matrix (world-writable dir, group-writable non-admin dir rejected, admin gid 80 allowed, wrong owner, dir instead of file, tiny file), quarantine, codesign fixtures (adhoc/developer-id/unsigned), trust decision table incl. Tier A same-team and different-team.
8. Credentials inspection: 0400/0600 ok, 0640/0644 fail, symlink, wrong owner, size, bad JSON, TunnelID mismatch, non-UUID filename, unsafe characters.
9. Supervisor with fake spawn/exec/fetch/timers: happy path to `online` and call order (reap before spawn; config write before dry run; dry run before spawn; pidfile after spawn; hash re-check before spawn); refuses without a bound listener, under E2E env, unpackaged, wrong arch, `INFINITE_CANVAS_HANDOFF_BRIDGE=0`.
10. Exit handling: permanent classes never retry; backoff sequence 1,2,4,8,16,30,30 s with `random=0.5`; reset after 120 s ready; 5 exits in 10 min -> `crash-loop`; an exit during `stopping` never restarts; network-unreachable exits do not count toward the loop.
11. Probe-driven: 3 failures -> `degraded`, recovery -> `online`; `tunnel-not-serving` restarts at most once per 10 min; `ingress-mismatch`, `edge-blocked`, `wrong-origin` never restart.
12. Stop: TERM only; TERM twice; KILL; stuck (`failed(stop-stuck)`, pidfile kept); negative-pid invariant (`process.kill` never receives `-process.pid`, 0, -1, 1, and `-pid` only when pgid was verified); `stop()` during `starting` aborts; start/stop/start serialisation; pause/resume; rate-limited manual restart.
13. Reap: recorded orphan with ppid 1 killed with TERM, TERM, KILL; PID reused (lstart differs) -> not killed and pidfile removed; ppid = a live other app process -> `owned-elsewhere`, untouched; unrecorded orphan found by scan only; untracked own child (ppid === process.pid) killed; current child skipped; foreign/lab cloudflared advisory only; ps failure -> `reap-unverified`, start proceeds with warning.
14. Privacy sentinels: run a full scripted lifecycle with a capturing logger; assert no path, hostname, UUID, hash or cloudflared line in logger output, status snapshots, diagnostics or IPC returns.
15. Source scans: `child_process` only in `tunnel/exec.js`; one `spawn(`; no `shell:true`/`exec(`/`execSync`/`spawnSync`; no `--token`, `credentials-contents`, `TUNNEL_TOKEN`, non-`info` loglevel; no `electron` import inside `tunnel/`; no `process.env.PATH` read; no `.message`/`.stack` in log calls; `process.kill(` only in `signalGroup`/`isAlive`; http/mcp/oauth/preflight/framing never import `tunnel/`; `stopHandoffBridge` sits inside the quit `Promise.allSettled([...])` (extend the pinned regex, scripts/tests/electron-regressions.js:115 per the design).
16. Fake-binary integration (registered, real `spawn`, no ports; precedent scripts/tests/job-api-probe.js:243): the test writes an executable `#!<absolute process.execPath>` script (not `env node`, because PATH is whitelisted) into a temp dir; readiness comes from an injected `readyProbe` that reads a marker file. It verifies real argv/env/cwd, `detached` pgid === pid, stop by TERM and by KILL (fake ignores SIGTERM), group kill of a grandchild, stdout flood without stalling, secret redaction of noisy output, pidfile content. The fake also answers `--version`, `tunnel ... ingress validate` and `ingress rule` (parsing the generated config), and can emit `flag provided but not defined: -label` to test optional-flag dropping.

### 13.2 Out-of-band selftest (`scripts/tunnel-supervisor-selftest.mjs`, `npm run test:tunnel`, macOS only, not in `npm test` or CI)
Binds ephemeral loopback ports: the fake serves `/ready` on the metrics address, a stub serves the protected-resource JSON for the (test-only, DI-injected) probe base. Covers: start -> online; `kill -9` of the child -> backoff -> restart -> online; a real orphan created with `sh -c 'fake ... &'` (reparents to launchd) reaped by the real `ps` path; SIGTERM-ignoring fake escalates within 5.6 s; grandchild dies. If the real cloudflared is present it also runs offline only: `--version`, the dry-run `ingress validate` (exactly two lines) and the two `ingress rule` checks against the generated config (mechanism verified by hand today).

### 13.3 Manual checks (packaged app started from Finder = minimal env; each resolves a [P] tag)
- **M1** Enable with a Finder-launched app: binary found without PATH; trust dialog shows path, version, SHA, "Ad hoc signature"; `ps -ww -o command= -p <pid>` shows the exact argv with `--config <userData>/handoff-bridge/tunnel/config.yml`.
- **M2** `curl -i https://bridge.lullascape.com/.well-known/oauth-protected-resource/mcp` is 200 JSON; state `online`.
- **M3** Cmd+Q: `pgrep -fl cloudflared` shows no app-owned process within 6 s and `tunnel.pid.json` is gone.
- **M4** `kill -9 <main pid>`: orphan remains (expected); relaunch shows the `orphan-stopped` notice and exactly one connector; then `online`.
- **M5** Record the real `/ready` body and status while connected, during connecting, and with Wi-Fi off; tune `START_READY_TIMEOUT_MS`; confirm `--management-diagnostics=false`, `--label` and `--grace-period` do not change behaviour.
- **M6** Record the exact cloudflared lines for: wrong credentials JSON, a UUID that is not a tunnel, Wi-Fi off, metrics port taken; update classifier fixtures.
- **M7** Record the public probe HTTP result for: connector stopped, listener stopped, hostname mismatch, WAF rule on. Confirm 530/502/404/403 mappings.
- **M8** Sleep/wake (lid closed 5 min): time to `online`, whether a restart was needed.
- **M9** Binary trust: `brew reinstall cloudflared` or edit a copy -> `binary-changed`; `chmod g+w` a non-admin ancestor of a copy -> `binary-unsafe-path`; credentials mode 0644 -> `credentials-unsafe`.
- **M10** Quarantine: on a COPY in a temp dir, `xattr -w com.apple.quarantine "0081;00000000;Safari;" <copy>` -> `binary-quarantined`.
- **M11** `kill -TERM <main pid>`: does the app quit normally and is the child gone? Does `process.on('exit')` fire after `app.exit(0)`? (decides whether `killNowSync` is worth keeping).
- **M12** App Nap: hide the app for 30 min while enabled; compare probe timestamps; if they slip past 2x the interval, add `powerSaveBlocker`.
- **M13** `ps -Eww -p <pid>` (own process) shows only HOME, PATH, TMPDIR.
- **M14** After one real ChatGPT link and a session, grep the ring and `cloudflared.log` for `code=`, `/oauth`, `Bearer`: expect none at info level.
- **M15** Disable/enable 5 times: never two app-owned cloudflared processes.
- **M16** Auto-start on launch when enabled; Pause and Resume behave; a manual lab connector running for the same tunnel produces the `foreign-connector` notice.
- **M17** If a Developer-ID-signed cloudflared is ever installed: `codesign -dv --verbose=4` to see Authority/TeamIdentifier and exercise the Tier A row.

### 13.4 Gates
`npm test` (never the bare runner), `npx eslint .`, `npm run build:compile`, `npm run test:e2e` (tunnel must stay inert), `npm run test:tunnel` on the Mac, then M1-M16, then the local act pre-push gate.

---

## 14. Build order and exit criteria (estimates are unmeasured: about 5-7 working days)
T-A pure modules + unit tests 1-6; T-B binary and credentials inspection (7-8); T-C supervisor state machine with fakes (9-14); T-D real `exec.js`, `index.js`, fake-binary integration (16), source scans (15); T-E main/preload/UI hunks, native dialogs; T-F selftest, M1-M16, doc updates. Each stage ends with `npm test` at 0 failed and lint clean; T-F ends with the packaged app enabling, surviving a `kill -9` relaunch and quitting cleanly.

Doc updates required with the build: design doc sections 2, 5, 8, 9, 10 (T1, T10), 13, 14 (item 2), D6 text and the decision log; runbook section 4 replaced by the section 12 commands; new `docs/chatgpt-bridge.md` tunnel chapter.

## Files

- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/constants.js`: NEW. All timings, regexes, fixed strings, the code enum and MESSAGES[code] (section 3, 10).
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/validate.js`: NEW, pure. validateHostname, validateTunnelId, validatePort, validateAbsolutePath, validateTunnelParams (section 5.1).
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/config.js`: NEW, pure. renderTunnelConfig (golden text), buildRunArgv, buildDryRunArgv, buildChildEnv (sections 5.2, 6).
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/redact.js`: NEW, pure. redactLine rules (section 7).
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/logRing.js`: NEW, pure. Line splitter + capped ring buffer + redaction hook.
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/classify.js`: NEW, pure. classifyExit and classifyProbe tables.
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/psParse.js`: NEW, pure. parsePsRows, isOwnedCloudflaredCommand (substring marker), isCloudflaredCommand.
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/files.js`: NEW. ensureTunnelDir (uses electron/utils/pathSafety.js ensureDirectoryWithinRoot), writeFileAtomic0600 (text twin of atomicWriteJson), bounded JSON read, mode/owner checks.
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/binary.js`: NEW. discoverCandidates, inspectBinary (ownership/ancestor/quarantine/codesign/hash/version), decideTrust (section 4).
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/credentials.js`: NEW. inspectCredentials (section 4.4).
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/exec.js`: NEW. The ONLY importer of node:child_process: spawnCloudflared and execFixed (fixed absolute tool paths /bin/ps, /usr/bin/codesign, /usr/bin/xattr).
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/reap.js`: NEW. Pidfile, ps scan, ownership decision table, TERM/TERM/KILL sequence (section 9).
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/probe.js`: NEW. probeLocalReady, probePublic (injected fetch, body cap), pickFreePort.
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/supervisor.js`: NEW. createTunnelSupervisor state machine, serial queue, generation guard, backoff, pause/resume, stop, killNowSync (section 8).
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/tunnel/index.js`: NEW. createRealTunnelSupervisor(ctx): binds real fs/child_process/fetch/timers/powerMonitor (optional-chained), native dialogs, clipboard.
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/handoffBridge/index.js`: NEW (bridge controller, other analyses own the body). Must: bind listener + self-probe before tunnel.start; await tunnel.stop before closing the listener; pass hostname/localPort; expose tunnel status in the bridge snapshot; stopHandoffBridge() calls tunnel.stop('quit') in parallel with the drain.
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/main.js`: ADDITIVE, within the design's three hunks: guarded registration after registerNonApiAiHandlers() (:1178); a 3 s deferred launch reap/auto-start after createWindow (:1203); stopHandoffBridge() as the fourth entry of the quit Promise.allSettled (:1361-1365). No will-quit handler, no process signal handlers.
- `/Users/jack/Desktop/My Apps/infinite-canvas/electron/preload.js`: ADDITIVE. handoffBridgeTunnel* invokes and onHandoffBridgeTunnelStatus (section 11).
- `/Users/jack/Desktop/My Apps/infinite-canvas/src/components/HandoffBridgeSetup.jsx`: NEW (inside Settings). Tunnel subsection: status row, Choose credentials file..., Choose cloudflared..., Review and trust..., Pause/Resume, Restart, Copy log, notices. Avoid the smoke-asserted absent labels.
- `/Users/jack/Desktop/My Apps/infinite-canvas/src/components/HandoffBridgePanel.jsx`: NEW (other analyses own the body). Pill shows the worst tunnel state and 'Public since HH:MM'.
- `/Users/jack/Desktop/My Apps/infinite-canvas/scripts/tests/handoff-tunnel.js`: NEW. Unit and fake-binary integration tests listed in section 13.1; register as 'handoff-tunnel.js' in scripts/test-runner.js.
- `/Users/jack/Desktop/My Apps/infinite-canvas/scripts/test-runner.js`: ADDITIVE. import + testGroups registration for handoff-tunnel.js (validateTestRegistry fails on an unregistered file).
- `/Users/jack/Desktop/My Apps/infinite-canvas/scripts/tunnel-supervisor-selftest.mjs`: NEW, out of band. Real ports and processes on the Mac; offline real-binary dry-run checks when cloudflared is installed.
- `/Users/jack/Desktop/My Apps/infinite-canvas/package.json`: ADDITIVE. script "test:tunnel": "node scripts/tunnel-supervisor-selftest.mjs". No dependency and no electron-builder change: the modules are bundled into dist-electron/main.cjs by the existing vite entry, and Node builtins are external.
- `/Users/jack/Desktop/My Apps/infinite-canvas/docs/chatgpt-mcp-bridge-design.md`: UPDATE sections 2, 5, 8, 9, 10 (T1, T10), 13, 14 item 2, D6 and the decision log to the supervised-child model (see designClaimsThatNoLongerHold).
- `/Users/jack/Desktop/My Apps/infinite-canvas/docs/chatgpt-bridge-hostname-runbook.md`: UPDATE section 4: replace the dashboard-token method with the credentials-JSON commands from section 12 of the spec.
- `/Users/jack/Desktop/My Apps/infinite-canvas/docs/chatgpt-bridge.md`: NEW runbook (already planned by the design): tunnel chapter with setup commands, states, emergency stop, upgrade re-approval.

## Tests

- Unit (registered, npm test): validators + hostile-string fuzz; byte-exact config golden and structural check; argv/env goldens with an env-poisoning case; redaction sentinels and ring caps under a 5 MB flood; exit and probe classifier tables; psParse with this Mac's row shape and marker near-misses (config.yml.bak, other dir, lab tunnel command); binary permission/quarantine/codesign/trust matrices; credentials matrices.
- Supervisor with fakes: happy path call order (reap -> creds -> binary/trust -> config -> dry run -> hash recheck -> pidfile intent -> spawn -> pidfile); gate refusals (no listener, E2E env, unpackaged, wrong arch, INFINITE_CANVAS_HANDOFF_BRIDGE=0); backoff sequence and reset; crash-loop; permanent classes; exit during stopping; probe-driven degrade/recover; restart limiter; stop TERM/TERM/KILL/stuck; negative-pid invariant; generation abort; serialization; pause/resume; manual-restart rate limit.
- Reap table: recorded orphan ppid 1 killed; PID reuse via lstart mismatch not killed; live other owner untouched; scan-only orphan killed; untracked own child killed; lab/foreign cloudflared advisory only; ps failure -> reap-unverified.
- Privacy sentinels over logger/status/diagnostics/IPC returns; source scans (child_process only in exec.js, single spawn, no shell/exec/token/debug, no electron import, no PATH read, process.kill confined, http/mcp/oauth do not import tunnel/, stopHandoffBridge inside the quit allSettled regex).
- Fake-binary integration in npm test (real spawn of a generated `#!<abs node>` script, no ports, injected readiness): argv/env/cwd, pgid === pid, KILL escalation against a SIGTERM-ignoring fake, grandchild group kill, flood, redaction, pidfile, dry-run emulation, optional-flag dropping.
- Out of band `npm run test:tunnel` (macOS): real ports; crash -> backoff -> restart; real launchd-reparented orphan reaped through real ps; KILL escalation within 5.6 s; offline real-cloudflared --version / ingress validate / ingress rule checks against the generated config.
- Manual M1-M17 on the packaged app from Finder (env minimal): binary discovery without PATH, trust dialog, argv/env via ps, public 200, Cmd+Q leaves no cloudflared, kill -9 then relaunch reaps, /ready shapes, failure log strings, probe HTTP codes, sleep/wake, binary swap and unsafe-path cases, quarantine on a copy, SIGTERM behaviour and process exit hook, App Nap slip, no URLs/codes in logs at info level, no double connectors, auto-start and foreign-connector notice, Developer-ID tier if ever available.
- Gates: npm test 0 failed (never the bare runner), npx eslint ., npm run build:compile, npm run test:e2e (tunnel inert), npm run test:tunnel, act pre-push.

## Risks

- Orphan window after Force Quit or crash: macOS has no parent-death signal, so cloudflared can run until the next launch (config-path marker + pid 1 reparenting makes it reapable, but only at the next launch). Effect: intermittent 502s if a second connector starts; a local port squatter could receive public traffic only if malware already runs as the user. Rejected mitigations are recorded in spec section 9.
- The installed cloudflared is ad-hoc/linker-signed with no Team ID (verified), so the enforced control is a trust-on-first-use SHA-256 pin. Every `brew upgrade` will require a re-approval, and a same-UID attacker can rewrite the pin file or swap the binary between hash and exec (TOCTOU). The pin gives change detection and accident protection, not protection from code already running as Jack.
- I could not run `cloudflared tunnel run` (network was off limits). Everything about run-time behaviour is provisional until M5-M8, M11: the /ready response shape, the exact failure log lines used by the classifiers, edge HTTP codes (530/502/404/403), whether SIGTERM twice shortens shutdown, whether Electron turns SIGTERM into a normal quit, and whether process.on('exit') fires after app.exit(0). The offline mechanism (flags, config, ingress validate/rule) is verified.
- D5 (always on while the app is open) makes the public path continuous. The supervisor adds Pause/Resume, continuous resource-validated health, reap at launch and quit=down, but no timer-based auto-close. Any exposure control beyond that is a product decision for Jack (open question Q4).
- App Nap or timer coalescing may delay probes and backoff timers when the app is fully hidden; unmeasured (M12). If it bites, a powerSaveBlocker while enabled is needed.
- cloudflared auto-update is disabled by design, so the binary ages until Jack upgrades it deliberately; an advisory notice appears after 180 days. Homebrew upgrades also trigger the re-approval.
- Log redaction is pattern-based and can miss an unknown secret format. Mitigated by info level (no URLs), no raw lines in logger/bug reports, and user-gesture-only export.
- Two connectors for one tunnel (a manual `cloudflared tunnel run` next to the app) split traffic and cause 502s; the app can only warn (notice foreign-connector), never kill a foreign process.
- The design doc's test convention (no process spawn or port in deterministic tests) is stricter than the repo; the spec keeps ports out of npm test but adds one real-spawn fake-binary group using the job-api-probe.js:243 precedent. Jack may prefer to move it to the out-of-band script.
- The local cloudflared metrics server on 127.0.0.1 is reachable by any local process (metrics only; no secrets expected). The tunnel UUID and config path are visible in `ps` to all users; neither is a secret.
- Cloudflare-side trust root (T10) is unchanged: compromise of the Cloudflare account, the registrar, or the 0400 credentials JSON lets an attacker attach a connector. Rotation is tunnel delete/recreate.
- Package/CI: nothing gates the packaged runtime; the supervisor is bundled by the existing vite entry with no new dependency, but a manual packaged run (M1-M16) is mandatory. Estimates (5-7 working days) are unmeasured.

## Open questions for Jack

- Q1 Auto-start: D5 says the bridge stays available 'until you disable it or quit the app'. Should an enabled bridge auto-start (tunnel included) on the next app launch? Spec default: yes, 3 s after the window opens, with a visible pill; the alternative is to require Enable again after every launch.
- Q2 Production tunnel: create a new dedicated tunnel `lullascape-bridge` with its own credentials (recommended, spec section 12), or add `bridge.lullascape.com` as a second route on the existing lab tunnel `lullascape-bridge-lab` (one credential file, less separation)?
- Q3 Binary trust: accept the trust-on-first-use SHA-256 pin with a re-approval after each `brew upgrade` (spec default, `brew pin cloudflared` optional), or bundle a pinned cloudflared inside the app bundle so the app is the trust root (26 MB, manual updates, extra deep-codesign work)?
- Q4 D5 containment: are Pause/Resume, the continuous validated health check and reap-at-launch enough, or do you want an opt-in (default off) 'pause while the screen is locked'? A dead-man timer was not added because D5 says no timers; say so if you want one after all.
- Q5 Test convention: accept the registered real-spawn fake-binary test in npm test (precedent job-api-probe.js:243), or keep every process-spawning tunnel test in the out-of-band `npm run test:tunnel` script only?
- Q6 Hostname: keep the public hostname editable in Settings (native confirm on every change), or hard-code `bridge.lullascape.com` in a constant so a compromised renderer cannot propose another host? Spec default: editable with native confirm.
- Q7 Should the launch-time orphan reap also run when the bridge is currently disabled (spec default: yes, whenever a pidfile exists)?
- Q8 Are you willing to have quit take up to about 5.5 s longer in the worst case (cloudflared ignoring SIGTERM), inside the existing 25 s quit race, so the public path is always cut first?
