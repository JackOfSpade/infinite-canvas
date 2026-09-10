/**
 * Convert a failed handleSafe IPC response into brief, user-actionable Solve
 * copy. The main-process error can include Puppeteer stderr or a multi-line
 * Chrome diagnostic; keep that in the event log, not in persisted card data.
 */
export function solveIpcFailureMessage(result) {
  const raw = String(result?.error || '').replace(/\s+/g, ' ').trim();

  if (/about:blank|blank (?:page|window)|navigation.*(?:stuck|fail)|did not reach/i.test(raw)) {
    return 'The verification window did not reach the site. Close it, then try Solve again.';
  }
  if (/profile.*(?:reserved|lock)|already running|opening in existing browser session/i.test(raw)) {
    return 'Another verification window is using the shared browser session. Close it or wait, then try Solve again.';
  }
  if (/chrome.*(?:launch|start)|failed to launch|spawn\s+(?:enoent|eacces)|permission/i.test(raw)) {
    return 'The verification browser could not start. Close any verification windows, then try Solve again.';
  }
  return 'Solve did not start. Please try again.';
}

export function isSolveIpcFailure(result) {
  // Every production Solve IPC is wrapped by handleSafe and therefore marks a
  // real completion explicitly. Fail closed for an absent/malformed preload
  // result so optional chaining cannot turn a missing bridge into a silent
  // unresolved Solve.
  return result?.success !== true;
}

/** Failures caused by lifecycle cancellation are not browser-launch errors. */
export function isSolveIpcCancellation(result) {
  if (result?.name === 'AbortError') return true;
  const message = String(result?.error || result?.message || '').replace(/\s+/g, ' ').trim();
  return /^(?:Node deleted|Window closed|Sender destroyed|Renderer navigated|Operation cancel(?:l)?ed)\.?$/i.test(message);
}

/** Preserve the source's action/code while making a launch failure visible. */
export function warningForSolveIpcFailure(warning, result) {
  if (!warning) return null;
  const message = solveIpcFailureMessage(result);
  return {
    ...warning,
    evidence: message,
    suggestion: message,
  };
}
