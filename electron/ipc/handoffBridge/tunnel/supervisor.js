import { TUNNEL_CONSTANTS } from './constants.js';
import { renderTunnelConfig, buildRunArgv, buildDryRunArgv, buildChildEnv, validateDryRunOutput } from './config.js';
import { ensureTunnelDirectory, atomicWriteText, tunnelPaths } from './files.js';
import { prepareBinary, verifyPinnedCopy, findApprovedCopy, findBinary } from './binary.js';
import { inspectCredentials, legacyCertPresent, recordTunnelIntent } from './credentials.js';
import { spawnCloudflared, execBinary, execFixed } from './exec.js';
import { reapOrphans, signalGroup } from './reap.js';
import { chooseMetricsPort, probeReady, publicProbe } from './probe.js';
import { classifyExit } from './classify.js';
import { createLogRing, createRotatingLog } from './logRing.js';

const PERMANENT = new Set(['flag-rejected', 'credentials-invalid', 'tunnel-auth-rejected', 'hostname-not-public', 'binary-changed', 'binary-untrusted']);
function safeUnlink(fsImpl, target) { try { fsImpl?.unlinkSync?.(target); } catch { /* a stale intent is harmless */ } }

export function createTunnelSupervisor(options = {}) {
  const now = options.now || Date.now;
  const timers = options.timers || globalThis;
  const fsImpl = options.fsImpl;
  const paths = tunnelPaths(options.userData || '');
  const mirror = options.mirrorLog || createRotatingLog({ fsImpl, target: options.logPath || `${paths.root}/cloudflared.log` });
  const log = createLogRing({ mirror });
  let state = 'off'; let child = null; let generation = 0; let serial = Promise.resolve();
  let metricsPort = null; let retryTimer = null; let readyTimer = null; let publicTimer = null;
  let readyStartedAt = 0; let readySince = null; let publicFailures = 0; let probeCount = 0;
  let crashTimes = []; let unrequestedTimes = []; let lastManualRestartAt = -Infinity;
  let stopping = false; let attemptedPorts = new Set(); let lastExit = null; let handledExitToken = null; let backoffAttempts = 0; let lastProbeRestartAt = -Infinity;
  let currentExitLines = [];
  const notices = new Set();

  const status = () => Object.freeze({ state, metricsPort, restarts: crashTimes.length, lastExit, notices: Object.freeze([...notices]) });
  const result = (ok, code = null, extra = {}) => Object.freeze({ ok, ...(code ? { code } : {}), ...extra, status: status() });
  const audit = (event, detail = {}) => { try { options.audit?.({ event, ...detail }); } catch { /* audit must not destabilize the tunnel */ } };
  const alarm = code => { try { options.alarm?.(code); } catch { /* best effort */ } };
  const clearTimer = name => {
    const timer = name === 'retry' ? retryTimer : name === 'ready' ? readyTimer : publicTimer;
    try { if (timer !== null) timers.clearTimeout?.(timer); } catch { /* clearing cannot strand shutdown */ }
    finally { if (name === 'retry') retryTimer = null; else if (name === 'ready') readyTimer = null; else publicTimer = null; }
  };
  const clearAllTimers = () => { clearTimer('retry'); clearTimer('ready'); clearTimer('public'); };
  const enqueue = operation => {
    const next = serial.then(operation, operation);
    serial = next.catch(() => undefined);
    return next.catch(error => { state = 'failed'; lastExit = error?.code || 'spawn-failed'; return result(false, lastExit); });
  };
  const fail = code => { state = 'failed'; lastExit = code; return result(false, code); };
  const setTimer = (kind, fn, delay) => {
    clearTimer(kind);
    const marker = {};
    if (kind === 'ready') readyTimer = marker; else if (kind === 'public') publicTimer = marker; else retryTimer = marker;
    let timer;
    try {
      if (typeof timers.setTimeout !== 'function') throw new TypeError('timer unavailable');
      timer = timers.setTimeout(() => { if (kind === 'ready') readyTimer = null; else if (kind === 'public') publicTimer = null; else retryTimer = null; void enqueue(fn); }, delay);
      timer?.unref?.();
    } catch {
      try { if (timer !== undefined) timers.clearTimeout?.(timer); } catch { /* best effort */ }
      if (kind === 'ready') readyTimer = null; else if (kind === 'public') publicTimer = null; else retryTimer = null;
      clearAllTimers();
      state = 'failed'; lastExit = 'spawn-failed'; alarm('spawn-failed');
      generation++;
      if (child) { killSpawnedGroup(child); child = null; }
      removeIntent();
      return false;
    }
    const current = kind === 'ready' ? readyTimer : kind === 'public' ? publicTimer : retryTimer;
    if (current === marker) { if (kind === 'ready') readyTimer = timer ?? null; else if (kind === 'public') publicTimer = timer ?? null; else retryTimer = timer ?? null; }
    else if (timer !== undefined) { try { timers.clearTimeout?.(timer); } catch { /* synchronous timer already fired */ } }
    return true;
  };
  const trim = (list, windowMs) => list.filter(value => value >= now() - windowMs);

  const production = {
    xattr: target => { try { execFixed('xattr', ['-p', 'com.apple.quarantine', target], options); return { present: true }; } catch { return { present: false }; } },
    codesign: target => { try { const output = execFixed('codesign', ['-dv', '--verbose=4', target], options); execFixed('codesign', ['--verify', '--strict', target], options); return { verified: /(?:Signature=adhoc|Authority=|TeamIdentifier=|Identifier=)/.test(output) }; } catch { return { verified: false }; } },
    version: target => {
      try { return execBinary(target, ['--version'], { ...options, cwd: paths.root, env: buildChildEnv(options), timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }).trim(); }
      catch (error) { throw Object.assign(error, { code: 'binary-unrecognized' }); }
    },
    getProcessInfo: async pid => {
      try {
        const row = String(execFixed('ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,lstart=,command='], options)).trim();
        const match = row.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
        return match ? { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), lstart: match[4].trim(), command: match[5] } : null;
      } catch { return null; }
    },
  };

  const scheduleRetry = code => {
    if (PERMANENT.has(code)) return fail(code);
    const base = TUNNEL_CONSTANTS.BACKOFF_SECONDS[Math.min(backoffAttempts, TUNNEL_CONSTANTS.BACKOFF_SECONDS.length - 1)] * 1000;
    backoffAttempts++;
    const random = options.random || Math.random;
    const delay = Math.round(base * (0.8 + random() * 0.4));
    state = 'backoff'; lastExit = code;
    if (!setTimer('retry', startInternal, delay)) return result(false, 'spawn-failed');
    return result(false, code, { retryAt: now() + delay });
  };

  const removeIntent = () => safeUnlink(fsImpl, paths.pid);
  const killSpawnedGroup = spawned => {
    if (!spawned?.pid) return;
    let sent = false;
    try { sent = (options.signalGroup || signalGroup)(spawned.pid, 'SIGKILL', { kill: options.kill }); } catch { /* fall through to the child handle */ }
    if (!sent) try { spawned.kill?.('SIGKILL'); } catch { /* last-resort wrapper cleanup */ }
  };
  const onExit = (token, code, signal) => {
    if (token !== generation || stopping || handledExitToken === token) return;
    handledExitToken = token;
    child = null; clearTimer('ready'); clearTimer('public');
    const classification = classifyExit({ code, signal, lines: currentExitLines, requested: false });
    lastExit = classification;
    if (classification === 'metrics-port-in-use') attemptedPorts.add(metricsPort);
    if (classification === 'network-unreachable') { audit('tunnel_network_unreachable'); return scheduleRetry(classification); }
    if (classification === 'exited-unrequested') unrequestedTimes = trim([...unrequestedTimes, now()], TUNNEL_CONSTANTS.CRASH_WINDOW_MS);
    if (code !== 0 || signal) crashTimes = trim([...crashTimes, now()], TUNNEL_CONSTANTS.CRASH_WINDOW_MS);
    if (unrequestedTimes.length >= TUNNEL_CONSTANTS.UNREQUESTED_EXIT_LIMIT) { audit('tunnel_unrequested_exit_loop'); alarm('unrequested-exit-loop'); return fail('unrequested-exit-loop'); }
    if (crashTimes.length >= TUNNEL_CONSTANTS.CRASH_LIMIT) { audit('tunnel_crash_loop'); alarm('crash-loop'); return fail('crash-loop'); }
    return scheduleRetry(classification);
  };

  const runReadyProbe = async token => {
    if (token !== generation || !child || stopping || state === 'paused') return;
    let ready;
    try { ready = await (options.probeReady || probeReady)(metricsPort, options); } catch { ready = { ok: false, state: 'waiting' }; }
    if (!ready || typeof ready !== 'object') ready = { ok: false, state: 'waiting' };
    if (token !== generation || !child || stopping) return;
    if (ready.ok) { if (readySince === null) readySince = now(); state = 'checking-public'; }
    else if (now() - readyStartedAt >= 30_000) { readySince = 'fallback'; state = 'checking-public'; }
    setTimer('ready', () => runReadyProbe(token), TUNNEL_CONSTANTS.READY_POLL_MS);
  };
  const runPublicProbe = async token => {
    if (token !== generation || !child || stopping || state === 'paused') return;
    let response;
    try { response = await (options.publicProbeFn || publicProbe)(options.hostname, options); } catch { response = { ok: false, code: 'edge-unreachable' }; }
    if (!response || typeof response !== 'object') response = { ok: false, code: 'edge-unreachable' };
    if (token !== generation || !child || stopping) return;
    probeCount++;
    if (probeCount % 10 === 0) {
      let auditReap;
      try { auditReap = await (options.reapOrphans || reapOrphans)({ userData: options.userData, configPath: paths.config, ...options }); } catch { auditReap = { notices: ['ps-failed'] }; }
      if (auditReap?.notices?.length) audit('tunnel_reap_audit', { notices: auditReap.notices });
      if (token !== generation || !child || stopping) return;
    }
    if (response.ok) {
      publicFailures = 0; state = 'online';
      if (readySince && readySince !== 'fallback' && now() - readySince >= 120_000) { crashTimes = []; backoffAttempts = 0; }
      setTimer('public', () => runPublicProbe(token), 60_000);
      return;
    }
    publicFailures++;
    if (response.code === 'hostname-not-public') { generation++; await stopInternal('probe-failed'); return fail('hostname-not-public'); }
    if (response.code === 'tunnel-not-serving' && now() - lastProbeRestartAt >= 10 * 60_000) {
      lastProbeRestartAt = now(); generation++;
      const stopped = await stopInternal('probe-restart');
      if (stopped.ok && !stopping) void start();
      return;
    }
    if (publicFailures >= 3) state = 'degraded'; else state = readySince ? 'checking-public' : 'connecting';
    // First discovery is intentionally brisk; once the 30s window is over the
    // long cadence avoids turning a persistent edge outage into a restart loop.
    setTimer('public', () => runPublicProbe(token), publicFailures < 6 ? TUNNEL_CONSTANTS.PUBLIC_PROBE_MS : 60_000);
  };
  const scheduleProbes = token => {
    readyStartedAt = now(); readySince = null; publicFailures = 0; probeCount = 0;
    if (!setTimer('ready', () => runReadyProbe(token), TUNNEL_CONSTANTS.READY_POLL_MS)) return false;
    return setTimer('public', () => runPublicProbe(token), TUNNEL_CONSTANTS.PUBLIC_PROBE_INITIAL_MS);
  };

  const startInternal = async () => {
    if (child || state === 'starting' || state === 'connecting' || state === 'online' || state === 'checking-public') return result(true);
    const token = ++generation; stopping = false; state = 'starting';
    const userData = options.userData;
    if (typeof userData !== 'string' || !userData.startsWith('/') || userData.includes('\u0000') || userData.includes('/../')) return fail('config-rejected');
    try { await (options.ensureTunnelDirectory || ensureTunnelDirectory)(userData, options); } catch { return fail('config-rejected'); }
    const reaped = await (options.reapOrphans || reapOrphans)({ userData, configPath: paths.config, ...options });
    if (token !== generation) return result(false, 'cancelled');
    if (reaped?.notices?.includes('orphan-stuck')) return fail('owned-elsewhere');
    for (const notice of reaped?.notices || []) if (['foreign-connector', 'cert-present', 'binary-old'].includes(notice)) notices.add(notice);
    const credentials = (options.inspectCredentials || inspectCredentials)(options.credentialsPath, options);
    if (!credentials?.ok) return fail(credentials?.code || 'credentials-invalid');
    const checkLegacyCert = options.legacyCertPresent || (fsImpl ? legacyCertPresent : () => false);
    if (checkLegacyCert(credentials.credentialsPath, options)) notices.add('cert-present');
    if (Number.isFinite(options.approvedAt) && now() - options.approvedAt >= 180 * 24 * 60 * 60_000) notices.add('binary-old');
    if (!/^[0-9a-f]{64}$/.test(options.pin || '') && !options.prepareBinary) return fail('binary-untrusted');
    let binary = null;
    if (options.pin && !options.prepareBinary) binary = (options.findApprovedCopy || findApprovedCopy)({ userData, pin: options.pin }, options);
    if (!binary?.ok) {
      if (options.pin && binary?.code && binary.code !== 'binary-copy-missing') return fail(binary.code);
      const sourcePath = (options.findBinary || findBinary)(options.binaryPath, options);
      if (!sourcePath) return fail('binary-not-found');
      binary = await (options.prepareBinary || prepareBinary)({ userData, sourcePath, pin: options.pin, tunnelId: credentials.tunnelId, testMode: options.testMode === true }, { ...production, ...options });
    }
    if (!binary?.ok) return fail(binary?.code || 'binary-copy-failed');
    const port = (options.chooseMetricsPort || chooseMetricsPort)({ ...options, attempted: attemptedPorts });
    if (!port) return fail('spawn-failed');
    metricsPort = port;
    const text = renderTunnelConfig({ tunnelId: credentials.tunnelId, hostname: options.hostname, credentialsPath: credentials.credentialsPath, socketPath: options.socketPath });
    if (!text) return fail('config-rejected');
    try {
      (options.atomicWriteText || atomicWriteText)(paths.config, text, options);
      const reader = options.readConfig || fsImpl?.readFileSync;
      if (reader && reader(paths.config, 'utf8') !== text) throw Object.assign(new Error('reread'), { code: 'config-rejected' });
    } catch { return fail('config-rejected'); }
    const dry = buildDryRunArgv({ configPath: paths.config, hostname: options.hostname });
    if (!dry) return fail('config-rejected');
    const dryRun = options.dryRun || (async (copy, args) => {
      try { return { ok: true, output: execBinary(copy, args, { ...options, cwd: paths.root, env: buildChildEnv(options), timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }) }; }
      catch (error) { const output = String(error?.output || ''); return { ok: false, output, code: /flag provided but not defined/.test(output) ? 'flag-rejected' : 'config-rejected' }; }
    });
    const outputs = [];
    for (const args of dry) {
      const answer = await dryRun(binary.copyPath, args);
      if (token !== generation) return result(false, 'cancelled');
      const output = String(answer?.output || ''); outputs.push(output);
      if (!answer?.ok) return fail(answer?.code || (/flag provided but not defined/.test(output) ? 'flag-rejected' : 'config-rejected'));
      if (/flag provided but not defined/.test(output)) return fail('flag-rejected');
    }
    if (!validateDryRunOutput({ configPath: paths.config, hostname: options.hostname, socketPath: options.socketPath, validationOutput: outputs[0], matchingRuleOutput: outputs[1], fallbackRuleOutput: outputs[2] })) return fail('config-rejected');
    if (!(options.verifyPinnedCopy || verifyPinnedCopy)(binary.copyPath, options.pin, options).ok) return fail('binary-changed');
    try { (options.recordTunnelIntent || recordTunnelIntent)(userData, { pid: null, configPath: paths.config, createdAt: now() }, options); } catch { return fail('spawn-failed'); }
    const args = buildRunArgv({ configPath: paths.config, tunnelId: credentials.tunnelId, metricsPort });
    currentExitLines = [];
    const onLine = line => {
      log.add(line);
      currentExitLines.push(line);
      if (currentExitLines.length > 30) currentExitLines.shift();
    };
    try { child = (options.spawnCloudflared || spawnCloudflared)({ binaryPath: binary.copyPath, args, cwd: paths.root, env: buildChildEnv(options), spawnImpl: options.spawnImpl, onLine, redactContext: { home: options.HOME, userData, hostname: options.hostname } }); } catch { removeIntent(); return fail('spawn-failed'); }
    const spawned = child;
    const abandonSpawn = code => { handledExitToken = token; killSpawnedGroup(spawned); if (child === spawned) child = null; removeIntent(); return fail(code); };
    try {
      spawned.once?.('error', () => { if (token === generation && !stopping && handledExitToken !== token) void enqueue(() => onExit(token, null, 'ERROR')); });
      spawned.once?.('exit', (code, signal) => { if (handledExitToken !== token) void enqueue(() => onExit(token, code, signal)); });
    } catch { return abandonSpawn('spawn-failed'); }
    let processInfo;
    try { processInfo = await (options.getProcessInfo || production.getProcessInfo)(spawned.pid); } catch { return abandonSpawn('spawn-failed'); }
    if (token !== generation || !processInfo || processInfo.pid !== spawned.pid || processInfo.pgid !== spawned.pid) return abandonSpawn('spawn-failed');
    try { (options.recordTunnelIntent || recordTunnelIntent)(userData, { pid: spawned.pid, pgid: processInfo.pgid, lstart: processInfo.lstart, configPath: paths.config, createdAt: now() }, options); } catch { return abandonSpawn('spawn-failed'); }
    if (token !== generation) return abandonSpawn('cancelled');
    state = 'connecting';
    if (!scheduleProbes(token)) return result(false, 'spawn-failed');
    return result(true);
  };

  const stopInternal = async reason => {
    stopping = true; clearAllTimers();
    const current = child;
    if (!current) { state = reason === 'pause' ? 'paused' : 'off'; return result(true); }
    state = 'stopping';
    const wait = options.wait || (ms => new Promise(resolve => { try { timers.setTimeout(resolve, ms); } catch { resolve(); } }));
    const safeWait = async ms => { try { await wait(ms); } catch { /* still advance the signal ladder */ } };
    const alive = () => current.exitCode === null && current.signalCode === null;
    const signal = value => {
      let sent = false;
      try { sent = (options.signalGroup || signalGroup)(current.pid, value, { kill: options.kill }); } catch { /* fall through to child.kill */ }
      if (!sent) try { return current.kill?.(value) === true; } catch { return false; }
      return true;
    };
    signal('SIGTERM'); await safeWait(1500); if (alive()) { signal('SIGTERM'); await safeWait(2500); } if (alive()) { signal('SIGKILL'); await safeWait(1500); }
    if (alive()) { state = 'failed'; stopping = false; return result(false, 'stop-stuck'); }
    child = null; removeIntent(); state = reason === 'pause' ? 'paused' : 'off'; stopping = false; return result(true);
  };
  const start = () => { clearTimer('retry'); return enqueue(startInternal); };
  const requestStop = reason => { generation++; clearAllTimers(); return enqueue(() => stopInternal(reason)); };
  const stop = () => requestStop('stop');
  const pause = () => requestStop('pause');
  const resume = () => enqueue(async () => { if (state !== 'paused') return result(false, 'busy'); return startInternal(); });
  const restart = () => {
    if (now() - lastManualRestartAt < 5000) return Promise.resolve(result(false, 'busy'));
    lastManualRestartAt = now(); generation++; clearAllTimers(); return enqueue(async () => { const stopped = await stopInternal('restart'); return stopped.ok ? startInternal() : stopped; });
  };
  return Object.freeze({ start, stop, pause, resume, restart, dispose: stop, status, probe: () => enqueue(async () => { const token = generation; await runReadyProbe(token); await runPublicProbe(token); return { status: status() }; }) });
}
