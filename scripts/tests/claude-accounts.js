import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeAccounts } from '../../electron/ipc/claudeAccounts.js';

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-accounts-'));

/** A CLI stand-in: `auth status` answers JSON, `auth login` exits as told. */
function fakeCli({ statusFor = () => null, login = () => ({ code: 0 }) } = {}) {
  const calls = [];
  const spawn = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null)); };
    calls.push({ binary, args, options, child });
    if (args[0] === 'auth' && args[1] === 'status') {
      const status = statusFor(options.env.CLAUDE_CONFIG_DIR);
      queueMicrotask(() => {
        if (status) child.stdout.emit('data', Buffer.from(JSON.stringify(status)));
        child.emit('close', status ? 0 : 1);
      });
    } else if (args[0] === 'auth' && args[1] === 'login') {
      const behaviour = login(options.env.CLAUDE_CONFIG_DIR);
      if (behaviour.action !== 'wait') setTimeout(() => child.emit('close', behaviour.code ?? 0), 0);
    }
    return child;
  };
  return { spawn, calls };
}

function fixture({ statusFor, login, env = {}, binary = '/fake/bin/claude', findBinary = () => null } = {}) {
  const root = tempRoot();
  const userDataDir = path.join(root, 'user-data');
  const home = path.join(root, 'home');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const cli = fakeCli({ statusFor, login });
  const timers = [];
  let clock = 1_700_000_000_000;
  const accounts = createClaudeAccounts({
    userDataDir: () => userDataDir,
    home,
    env,
    binary,
    findBinary,
    spawn: cli.spawn,
    now: () => clock,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cleared = true; },
  });
  return {
    root, userDataDir, home, cli, timers, accounts,
    defaultDir: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    advance: ms => { clock += ms; },
    fireTimer: (ms) => { const timer = timers.find(item => item.ms === ms && !item.cleared); assert.ok(timer, `no armed timer of ${ms} ms`); timer.cleared = true; timer.fn(); },
  };
}

const registryOf = (userDataDir) => JSON.parse(fs.readFileSync(path.join(userDataDir, 'claude-accounts', 'accounts.json'), 'utf8'));
const loggedIn = (email, subscriptionType = 'max') => () => ({ loggedIn: true, email, subscriptionType });

function assertRefused(result, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  assert.equal(typeof result.message, 'string', 'a refusal carries a person-readable message');
}

export default [
  {
    name: 'claude accounts: the default account alone, in contract shape and without paths',
    async run() {
      const f = fixture({ binary: null });
      const list = await f.accounts.listClaudeAccounts();
      assert.equal(list.length, 1);
      assert.deepEqual(list[0], {
        id: 'default', isDefault: true, active: true, loggedIn: null, email: null,
        subscriptionType: null, limitedUntil: null, limitType: null,
      });
      assert.equal(f.accounts.activeClaudeAccountId(), 'default');
      assert.deepEqual(f.accounts.removeClaudeAccount('default'), { ok: false, reason: 'default' });
      assert.equal(f.cli.calls.length, 0, 'a missing CLI answers unknown rather than spawning');
    },
  },
  {
    name: 'claude accounts: add signs in, shares projects with the default account and persists',
    async run() {
      const f = fixture({ statusFor: (dir) => (dir.startsWith(path.join(f.userDataDir, 'claude-accounts')) ? { loggedIn: true, email: 'second@example.com', subscriptionType: 'pro' } : { loggedIn: true, email: 'first@example.com', subscriptionType: 'max' }) });
      fs.mkdirSync(path.join(f.defaultDir, 'projects'), { recursive: true });
      fs.writeFileSync(path.join(f.defaultDir, 'projects', 'session.jsonl'), '{}\n');
      const added = await f.accounts.addClaudeAccount();
      assert.equal(added.ok, true);
      assert.equal(added.account.email, 'second@example.com');
      assert.equal(added.account.isDefault, false);
      const dir = path.join(f.userDataDir, 'claude-accounts', added.account.id);
      assert.equal(fs.lstatSync(path.join(dir, 'projects')).isSymbolicLink(), true);
      assert.equal(fs.realpathSync(path.join(dir, 'projects')), fs.realpathSync(path.join(f.defaultDir, 'projects')));
      const registry = registryOf(f.userDataDir);
      assert.equal(registry.version, 1);
      assert.deepEqual(registry.accounts.map(entry => entry.id), [added.account.id]);
      const login = f.cli.calls.find(call => call.args[1] === 'login');
      assert.equal(login.args[2], '--claudeai');
      assert.equal(login.options.env.CLAUDE_CONFIG_DIR, dir);
      // Removing the added account drops its folder but never the default history.
      assert.deepEqual(f.accounts.removeClaudeAccount(added.account.id), { ok: true });
      assert.equal(fs.existsSync(dir), false);
      assert.equal(fs.existsSync(path.join(f.defaultDir, 'projects', 'session.jsonl')), true);
      const list = await f.accounts.listClaudeAccounts();
      assert.deepEqual(list.map(item => item.id), ['default']);
    },
  },
  {
    name: 'claude accounts: a duplicate email, an unsigned login, a cancel and a timeout are refused',
    async run() {
      const f = fixture({ statusFor: loggedIn('First@Example.com'), login: () => ({ code: 0 }) });
      const duplicate = await f.accounts.addClaudeAccount();
      assertRefused(duplicate, 'duplicate');
      assert.equal(fs.existsSync(path.join(f.userDataDir, 'claude-accounts')), true);
      assert.deepEqual(fs.readdirSync(path.join(f.userDataDir, 'claude-accounts')).filter(name => name.startsWith('acct-')), []);
      await f.accounts.listClaudeAccounts();

      const signedOut = fixture({ statusFor: () => ({ loggedIn: false }), login: () => ({ code: 0 }) });
      assertRefused(await signedOut.accounts.addClaudeAccount(), 'failed');

      const cancelled = fixture({ statusFor: loggedIn('x@example.com'), login: () => ({ action: 'wait' }) });
      const pending = cancelled.accounts.addClaudeAccount();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(cancelled.accounts.cancelClaudeAccountLogin(), { ok: true });
      assertRefused(await pending, 'cancelled');
      assert.equal(cancelled.cli.calls.find(call => call.args[1] === 'login').child.killed, true);

      const timedOut = fixture({ statusFor: loggedIn('y@example.com'), login: () => ({ action: 'wait' }) });
      const waiting = timedOut.accounts.addClaudeAccount();
      await new Promise(resolve => setImmediate(resolve));
      timedOut.fireTimer(10 * 60_000);
      assertRefused(await waiting, 'timeout');

      const missing = fixture({ binary: null });
      assertRefused(await missing.accounts.addClaudeAccount(), 'cli-missing');
    },
  },
  {
    name: 'claude accounts: a limited active account is skipped and the switch is persisted',
    async run() {
      const f = fixture({ statusFor: loggedIn('second@example.com') });
      const id = 'acct-0123abcd';
      const dir = path.join(f.userDataDir, 'claude-accounts', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(f.userDataDir, 'claude-accounts', 'accounts.json'), JSON.stringify({
        version: 1, activeId: null, accounts: [{ id, dir, addedAt: 1 }],
      }));
      const list = await f.accounts.listClaudeAccounts();
      assert.deepEqual(list.map(item => item.id), ['default', id]);
      assert.equal(list[0].active, true, 'the default account is active until it is limited');
      const resetsAt = 1_700_000_000_000 + 5 * 60_000;
      const marked = f.accounts.markClaudeAccountLimited('default', { resetsAt, limitType: 'five_hour' });
      assert.deepEqual(marked, { nextAccountId: id, accountId: 'default', limitedUntil: resetsAt + 60_000, limitType: 'five_hour' });
      assert.equal(f.accounts.activeClaudeAccountId(), id);
      assert.equal(registryOf(f.userDataDir).activeId, id);
      const after = f.accounts.listClaudeAccountsCached();
      assert.equal(after[0].limitedUntil, resetsAt + 60_000);
      assert.equal(after[0].limitType, 'five_hour');
      assert.equal(after[1].active, true);
      // An unknown window name is dropped, and clearing brings the default back.
      f.accounts.markClaudeAccountLimited(id, { resetsAt: null, limitType: 'not-a-window' });
      assert.equal(f.accounts.listClaudeAccountsCached()[1].limitType, null);
      assert.equal(f.accounts.listClaudeAccountsCached()[1].limitedUntil, 1_700_000_000_000 + 10 * 60_000);
      f.accounts.clearClaudeAccountLimits();
      assert.equal(f.accounts.activeClaudeAccountId(), id, 'the persisted switch survives a cleared limit');
      assert.deepEqual(f.accounts.listClaudeAccountsCached().map(item => item.limitedUntil), [null, null]);
    },
  },
  {
    name: 'claude accounts: the active account decides CLAUDE_CONFIG_DIR',
    async run() {
      const fresh = fixture({ env: {} });
      const cleared = fresh.accounts.applyClaudeAccountEnv({ KEEP: 'yes' });
      assert.deepEqual(cleared, { env: { KEEP: 'yes' }, accountId: 'default' });

      const inherited = fixture({ env: { CLAUDE_CONFIG_DIR: '/custom/config' } });
      const kept = inherited.accounts.applyClaudeAccountEnv({});
      assert.equal(kept.accountId, 'default');
      assert.equal(kept.env.CLAUDE_CONFIG_DIR, '/custom/config');

      const f = fixture({ statusFor: loggedIn('second@example.com'), env: { CLAUDE_CONFIG_DIR: '/custom/config' } });
      const id = 'acct-deadbeef';
      const dir = path.join(f.userDataDir, 'claude-accounts', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(f.userDataDir, 'claude-accounts', 'accounts.json'), JSON.stringify({
        version: 1, activeId: id, accounts: [{ id, dir, addedAt: 1 }],
      }));
      const bound = f.accounts.applyClaudeAccountEnv({ CLAUDE_CONFIG_DIR: '/custom/config', KEEP: 'yes' });
      assert.equal(bound.accountId, id);
      assert.equal(bound.env.CLAUDE_CONFIG_DIR, dir);
      assert.equal(bound.env.KEEP, 'yes');
    },
  },
];
