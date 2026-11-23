import assert from 'node:assert/strict';
import { createStealthPlugins, GuardedUserAgentOverride, isTargetClosedError } from '../../electron/ipc/browser/stealthPlugins.js';

function fakePage({ reject }) {
  const sends = [];
  const client = {
    send(method, params) {
      sends.push({ method, params });
      return reject ? Promise.reject(reject) : Promise.resolve({});
    },
  };
  const browser = { userAgent: async () => 'Mozilla/5.0 (Macintosh) HeadlessChrome/152.0.0.0 Safari/537.36' };
  return { sends, page: { _client: () => client, browser: () => browser } };
}

async function settle() { await new Promise(resolve => setImmediate(resolve)); }

export default [{
  name: 'stealth setup swaps only the user-agent evasion for the guarded one with the same name',
  run() {
    const [stealth, ua] = createStealthPlugins();
    assert.equal(stealth.enabledEvasions.has('user-agent-override'), false);
    assert.ok(stealth.enabledEvasions.size > 5, 'other evasions stay enabled');
    assert.ok(ua instanceof GuardedUserAgentOverride);
    assert.equal(ua.name, 'stealth/evasions/user-agent-override');
    // puppeteer-extra's use() registers the instance's own prototype members to decide which browser events to bind.
    ua._registerChildClassMembers(Object.getPrototypeOf(ua));
    assert.ok(ua._childClassMembers.includes('onPageCreated'), 'puppeteer-extra binds page events for the guarded class');
  },
}, {
  name: 'guarded user-agent override sends the same override and swallows a closed-target rejection',
  async run() {
    const closed = Object.assign(new Error('Protocol error (Network.setUserAgentOverride): Target closed'), { name: 'TargetCloseError' });
    const unexpected = [];
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const ua = new GuardedUserAgentOverride({}, { onUnexpectedError: e => unexpected.push(e) });
      const { sends, page } = fakePage({ reject: closed });
      await ua.onPageCreated(page);
      await settle(); await settle();
      assert.equal(sends.length, 1);
      assert.equal(sends[0].method, 'Network.setUserAgentOverride');
      assert.match(sends[0].params.userAgent, /Chrome\/152/u);
      assert.doesNotMatch(sends[0].params.userAgent, /Headless/u);
      assert.equal(unhandled.length, 0);
      assert.equal(unexpected.length, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  },
}, {
  name: 'guarded user-agent override reports a non-close send failure instead of dropping it',
  async run() {
    const unexpected = [];
    const ua = new GuardedUserAgentOverride({}, { onUnexpectedError: e => unexpected.push(e) });
    const { page } = fakePage({ reject: new Error('Invalid parameters') });
    await ua.onPageCreated(page);
    await settle(); await settle();
    assert.equal(unexpected.length, 1);
    assert.equal(isTargetClosedError(new Error('Session closed. Most likely the page has been closed.')), true);
    assert.equal(isTargetClosedError(new Error('Invalid parameters')), false);
  },
}];
