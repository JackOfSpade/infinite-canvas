import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { configPathFor, emptyConfig, forgetConfig, readConfig, writeConfig } from '../../electron/ipc/handoffBridge/store.js';

function withStore(run) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-handoff-store-'));
  return Promise.resolve().then(() => run(userData)).finally(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });
}

async function save(userData, patch, options = {}) {
  return writeConfig(userData, patch, {
    confirmHostnameChange: async () => true,
    ...options,
  });
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function persisted(userData) {
  const result = readConfig(userData);
  assert(result.state === 'ok', 'config must be readable after a successful save');
  return result.config;
}

export default [
  {
    name: 'handoff bridge: store: missing, corrupt and unknown config remain tolerant and read-only',
    run: () => {
      const cases = [
        { name: 'missing', read: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, state: 'missing' },
        { name: 'corrupt', read: () => '{not-json', state: 'unreadable' },
        { name: 'unknown version', read: () => JSON.stringify({ v: 99, hostname: 'bridge.example.com' }), state: 'unreadable' },
      ];
      for (const fixture of cases) {
        let reads = 0;
        const fsImpl = {
          readFileSync: () => { reads++; return fixture.read(); },
          writeFileSync: () => { throw new Error('readConfig must never write'); },
        };
        const result = readConfig('/tmp/ic-handoff-test', { fsImpl });
        assert(reads === 1 && result.state === fixture.state, `${fixture.name} config must be tolerated without a write`);
        assert(result.config.autoStart === false, `${fixture.name} config must resolve to safe defaults`);
      }
      assert(emptyConfig().autoStart === false && emptyConfig().pluginName === 'infinite_canvas',
        'fresh config must preserve auto-start opt-in and a starter-safe plugin name');
    },
  },
  {
    name: 'handoff bridge: store: hostname is confirmed, validated and persisted',
    run: () => withStore(async userData => {
      let confirmations = 0;
      const declined = await save(userData, { hostname: 'bridge.example.com' }, {
        confirmHostnameChange: async () => { confirmations++; return false; },
      });
      assert(declined.code === 'DECLINED' && confirmations === 1, 'any hostname set must require native confirmation');
      assert(readConfig(userData).state === 'missing', 'declined hostname must not create config');
      const invalid = await save(userData, { hostname: 'HTTPS://bridge.example.com' });
      assert(invalid.code === 'INVALID' && invalid.fieldErrors.hostname, 'invalid hostname must name its field');
      const accepted = await save(userData, { hostname: 'bridge.example.com' });
      assert(accepted.ok && persisted(userData).hostname === 'bridge.example.com', 'confirmed hostname must persist');
    }),
  },
  {
    name: 'handoff bridge: store: pluginName is validated and persisted',
    run: () => withStore(async userData => {
      const legacy = { ...emptyConfig(), pluginName: '' };
      fs.mkdirSync(path.dirname(configPathFor(userData)), { recursive: true });
      fs.writeFileSync(configPathFor(userData), JSON.stringify(legacy));
      assert(readConfig(userData).config.pluginName === 'infinite_canvas',
        'a legacy blank plugin name must resolve to the starter-safe default without rewriting the config');
      const invalid = await save(userData, { pluginName: '<bridge>' });
      assert(invalid.code === 'INVALID' && invalid.fieldErrors.pluginName, 'invalid plugin name must be rejected');
      const accepted = await save(userData, { pluginName: 'My Bridge 2' });
      assert(accepted.ok && persisted(userData).pluginName === 'My Bridge 2', 'plugin name must persist');
    }),
  },
  {
    name: 'handoff bridge: store: scope validates both fields and persists a partial patch',
    run: () => withStore(async userData => {
      const invalid = await save(userData, { scope: { applications: 'yes' } });
      assert(invalid.code === 'INVALID' && invalid.fieldErrors['scope.applications'], 'scope type must be rejected');
      const accepted = await save(userData, { scope: { scoring: true } });
      const config = persisted(userData);
      assert(accepted.ok && config.scope.applications && config.scope.scoring, 'scope patch must preserve untouched fields');
    }),
  },
  {
    name: 'handoff bridge: store: marketplace scope defaults false, accepts a raising patch and rejects an unknown scope key',
    run: () => withStore(async userData => {
      assert(emptyConfig().scope.marketplace === false, 'a fresh config must never default marketplace consent on');
      const unknown = await save(userData, { scope: { applications: true, scoring: false, listings: true } });
      assert(unknown.code === 'INVALID' && unknown.fieldErrors.scope, 'an unknown scope key must be rejected rather than silently dropped');
      assert(readConfig(userData).state === 'missing', 'a rejected scope patch must not create config');
      const accepted = await save(userData, { scope: { marketplace: true } });
      const config = persisted(userData);
      assert(accepted.ok && config.scope.marketplace === true && config.scope.applications === true && config.scope.scoring === false,
        'a patch that raises marketplace alone must persist and preserve the untouched fields');
    }),
  },
  {
    name: 'handoff bridge: store: a legacy two-key scope on disk survives and fills the marketplace default',
    run: () => withStore(async userData => {
      // A real user's stored config predates the marketplace field. Write the
      // exact legacy shape directly (bypassing writeConfig, which always
      // persists the current three-key scope) to prove readConfig tolerates
      // it rather than rejecting the whole config the way an unknown key would.
      const legacy = { ...emptyConfig(), scope: { applications: true, scoring: false } };
      fs.mkdirSync(path.dirname(configPathFor(userData)), { recursive: true });
      fs.writeFileSync(configPathFor(userData), JSON.stringify(legacy));
      const result = readConfig(userData);
      assert(result.state === 'ok', 'a legacy two-key scope must not be treated as unreadable');
      assert(result.config.scope.applications === true && result.config.scope.scoring === false && result.config.scope.marketplace === false,
        'the missing marketplace field must fill its safe default rather than rejecting the config');
    }),
  },
  {
    name: 'handoff bridge: store: autoStart and autoRelease are validated and persisted',
    run: () => withStore(async userData => {
      const invalid = await save(userData, { autoStart: 1, autoRelease: 'true' });
      assert(invalid.code === 'INVALID' && invalid.fieldErrors.autoStart && invalid.fieldErrors.autoRelease,
        'both automatic options must require booleans');
      const accepted = await save(userData, { autoStart: true, autoRelease: true });
      const config = persisted(userData);
      assert(accepted.ok && config.autoStart && config.autoRelease, 'automatic options must persist');
    }),
  },
  {
    name: 'handoff bridge: store: every limit validates and persists including the 1440-minute default',
    run: () => withStore(async userData => {
      const badValues = {
        releaseTtlHours: -1,
        chatKeyMaxAgeHours: 1.5,
        idlePauseMinutes: '1440',
        jobsPerChat: 4,
        epochSoftBytes: -1,
        epochHardBytes: Infinity,
      };
      const invalid = await save(userData, { limits: badValues });
      assert(invalid.code === 'INVALID' && Object.keys(invalid.fieldErrors).some(key => key.startsWith('limits.')),
        'invalid limits must report limit field errors');
      const limits = {
        releaseTtlHours: 24,
        chatKeyMaxAgeHours: 12,
        idlePauseMinutes: 1440,
        jobsPerChat: 3,
        epochSoftBytes: 600_000,
        epochHardBytes: 900_000,
      };
      const accepted = await save(userData, { limits });
      const stored = persisted(userData).limits;
      assert(accepted.ok && Object.entries(limits).every(([key, value]) => stored[key] === value),
        'every accepted limit must persist');
    }),
  },
  {
    name: 'handoff bridge: store: limit relationships and unknown nested fields are rejected',
    run: () => withStore(async userData => {
      const relationship = await save(userData, { limits: { epochSoftBytes: 900_001 } });
      assert(relationship.code === 'INVALID' && relationship.fieldErrors.limits,
        'soft budget above hard budget must fail');
      const unknown = await save(userData, { limits: { arbitrary: 1 } });
      assert(unknown.code === 'INVALID' && unknown.fieldErrors.limits, 'unknown limit must fail closed');
    }),
  },
  {
    name: 'handoff bridge: store: prefs are validated and persisted',
    run: () => withStore(async userData => {
      const invalid = await save(userData, { prefs: { sourcePolicy: 'anything', pairingNetworkCheck: 'yes' } });
      assert(invalid.code === 'INVALID' && invalid.fieldErrors['prefs.sourcePolicy'] && invalid.fieldErrors['prefs.pairingNetworkCheck'],
        'each invalid preference must name its field');
      const accepted = await save(userData, { prefs: { sourcePolicy: 'alert', pairingNetworkCheck: false } });
      const prefs = persisted(userData).prefs;
      assert(accepted.ok && prefs.sourcePolicy === 'alert' && prefs.pairingNetworkCheck === false,
        'preferences must persist');
    }),
  },
  {
    name: 'handoff bridge: store: telemetry and consentVersion are validated and persisted',
    run: () => withStore(async userData => {
      const invalid = await save(userData, { telemetryInBugReports: 'yes', consentVersion: -1 });
      assert(invalid.code === 'INVALID' && invalid.fieldErrors.telemetryInBugReports && invalid.fieldErrors.consentVersion,
        'telemetry and consent must validate independently');
      const accepted = await save(userData, { telemetryInBugReports: true, consentVersion: 2 });
      const config = persisted(userData);
      assert(accepted.ok && config.telemetryInBugReports && config.consentVersion === 2,
        'telemetry and consent must persist');
    }),
  },
  {
    name: 'handoff bridge: store: a linked hostname change needs break confirmation before native confirmation',
    run: () => withStore(async userData => {
      await save(userData, { hostname: 'bridge.example.com' });
      let confirmations = 0;
      const blocked = await save(userData, { hostname: 'new-bridge.example.com' }, {
        linked: true,
        confirmHostnameChange: async () => { confirmations++; return true; },
      });
      assert(blocked.code === 'LINK_WOULD_BREAK' && confirmations === 0, 'linked hostname change must require confirmBreak first');
      const accepted = await save(userData, { hostname: 'new-bridge.example.com', confirmBreak: true }, { linked: true });
      assert(accepted.ok && persisted(userData).hostname === 'new-bridge.example.com', 'confirmed link break must persist hostname');
      const malformedChecker = await save(userData, { hostname: 'malformed-checker.example.com' }, {
        isLinked: () => undefined,
        confirmHostnameChange: async () => { confirmations++; return true; },
      });
      assert(malformedChecker.code === 'LINK_WOULD_BREAK' && confirmations === 0,
        'a malformed injected linked checker must fail closed before native confirmation');
    }),
  },
  {
    name: 'handoff bridge: store: linked checker is evaluated inside its queue and again after hostname consent',
    run: () => withStore(async userData => {
      await save(userData, { hostname: 'bridge.example.com' });
      const firstConsent = deferred();
      const first = save(userData, { hostname: 'queued.example.com' }, { confirmHostnameChange: () => firstConsent.promise });
      await Promise.resolve();
      let linked = false; let secondConfirmations = 0;
      const queued = save(userData, { hostname: 'later.example.com' }, {
        isLinked: () => linked,
        confirmHostnameChange: async () => { secondConfirmations += 1; return true; },
      });
      linked = true;
      firstConsent.resolve(true);
      assert((await first).ok, 'the queued predecessor must complete before the later hostname mutation');
      const queuedResult = await queued;
      assert(queuedResult.code === 'LINK_WOULD_BREAK' && secondConfirmations === 0 && persisted(userData).hostname === 'queued.example.com',
        'a link created while a hostname save waits in the config queue must block before a second native confirmation');

      let linkedDuringConsent = false; const secondConsent = deferred();
      const duringConsent = save(userData, { hostname: 'after-consent.example.com' }, {
        isLinked: () => linkedDuringConsent,
        confirmHostnameChange: () => secondConsent.promise,
      });
      await Promise.resolve();
      linkedDuringConsent = true;
      secondConsent.resolve(true);
      const consentResult = await duringConsent;
      assert(consentResult.code === 'LINK_WOULD_BREAK' && persisted(userData).hostname === 'queued.example.com',
        'a link created while hostname consent is open must be checked again immediately before the atomic write');
    }),
  },
  {
    name: 'handoff bridge: store: unknown-version config is byte-unchanged after a save attempt',
    run: () => withStore(async userData => {
      const filePath = configPathFor(userData);
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const original = '{"v":99,"hostname":"bridge.example.com"}\n';
      fs.writeFileSync(filePath, original, { mode: 0o600 });
      const result = await save(userData, { autoStart: true });
      assert(result.code === 'STATE_UNREADABLE', 'unknown version must fail closed');
      assert(fs.readFileSync(filePath, 'utf8') === original, 'unknown version must never be overwritten');
    }),
  },
  {
    name: 'handoff bridge: store: atomic config has hardened modes and no tunnel authority',
    run: () => withStore(async userData => {
      const accepted = await save(userData, { hostname: 'bridge.example.com', autoStart: true });
      assert(accepted.ok, 'setup config must save');
      const filePath = configPathFor(userData);
      const directoryMode = fs.statSync(path.dirname(filePath)).mode & 0o777;
      const fileMode = fs.statSync(filePath).mode & 0o777;
      const serialized = fs.readFileSync(filePath, 'utf8');
      assert(directoryMode === 0o700 && fileMode === 0o600, 'config directory and file modes must be 0700/0600');
      assert(!/binaryPath|credentialsPath|trustPin|tunnelSecret/i.test(serialized),
        'config must not duplicate tunnel authority or secrets');
    }),
  },
  {
    name: 'handoff bridge: store: atomic save uses exclusive temporary file, fsync and rename',
    run: () => withStore(async userData => {
      const calls = [];
      const fsImpl = new Proxy(fs, {
        get(target, property) {
          const value = target[property];
          if (typeof value !== 'function') return value;
          return (...args) => {
            if (property === 'openSync' || property === 'fsyncSync' || property === 'renameSync') {
              calls.push([property, ...args]);
            }
            return value(...args);
          };
        },
      });
      const accepted = await save(userData, { autoStart: true }, { fsImpl });
      assert(accepted.ok, 'atomic config save must complete');
      assert(calls.some(([name, , flag]) => name === 'openSync' && flag === 'wx'),
        'config must create its temporary file exclusively');
      assert(calls.filter(([name]) => name === 'fsyncSync').length >= 1, 'config must fsync before rename');
      assert(calls.some(([name]) => name === 'renameSync'), 'config must publish with rename');
    }),
  },
  {
    name: 'handoff bridge: store: writes serialize without losing independent patches',
    run: () => withStore(async userData => {
      const [first, second] = await Promise.all([
        save(userData, { autoStart: true }),
        save(userData, { autoRelease: true }),
      ]);
      const config = persisted(userData);
      assert(first.ok && second.ok && config.autoStart && config.autoRelease,
        'serialized writes must preserve both patches');
    }),
  },
  {
    name: 'handoff bridge: store: forget removes only durable config and preserves siblings',
    run: () => withStore(async userData => {
      const saved = await save(userData, { hostname: 'bridge.example.com', autoStart: true });
      assert(saved.ok, 'setup config must exist before Forget');
      const configPath = configPathFor(userData);
      const lanePath = path.join(path.dirname(configPath), 'lanes.json');
      const tunnelPath = path.join(userData, 'handoff-bridge', 'tunnel', 'tunnel.json');
      fs.writeFileSync(lanePath, '{"lanes":[]}', { mode: 0o600 });
      fs.mkdirSync(path.dirname(tunnelPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tunnelPath, '{"approved":true}', { mode: 0o600 });

      let directorySyncs = 0;
      const fsImpl = new Proxy(fs, {
        get(target, property) {
          if (property === 'fsyncSync') return fd => {
            directorySyncs++;
            return target.fsyncSync(fd);
          };
          return target[property];
        },
      });
      const forgotten = await forgetConfig(userData, { fsImpl });
      assert(forgotten === true && !fs.existsSync(configPath), 'Forget must remove config.json after durable success');
      assert(directorySyncs === 1, 'Forget must fsync its parent directory after unlink');
      assert(fs.readFileSync(lanePath, 'utf8') === '{"lanes":[]}', 'Forget must not remove lanes');
      assert(fs.readFileSync(tunnelPath, 'utf8') === '{"approved":true}', 'Forget must not remove tunnel state');
    }),
  },
  {
    name: 'handoff bridge: store: forget is idempotent and does not create a config directory',
    run: () => withStore(async userData => {
      const configDirectory = path.dirname(configPathFor(userData));
      const first = await forgetConfig(userData);
      const second = await forgetConfig(userData);
      assert(first === true && second === true, 'missing config must make Forget a successful no-op');
      assert(!fs.existsSync(configDirectory), 'Forget of missing config must not create its directory');
    }),
  },
  {
    name: 'handoff bridge: store: forget refuses a symlink or non-regular config target',
    run: () => withStore(async userData => {
      const configPath = configPathFor(userData);
      const targetPath = path.join(userData, 'unrelated.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(targetPath, 'keep me', { mode: 0o600 });
      fs.symlinkSync(targetPath, configPath);

      const forgotten = await forgetConfig(userData);
      assert(forgotten === false, 'Forget must reject a symlink config target');
      assert(fs.lstatSync(configPath).isSymbolicLink(), 'unsafe config target must remain untouched');
      assert(fs.readFileSync(targetPath, 'utf8') === 'keep me', 'Forget must not follow a symlink');
    }),
  },
  {
    name: 'handoff bridge: store: forget reports unlink and parent fsync failures',
    run: () => withStore(async userData => {
      const configPath = configPathFor(userData);
      await save(userData, { autoStart: true });
      const unlinkFailure = new Proxy(fs, {
        get(target, property) {
          if (property === 'unlinkSync') return () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
          return target[property];
        },
      });
      assert(await forgetConfig(userData, { fsImpl: unlinkFailure }) === false,
        'Forget must report unlink failure');
      assert(fs.existsSync(configPath), 'unlink failure must leave config in place');

      const fsyncFailure = new Proxy(fs, {
        get(target, property) {
          if (property === 'fsyncSync') return () => { throw Object.assign(new Error('sync failed'), { code: 'EIO' }); };
          return target[property];
        },
      });
      assert(await forgetConfig(userData, { fsImpl: fsyncFailure }) === false,
        'Forget must report a parent directory fsync failure');
      assert(!fs.existsSync(configPath), 'failed directory fsync must not claim the deletion was durable');
    }),
  },
  {
    name: 'handoff bridge: store: forget waits behind a queued save',
    run: () => withStore(async userData => {
      const pendingSave = save(userData, { autoStart: true });
      const pendingForget = forgetConfig(userData);
      const [saved, forgotten] = await Promise.all([pendingSave, pendingForget]);
      assert(saved.ok && forgotten === true, 'queued save and Forget must both complete');
      assert(readConfig(userData).state === 'missing', 'Forget after a queued save must leave config absent');
    }),
  },
];
