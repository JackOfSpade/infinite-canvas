import { useCallback, useEffect, useRef, useState } from 'react';

// The one sentence that explains the whole multi-account behaviour, kept here
// so the settings panel and any future surface cannot drift apart.
export const CLAUDE_ACCOUNTS_HELP = 'The app uses the first signed-in account that has usage left and switches automatically when one reaches its limit.';

export const CLAUDE_ACCOUNT_ADD_UNAVAILABLE = 'Adding Claude accounts is not available in this build.';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const emailOf = value => (typeof value === 'string' && value ? value : null);

/** Pure: the account list from the main process, or [] when the bridge cannot answer. */
export async function listClaudeAccounts() {
  try {
    const list = await globalThis.window?.electronAPI?.listClaudeAccounts?.();
    return Array.isArray(list) ? list.filter(isObject) : [];
  } catch { return []; }
}

/** Pure: true only when the main process confirmed the removal. */
export async function removeClaudeAccount(id) {
  if (typeof id !== 'string' || !id) return false;
  try {
    const result = await globalThis.window?.electronAPI?.removeClaudeAccount?.(id);
    return result?.ok === true;
  } catch { return false; }
}

/**
 * Pure: the one-line result of a finished addClaudeAccount call, or null when
 * there is nothing worth saying (the user cancelled).
 */
export function claudeAccountAddMessage(result) {
  if (!isObject(result)) return 'Sign-in did not finish.';
  if (result.ok === true) {
    const email = emailOf(result.account?.email);
    return email ? `Added ${email}.` : 'Added the account.';
  }
  switch (result.reason) {
    case 'cancelled': return null;
    case 'duplicate': return 'That account is already added.';
    case 'cli-missing': return 'Claude Code is not installed.';
    case 'timeout': return 'Sign-in timed out.';
    default: return emailOf(result.message) || 'Sign-in did not finish.';
  }
}

/**
 * The one add-account flow behind both the dock notice and the accounts panel:
 * click → browser sign-in (minutes) → pending line with a Cancel escape →
 * one-line result. `onAdded` refreshes whatever list the caller renders.
 */
export function useClaudeAccountAddFlow({ onAdded } = {}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const addAccount = useCallback(async () => {
    const bridge = globalThis.window?.electronAPI;
    if (!bridge?.addClaudeAccount) { setMessage(CLAUDE_ACCOUNT_ADD_UNAVAILABLE); return; }
    setMessage(null);
    setPending(true);
    let result = null;
    try { result = await bridge.addClaudeAccount(); } catch { result = { ok: false, reason: 'failed' }; }
    if (!mounted.current) return;
    setPending(false);
    setMessage(claudeAccountAddMessage(result));
    if (result?.ok === true) { try { await onAdded?.(); } catch { /* the next push refreshes the list */ } }
  }, [onAdded]);

  const cancelLogin = useCallback(async () => {
    try { await globalThis.window?.electronAPI?.cancelClaudeAccountLogin?.(); } catch { /* the add call resolves on its own */ }
  }, []);

  return { pending, message, addAccount, cancelLogin };
}

export default useClaudeAccountAddFlow;
