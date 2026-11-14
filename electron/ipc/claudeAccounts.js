// Signed-in Claude accounts, each one a CLAUDE_CONFIG_DIR. The default account is
// the machine's own CLI login; added accounts live under the app's user data and
// share the default account's projects folder so a resumed session still exists.
import crypto from 'node:crypto';
import { spawn as spawnDefault } from 'node:child_process';
import fsDefault from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electronPkg from 'electron';

export const DEFAULT_CLAUDE_ACCOUNT_ID = 'default';
export const CLAUDE_ACCOUNTS_DIR = 'claude-accounts';
const REGISTRY_FILE = 'accounts.json';
const REGISTRY_VERSION = 1;
const ACCOUNT_ID_RE = /^acct-[a-f0-9]{8}$/u;
const STATUS_TTL_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LIMIT_GRACE_MS = 60_000;
const LIMIT_PROBE_MS = 10 * 60_000;
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_EMAIL_LENGTH = 200;
const MAX_SUBSCRIPTION_LENGTH = 40;
const LIMIT_TYPES = new Set([
  'five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage',
]);

export const CLAUDE_ACCOUNT_LIMIT_TYPES = Object.freeze([...LIMIT_TYPES]);

const limitTypeOf = value => (typeof value === 'string' && LIMIT_TYPES.has(value) ? value : null);
const cleanText = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

function executableExists(fs, filePath) {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findClaudeBinary({ env = process.env, home = os.homedir(), fs = fsDefault } = {}) {
  const candidates = [];
  for (const entry of String(env?.PATH || '').split(path.delimiter)) if (entry) candidates.push(path.join(entry, 'claude'));
  if (home) candidates.push(path.join(home, '.local', 'bin', 'claude'));
  candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  return candidates.find(candidate => executableExists(fs, candidate)) || null;
}

function parseAuthStatus(text) {
  let parsed = null;
  try { parsed = JSON.parse(String(text ?? '')); } catch { return { loggedIn: null, email: null, subscriptionType: null }; }
  return {
    loggedIn: parsed?.loggedIn === true,
    email: cleanText(parsed?.email, MAX_EMAIL_LENGTH),
    subscriptionType: cleanText(parsed?.subscriptionType, MAX_SUBSCRIPTION_LENGTH),
  };
}

const sameEmail = (left, right) => Boolean(left && right) && left.toLowerCase() === right.toLowerCase();

// Shown to the person adding an account; never carries an email or a path.
const LOGIN_MESSAGES = {
  busy: 'Another Claude sign-in is already in progress.',
  'cli-missing': 'Claude Code is not installed or not on PATH.',
  timeout: 'The Claude sign-in timed out.',
  duplicate: 'That Claude account is already added.',
  cancelled: 'The Claude sign-in was cancelled.',
  failed: 'The Claude sign-in did not finish.',
};

const loginFailure = reason => ({ ok: false, reason, message: LOGIN_MESSAGES[reason] || LOGIN_MESSAGES.failed });

export function createClaudeAccounts({
  userDataDir = () => electronPkg.app?.getPath?.('userData') || '',
  home = os.homedir(),
  env = process.env,
  fs = fsDefault,
  spawn = spawnDefault,
  binary = null,
  now = () => Date.now(),
  setTimer = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clearTimer = clearTimeout,
  findBinary = () => findClaudeBinary({ env, home, fs }),
} = {}) {
  const inheritedConfigDir = typeof env?.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : '';
  let registry = null;
  let login = null;
  let cachedList = null;
  const statusCache = new Map();
  const statusPending = new Map();
  const limits = new Map();
  const listeners = new Set();

  const rootDir = () => (userDataDir() ? path.join(String(userDataDir()), CLAUDE_ACCOUNTS_DIR) : '');
  const registryPath = () => (rootDir() ? path.join(rootDir(), REGISTRY_FILE) : '');
  const defaultDir = () => inheritedConfigDir || path.join(home, '.claude');
  const binaryPath = () => binary || findBinary();

  function notify() {
    cachedList = null;
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* one listener cannot break the registry */ }
    }
  }

  function normalizeRegistry(parsed) {
    const seen = new Set();
    const accounts = (Array.isArray(parsed?.accounts) ? parsed.accounts : [])
      .filter(entry => typeof entry?.id === 'string' && ACCOUNT_ID_RE.test(entry.id)
        && typeof entry?.dir === 'string' && entry.dir)
      .filter((entry) => { if (seen.has(entry.id)) return false; seen.add(entry.id); return true; })
      .map(entry => ({ id: entry.id, dir: entry.dir, addedAt: Number.isFinite(entry.addedAt) ? entry.addedAt : null }));
    const activeId = accounts.some(entry => entry.id === parsed?.activeId) ? parsed.activeId : null;
    return { activeId, accounts };
  }

  function loadRegistry() {
    if (!registry) {
      let parsed = null;
      // Without Electron's user data folder there is nowhere to keep added accounts.
      try { if (rootDir()) parsed = JSON.parse(fs.readFileSync(registryPath(), 'utf8')); } catch { parsed = null; }
      registry = normalizeRegistry(parsed);
    }
    return registry;
  }

  function persistRegistry() {
    const state = loadRegistry();
    if (!rootDir()) return false;
    try { fs.mkdirSync(rootDir(), { recursive: true }); } catch { return false; }
    const target = registryPath();
    const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify({ version: REGISTRY_VERSION, activeId: state.activeId, accounts: state.accounts }, null, 2)}\n`, 'utf8');
      fs.renameSync(temp, target);
      return true;
    } catch {
      try { fs.unlinkSync(temp); } catch { /* nothing left to clean */ }
      return false;
    }
  }

  function removeDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  function listEntries() {
    const state = loadRegistry();
    return [{ id: DEFAULT_CLAUDE_ACCOUNT_ID, dir: defaultDir() }, ...state.accounts.map(entry => ({ id: entry.id, dir: entry.dir }))];
  }

  function entryFor(accountId) {
    return typeof accountId === 'string' ? listEntries().find(entry => entry.id === accountId) || null : null;
  }

  function accountEnv(dir) {
    const out = {};
    for (const [key, value] of Object.entries(env || {})) {
      if (key === 'CLAUDECODE' || key === 'CLAUDE_CODE_ENTRYPOINT') continue;
      out[key] = value;
    }
    out.CLAUDE_CONFIG_DIR = dir;
    return out;
  }

  function runAuthStatus(dir) {
    return new Promise((resolve) => {
      const unknown = { loggedIn: null, email: null, subscriptionType: null };
      const executable = binaryPath();
      if (!executable) { resolve(unknown); return; }
      let settled = false;
      let child = null;
      const chunks = [];
      let bytes = 0;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(value);
      };
      const timer = setTimer(() => {
        try { child?.kill?.('SIGKILL'); } catch { /* already gone */ }
        finish(unknown);
      }, STATUS_TIMEOUT_MS);
      try {
        child = spawn(executable, ['auth', 'status'], { env: accountEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        finish(unknown);
        return;
      }
      child.stdout?.on?.('error', () => {});
      child.stderr?.on?.('error', () => {});
      child.stdout?.on?.('data', (chunk) => {
        if (bytes >= MAX_STATUS_BYTES) return;
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        chunks.push(buffer);
      });
      child.on?.('error', () => finish(unknown));
      child.on?.('close', code => finish(code === 0 ? parseAuthStatus(Buffer.concat(chunks).toString('utf8')) : unknown));
    });
  }

  function refreshStatus(accountId) {
    const cached = statusCache.get(accountId);
    if (cached && now() - cached.at < STATUS_TTL_MS) return Promise.resolve(cached.status);
    if (statusPending.has(accountId)) return statusPending.get(accountId);
    const entry = entryFor(accountId);
    if (!entry) return Promise.resolve({ loggedIn: null, email: null, subscriptionType: null });
    const pending = runAuthStatus(entry.dir)
      .then((status) => {
        const before = statusCache.get(accountId)?.status;
        statusCache.set(accountId, { at: now(), status });
        cachedList = null;
        // A changed sign-in or email must reach the dock and settings, which only see pushes.
        const changed = !before || before.loggedIn !== status.loggedIn || before.email !== status.email
          || before.subscriptionType !== status.subscriptionType;
        if (changed) notify();
        return status;
      })
      .finally(() => { statusPending.delete(accountId); });
    statusPending.set(accountId, pending);
    return pending;
  }

  const isLimited = (accountId, at = now()) => (limits.get(accountId)?.limitedUntil ?? 0) > at;

  function isEligible(entry, at = now()) {
    if (isLimited(entry.id, at)) return false;
    const status = statusCache.get(entry.id)?.status;
    return status?.loggedIn !== false;
  }

  function activeId() {
    const state = loadRegistry();
    const entries = listEntries();
    const at = now();
    const persisted = state.activeId ? entries.find(entry => entry.id === state.activeId) : null;
    if (persisted && isEligible(persisted, at)) return persisted.id;
    const eligible = entries.find(entry => isEligible(entry, at));
    if (eligible) return eligible.id;
    return persisted ? persisted.id : DEFAULT_CLAUDE_ACCOUNT_ID;
  }

  function accountItem(entry, active) {
    const status = statusCache.get(entry.id)?.status ?? null;
    const limit = limits.get(entry.id) ?? null;
    return {
      id: entry.id,
      isDefault: entry.id === DEFAULT_CLAUDE_ACCOUNT_ID,
      active: entry.id === active,
      loggedIn: typeof status?.loggedIn === 'boolean' ? status.loggedIn : null,
      email: typeof status?.email === 'string' ? status.email : null,
      subscriptionType: typeof status?.subscriptionType === 'string' ? status.subscriptionType : null,
      limitedUntil: limit && Number.isFinite(limit.limitedUntil) ? limit.limitedUntil : null,
      limitType: limit?.limitType ?? null,
    };
  }

  function items() {
    const active = activeId();
    return listEntries().map(entry => accountItem(entry, active));
  }

  async function listClaudeAccounts({ refresh = true } = {}) {
    if (refresh) await Promise.all(listEntries().map(entry => refreshStatus(entry.id)));
    const list = items();
    cachedList = list;
    return list;
  }

  /** The last computed list, for synchronous snapshots. Never spawns the CLI. */
  function listClaudeAccountsCached() {
    if (!cachedList) cachedList = items();
    return cachedList;
  }

  function limitState() {
    const list = listClaudeAccountsCached();
    const at = now();
    const limited = [];
    for (const item of list) {
      if (item.limitedUntil === null || item.limitedUntil <= at) continue;
      const recorded = limits.get(item.id);
      limited.push({ id: item.id, limitedUntil: item.limitedUntil, resetsAt: Number.isFinite(recorded?.resetsAt) ? recorded.resetsAt : null, limitType: item.limitType });
    }
    return {
      accountCount: list.length,
      activeId: list.find(item => item.active)?.id ?? DEFAULT_CLAUDE_ACCOUNT_ID,
      accounts: list,
      limited,
      eligible: list.filter(item => !(item.limitedUntil !== null && item.limitedUntil > at) && item.loggedIn !== false),
    };
  }

  function applyClaudeAccountEnv(childEnv = {}) {
    const accountId = activeId();
    const entry = entryFor(accountId) || { id: DEFAULT_CLAUDE_ACCOUNT_ID, dir: defaultDir() };
    const out = { ...(childEnv || {}) };
    if (entry.id === DEFAULT_CLAUDE_ACCOUNT_ID && !inheritedConfigDir) delete out.CLAUDE_CONFIG_DIR;
    else out.CLAUDE_CONFIG_DIR = entry.dir;
    return { env: out, accountId: entry.id };
  }

  function markClaudeAccountLimited(accountId, { resetsAt = null, limitType = null } = {}) {
    const at = now();
    const target = entryFor(accountId) ? accountId : activeId();
    const limitedUntil = Number.isFinite(resetsAt) && resetsAt > at ? resetsAt + LIMIT_GRACE_MS : at + LIMIT_PROBE_MS;
    limits.set(target, {
      limitedUntil,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
      limitType: limitTypeOf(limitType),
    });
    const state = loadRegistry();
    const next = listEntries().find(entry => entry.id !== target && isEligible(entry, at));
    const switched = Boolean(next && next.id !== state.activeId && next.id !== target);
    if (switched) {
      state.activeId = next.id;
      persistRegistry();
    }
    notify();
    return { nextAccountId: switched ? next.id : null, accountId: target, limitedUntil, limitType: limitTypeOf(limitType) };
  }

  function clearClaudeAccountLimits() {
    if (!limits.size) return false;
    limits.clear();
    notify();
    return true;
  }

  function linkProjects(accountDir) {
    const target = path.join(defaultDir(), 'projects');
    try { fs.mkdirSync(target, { recursive: true }); } catch { /* the link is the part that matters */ }
    const link = path.join(accountDir, 'projects');
    try {
      if (fs.existsSync(link) || fs.lstatSync(link)) return true;
    } catch { /* nothing there yet */ }
    try { fs.symlinkSync(target, link, 'dir'); return true; } catch { return false; }
  }

  function addClaudeAccount() {
    if (login) return Promise.resolve(loginFailure('busy'));
    const executable = binaryPath();
    if (!executable) return Promise.resolve(loginFailure('cli-missing'));
    const id = `acct-${crypto.randomBytes(4).toString('hex')}`;
    const dir = path.join(rootDir(), id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      linkProjects(dir);
    } catch {
      removeDir(dir);
      return Promise.resolve(loginFailure('failed'));
    }
    return new Promise((resolve) => {
      const state = { id, dir, child: null, cancelled: false, settled: false, timer: null };
      const settle = (value) => {
        if (state.settled) return;
        state.settled = true;
        clearTimer(state.timer);
        if (login === state) login = null;
        resolve(value);
      };
      const fail = (reason) => {
        if (state.cancelled) return;
        removeDir(dir);
        settle(loginFailure(reason));
      };
      login = state;
      const kill = () => { try { state.child?.kill?.('SIGKILL'); } catch { /* already gone */ } };
      const finishLogin = async (exitCode) => {
        if (state.settled || state.cancelled) return;
        const status = exitCode === 0 ? await runAuthStatus(dir) : null;
        if (state.settled || state.cancelled) return;
        if (!status || status.loggedIn !== true) { fail('failed'); return; }
        await Promise.all(listEntries().map(entry => refreshStatus(entry.id)));
        if (state.settled || state.cancelled) return;
        const duplicate = listEntries().some(entry => entry.id !== id && sameEmail(statusCache.get(entry.id)?.status?.email, status.email));
        if (duplicate) { fail('duplicate'); return; }
        statusCache.set(id, { at: now(), status });
        loadRegistry().accounts.push({ id, dir, addedAt: now() });
        persistRegistry();
        notify();
        settle({ ok: true, account: accountItem({ id, dir }, activeId()) });
      };
      state.timer = setTimer(() => { kill(); fail('timeout'); }, LOGIN_TIMEOUT_MS);
      state.cancel = () => {
        if (state.settled) return;
        state.cancelled = true;
        kill();
        removeDir(dir);
        settle(loginFailure('cancelled'));
      };
      try {
        state.child = spawn(executable, ['auth', 'login', '--claudeai'], { env: accountEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        fail('failed');
        return;
      }
      // The login prints instructions and may wait on a browser callback; none of it is kept.
      state.child.stdout?.on?.('data', () => {});
      state.child.stderr?.on?.('data', () => {});
      state.child.stdout?.on?.('error', () => {});
      state.child.stderr?.on?.('error', () => {});
      state.child.on?.('error', () => fail('failed'));
      state.child.on?.('close', code => { void finishLogin(code); });
    });
  }

  function cancelClaudeAccountLogin() {
    const pending = login;
    if (!pending) return { ok: true };
    pending.cancel?.();
    return { ok: true };
  }

  function removeClaudeAccount(accountId) {
    if (accountId === DEFAULT_CLAUDE_ACCOUNT_ID) return { ok: false, reason: 'default' };
    const entry = entryFor(accountId);
    if (!entry) return { ok: false, reason: 'unknown' };
    removeDir(entry.dir);
    const state = loadRegistry();
    state.accounts = state.accounts.filter(item => item.id !== accountId);
    statusCache.delete(accountId);
    limits.delete(accountId);
    if (state.activeId === accountId) state.activeId = null;
    if (!state.activeId) {
      const next = listEntries().find(item => isEligible(item));
      state.activeId = next ? next.id : null;
    }
    persistRegistry();
    notify();
    return { ok: true };
  }

  function subscribeClaudeAccounts(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    defaultDir,
    activeClaudeAccountId: activeId,
    listClaudeAccounts,
    listClaudeAccountsCached,
    applyClaudeAccountEnv,
    markClaudeAccountLimited,
    clearClaudeAccountLimits,
    claudeAccountLimitState: limitState,
    addClaudeAccount,
    cancelClaudeAccountLogin,
    removeClaudeAccount,
    subscribeClaudeAccounts,
    refreshClaudeAccountStatus: refreshStatus,
  };
}

const production = createClaudeAccounts();

export const listClaudeAccounts = options => production.listClaudeAccounts(options);
export const listClaudeAccountsCached = () => production.listClaudeAccountsCached();
export const activeClaudeAccountId = () => production.activeClaudeAccountId();
export const applyClaudeAccountEnv = env => production.applyClaudeAccountEnv(env);
export const markClaudeAccountLimited = (accountId, limit) => production.markClaudeAccountLimited(accountId, limit);
export const clearClaudeAccountLimits = () => production.clearClaudeAccountLimits();
export const claudeAccountLimitState = () => production.claudeAccountLimitState();
export const addClaudeAccount = () => production.addClaudeAccount();
export const cancelClaudeAccountLogin = () => production.cancelClaudeAccountLogin();
export const removeClaudeAccount = accountId => production.removeClaudeAccount(accountId);
export const subscribeClaudeAccounts = listener => production.subscribeClaudeAccounts(listener);
export const refreshClaudeAccountStatus = accountId => production.refreshClaudeAccountStatus(accountId);
