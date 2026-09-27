import { assert } from './testHelpers.js';
import { emptyConfig, readConfig } from '../../electron/ipc/handoffBridge/store.js';

export default [{
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
    assert(emptyConfig().autoStart === false, 'fresh config must preserve auto-start opt-in');
  },
}];
