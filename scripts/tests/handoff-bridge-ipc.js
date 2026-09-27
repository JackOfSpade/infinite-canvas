import { assert } from './testHelpers.js';
import { IPC_CHANNELS, IPC_EVENTS, PUBLISH_JOBS_EXAMPLE } from '../../electron/ipc/handoffBridge/contracts.js';

export default [{
  name: 'handoff bridge: ipc: contract exposes exactly 24 invokes, one publish send and three events',
  run: () => {
    const channelValues = Object.values(IPC_CHANNELS);
    assert(channelValues.length === 25 && new Set(channelValues).size === 25, 'IPC channel names must be closed and unique');
    assert(IPC_CHANNELS.PUBLISH_JOBS === 'handoff-bridge:publish-jobs', 'publish-jobs must remain the sole send-only channel');
    assert(channelValues.filter(channel => channel !== IPC_CHANNELS.PUBLISH_JOBS).length === 24, 'the remaining IPC channels must be invokes');
    assert(Object.values(IPC_EVENTS).length === 3 && new Set(Object.values(IPC_EVENTS)).size === 3, 'main-to-renderer event names must be closed and unique');
    assert(!JSON.stringify({ IPC_CHANNELS, IPC_EVENTS, PUBLISH_JOBS_EXAMPLE }).includes('label'), 'IPC contracts must never carry renderer labels');
  },
}];
