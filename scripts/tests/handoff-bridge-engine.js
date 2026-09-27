import { assert } from './testHelpers.js';
import { AUDIT_LINE_EXAMPLE, ENGINE_PORT_SHAPE, SOURCE_ADAPTER_SHAPE, STATUS_SNAPSHOT_EXAMPLE, TUNNEL_PORT_SHAPE } from '../../electron/ipc/handoffBridge/contracts.js';
import { classifyThrow, fixedError } from '../../electron/ipc/handoffBridge/errors.js';
import { makeAuditLine } from '../../electron/ipc/handoffBridge/audit.js';
import { makeLogRecord } from '../../electron/ipc/handoffBridge/log.js';

export default [
  {
    name: 'handoff bridge: engine: frozen port and status contracts are complete and immutable',
    run: () => {
      assert(ENGINE_PORT_SHAPE.join(',') === 'get,submit,snapshot,close', 'engine port shape drifted');
      assert(SOURCE_ADAPTER_SHAPE.join(',') === 'read,status,submit', 'source adapter shape drifted');
      assert(TUNNEL_PORT_SHAPE.join(',') === 'start,stop,status,reapOrphans', 'tunnel port shape drifted');
      assert(STATUS_SNAPSHOT_EXAMPLE.v === 1 && STATUS_SNAPSHOT_EXAMPLE.power.keepAwake === false, 'status example must be safe and versioned');
      assert(STATUS_SNAPSHOT_EXAMPLE.limits.idlePauseMinutes === 1440, 'status example must expose the accepted idle default');
      assert(Object.isFrozen(STATUS_SNAPSHOT_EXAMPLE.queue.applications), 'status contract must be deeply immutable');
      assert(!JSON.stringify(STATUS_SNAPSHOT_EXAMPLE).match(/prompt|handoffCode|canvasFilePath|label/i), 'status contract must not expose content or identifiers');
      assert(Object.keys(AUDIT_LINE_EXAMPLE).join(',') === 't,ev,tool,outcome,stage,argBytes,resultBytes,ms,grantFp,epochFp,source,tokenLeftSec', 'serve audit schema drifted');
    },
  },
  {
    name: 'handoff bridge: engine: errors logs and audit lines reject free text',
    run: () => {
      assert(fixedError('no_hostname').message === 'A bridge hostname is required.', 'fixed error sentence drifted');
      assert(classifyThrow({ code: 'no_hostname', message: 'secret prompt' }).code === 'no_hostname', 'classification must use only code');
      assert(classifyThrow({ code: 'not-a-code', message: 'secret prompt' }).code === 'internal_error', 'unknown codes must collapse');
      assert(makeLogRecord('pause', { cause: 'idle' }).fields.cause === 'idle', 'safe enumerated log fields must pass');
      for (const attempt of [
        () => makeLogRecord('unknown', {}),
        () => makeLogRecord('pause', { reason: 'free text with spaces' }),
        () => makeLogRecord('link_created', { candidate: 'ada' }),
        () => makeLogRecord('pause', { tool: 'get_handoff' }),
        () => makeAuditLine({ event: 'served', fields: { prompt: 'secret' } }),
        () => makeAuditLine({ event: 'not_enumerated', fields: {} }),
      ]) {
        let threw = false;
        try { attempt(); } catch { threw = true; }
        assert(threw, 'free-form log or audit input must be rejected');
      }
      assert(makeAuditLine({ at: 1, event: 'served', fields: { tool: 'get_handoff', outcome: 'ok', argBytes: 12 } }).ev === 'served', 'enumerated serve audit must pass');
    },
  },
];
