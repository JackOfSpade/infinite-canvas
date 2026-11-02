import fs from 'node:fs';
import { createTunnelSupervisor } from './supervisor.js';
import { TUNNEL_CONSTANTS } from './constants.js';

export function createRealTunnelSupervisor(options = {}) {
  // Keep platform ports explicit so unit tests never fall through to a real
  // child, filesystem or public request by accident.
  const supervisor = createTunnelSupervisor({ ...options, fsImpl: options.fsImpl || fs, constants: TUNNEL_CONSTANTS });
  const onResume = () => { void supervisor.probe(); };
  let listening = false;
  try { options.powerMonitor?.on?.('resume', onResume); listening = typeof options.powerMonitor?.on === 'function'; } catch { /* an optional platform hook cannot block supervision */ }
  return Object.freeze({
    ...supervisor,
    async dispose() {
      if (listening) try { options.powerMonitor?.removeListener?.('resume', onResume); } catch { /* still stop the tunnel */ }
      return supervisor.dispose();
    },
  });
}

export { createTunnelSupervisor } from './supervisor.js';
