// Child-process entry for saving a canvas. Removing repeated content and
// proving the result restores exactly take seconds on a canvas with large
// job-search results, and hold several copies of the canvas at once.
//
// This runs in its own process, not a worker thread: Electron gives the main
// thread and every worker thread of one process a single shared 4 GB heap, so
// a worker that filled it aborted the whole app (2026-11-22 crash). A process
// has its own heap; if it runs out, only it dies and the save goes out plain.
//
// Protocol: the canvas's plain JSON arrives on stdin. stdout gets one status
// character, then (for "P") the pooled file text:
//   P  pooled text follows
//   N  pooling does not apply; save the plain text
//   M  the pooled text did not restore exactly; save the plain text
// Built as its own entry so the process never loads main.cjs.

import { formatPooledWorkspace, parseWorkspaceTextKeepingShared, poolWorkspaceContent } from './workspaceContentPool.js';

/**
 * Returns `{ serialized, mismatch }` for a canvas already serialized as `plain`:
 * the pooled file text, or `serialized: null` when pooling does not apply
 * (`mismatch` false) or does not restore to exactly `plain` (`mismatch` true).
 */
export function pooledTextForPlain(plain) {
  let serialized;
  {
    // Scoped so the parsed and pooled copies can be collected before the
    // restore check below builds two more.
    const pooled = poolWorkspaceContent(JSON.parse(plain));
    if (!pooled) return { serialized: null, mismatch: false };
    serialized = formatPooledWorkspace(pooled);
  }
  // Prove the exact text about to reach disk restores this canvas.
  // Shared values stay as references on both sides: `plain` holds them that
  // way too, and loading reconnects them after this step.
  if (JSON.stringify(parseWorkspaceTextKeepingShared(serialized)) === plain) return { serialized, mismatch: false };
  return { serialized: null, mismatch: true };
}

// Set only by the parent that spawns this file, so importing it has no effect.
export const WORKSPACE_SAVE_WORKER_ENV = 'INFINITE_CANVAS_SAVE_WORKER';
if (process.env[WORKSPACE_SAVE_WORKER_ENV] === '1') {
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    const plain = Buffer.concat(chunks).toString('utf8');
    chunks.length = 0;
    const { serialized, mismatch } = pooledTextForPlain(plain);
    // Pipes may write asynchronously; the process ends once stdout drains.
    process.stdout.write(serialized != null ? `P${serialized}` : (mismatch ? 'M' : 'N'));
  });
}
