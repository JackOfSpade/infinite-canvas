import { assert } from './testHelpers.js';
import { createFakeClock } from './fixtures/handoff-bridge/fakeClock.js';
import { exchange, parseContentLength } from './fixtures/handoff-bridge/fakeHttp.js';
import { faultAt, withLeakCheck, withTimeout } from './fixtures/handoff-bridge/harness.js';

export default [
  {
    name: 'handoff bridge: http: in-process exchange preserves real request response semantics',
    async run() {
      const payload = '{"answer":"Ada Lovelace"}';
      const responseBody = 'accepted';
      const result = await withLeakCheck(() => withTimeout(exchange({
        async checkContinue(req, res) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          assert(Buffer.concat(chunks).toString('utf8') === payload, 'request chunks must reassemble byte-identically');
          res.writeHead(201, {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': String(Buffer.byteLength(responseBody)),
            'cache-control': 'no-store',
          });
          res.end(responseBody);
        },
      }, {
        body: payload,
        chunkSize: 3,
        chunked: true,
        expectContinue: true,
        connection: 'close',
      }), 1000));
      assert(result.req.complete === true, 'the fake must preserve IncomingMessage complete semantics');
      assert(result.status === 201 && result.body.toString('utf8') === responseBody, 'ServerResponse bytes must be parsed exactly');
      assert(result.headers['content-length'] === String(responseBody.length), 'explicit response length must survive');
      assert(result.req.headers['transfer-encoding'] === 'chunked' && result.contentLength === null, 'chunked requests must not invent a content length');
      assert(result.readBytes === Buffer.byteLength(payload), 'body consumption must be observed by bytes');
      assert(result.observations.expectContinue && result.observations.connection === 'close', 'Expect and Connection controls must reach the handler');
    },
  },
  {
    name: 'handoff bridge: http: content length parser and request destruction fail closed',
    async run() {
      assert(parseContentLength({ 'content-length': '8192' }) === 8192, 'valid decimal content length must parse');
      for (const value of ['-1', '01', '1.5', 'NaN', '9007199254740992']) {
        assert(parseContentLength({ 'content-length': value }) === null, `invalid content length ${value} must fail closed`);
      }
      const result = await withTimeout(exchange((req, res) => {
        req.on('error', () => undefined);
        res.writeHead(499, { 'content-length': '0', connection: 'close' });
        res.end();
      }, { abort: true, connection: 'close' }), 1000);
      assert(result.observations.bodyDestroyed && result.destroyed, 'an early rejection must observe both body and connection destruction');
    },
  },
  {
    name: 'handoff bridge: http: fake clock orders timers and models ref unref clear and intervals',
    run: () => {
      const clock = createFakeClock(1000);
      const order = [];
      const cleared = clock.setTimeout(() => order.push('cleared'), 2);
      clock.clearTimeout(cleared);
      const later = clock.setTimeout(() => order.push('later'), 10).unref();
      clock.setTimeout(() => order.push('first'), 5);
      clock.setTimeout(() => order.push('second'), 5);
      let ticks = 0;
      const interval = clock.setInterval(() => { ticks++; if (ticks === 2) clock.clearInterval(interval); }, 3);
      assert(!later.hasRef() && clock.pendingRefed().length === 3, 'unref must affect only liveness bookkeeping');
      clock.advance(5);
      assert(order.join(',') === 'first,second' && ticks === 1, 'due timers must run by deadline then insertion order');
      clock.advance(5);
      assert(order.join(',') === 'first,second,later' && ticks === 2 && clock.pendingCount() === 0, 'interval clear and later timeout must settle deterministically');
    },
  },
  {
    name: 'handoff bridge: http: faultAt fails exactly one call in throw and reject modes',
    async run() {
      const calls = [];
      const base = { call: async value => { calls.push(value); return value; } };
      for (const mode of ['throw', 'reject']) {
        const injected = new Error(`fault-${mode}`);
        const wrapped = faultAt(base, 2, { mode, error: injected });
        assert(await wrapped.port.call(`${mode}-one`) === `${mode}-one`, 'first call must pass');
        let seen;
        try { await wrapped.port.call(`${mode}-two`); } catch (error) { seen = error; }
        assert(seen === injected, `${mode} fault must hit exactly the kth call`);
        assert(await wrapped.port.call(`${mode}-three`) === `${mode}-three`, 'calls after the injected fault must recover');
        assert(wrapped.count() === 3 && wrapped.calls.length === 3, 'fault sweep call accounting must be exact');
      }
      assert(calls.length === 4, 'the underlying port must run on every non-faulted call only');
    },
  },
  {
    name: 'handoff bridge: http: timeout helper uses injected timers and clears them',
    async run() {
      const clock = createFakeClock(0);
      let clears = 0;
      const pending = withTimeout(new Promise(() => {}), 25, {
        setTimeoutImpl: clock.setTimeout,
        clearTimeoutImpl: timer => { clears++; clock.clearTimeout(timer); },
        message: 'synthetic timeout',
      });
      clock.advance(25);
      let message = '';
      try { await pending; } catch (error) { message = error.message; }
      assert(message === 'synthetic timeout' && clears === 1 && clock.pendingCount() === 0, 'timeout must reject once and release its timer');
    },
  },
];
