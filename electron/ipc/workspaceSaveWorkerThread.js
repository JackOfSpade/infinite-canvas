// Worker-thread entry for saving a canvas. Removing repeated content and
// proving the result restores exactly take seconds on a canvas with large
// job-search results; done on the main thread they froze every window and
// every app request for that long on each auto-save. Built as its own entry so
// the thread never loads main.cjs.

import { parentPort } from 'node:worker_threads';
import { formatPooledWorkspace, parseWorkspaceText, poolWorkspaceContent } from './workspaceContentPool.js';

/**
 * Returns `{ serialized, mismatch }` for a canvas already serialized as `plain`:
 * the pooled file text, or `serialized: null` when pooling does not apply
 * (`mismatch` false) or does not restore to exactly `plain` (`mismatch` true).
 */
export function pooledTextForPlain(plain) {
  const pooled = poolWorkspaceContent(JSON.parse(plain));
  if (!pooled) return { serialized: null, mismatch: false };
  const serialized = formatPooledWorkspace(pooled);
  // Prove the exact text about to reach disk restores this canvas.
  if (JSON.stringify(parseWorkspaceText(serialized)) === plain) return { serialized, mismatch: false };
  return { serialized: null, mismatch: true };
}

if (parentPort) {
  parentPort.once('message', (plain) => {
    try {
      parentPort.postMessage({ ok: true, ...pooledTextForPlain(plain) });
    } catch (error) {
      parentPort.postMessage({ ok: false, message: String(error?.message || error) });
    }
  });
}
