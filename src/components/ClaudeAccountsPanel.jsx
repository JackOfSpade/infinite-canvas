import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { UserRound } from 'lucide-react';
import { claudeLimitLabel, claudePlanLabel } from '../utils/claudeTaskPause';
import { getClaudeTaskActivity, subscribeClaudeTaskActivity } from '../utils/claudeTaskActivityStore';
import {
  CLAUDE_ACCOUNTS_HELP, listClaudeAccounts, removeClaudeAccount, useClaudeAccountAddFlow,
} from '../utils/claudeAccountsActions';

const clockTime = at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Pure: the account's name line — the email, or why there is none yet. */
function accountName(account) {
  if (account.loggedIn === false) return 'Signed out';
  if (account.loggedIn === null) return 'Checking…';
  return typeof account.email === 'string' && account.email ? account.email : 'Claude account';
}

/** Pure: 'Limited until 3:20 PM (weekly)', or null while the account has usage. */
function limitedLine(account) {
  const until = account.limitedUntil;
  if (!Number.isFinite(until) || until <= Date.now()) return null;
  return `Limited until ${clockTime(until)} (${claudeLimitLabel(account.limitType)})`;
}

// Every signed-in Claude account, which one the app is using, and the two
// actions that matter: sign another one in, or drop one.
export function ClaudeAccountsPanel({ className = '' }) {
  const [loaded, setLoaded] = useState([]);
  const [removingId, setRemovingId] = useState(null);
  const activity = useSyncExternalStore(subscribeClaudeTaskActivity, getClaudeTaskActivity, getClaudeTaskActivity);
  const live = activity.claudeAccounts;
  const accounts = live.length ? live : loaded;

  const refresh = useCallback(async () => { setLoaded(await listClaudeAccounts()); }, []);
  useEffect(() => {
    let live = true;
    listClaudeAccounts().then((list) => { if (live) setLoaded(list); });
    return () => { live = false; };
  }, []);

  const { pending, message, addAccount, cancelLogin } = useClaudeAccountAddFlow({ onAdded: refresh });

  const handleRemove = useCallback(async (account) => {
    if (!account || account.isDefault === true) return;
    const name = typeof account.email === 'string' && account.email ? account.email : 'this account';
    const confirmed = globalThis.window?.confirm?.(`Remove ${name} from Claude? You can sign in again later.`);
    if (!confirmed) return;
    setRemovingId(account.id);
    await removeClaudeAccount(account.id);
    setRemovingId(null);
    await refresh();
  }, [refresh]);

  return (
    <section className={className} aria-label="Claude accounts">
      <div className="flex items-center gap-2 mb-3">
        <UserRound size={13} className="text-white/30" />
        <span className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">
          Claude accounts
        </span>
      </div>
      <div className="text-white/40 text-[11px] mb-3 leading-relaxed">{CLAUDE_ACCOUNTS_HELP}</div>
      <div className="space-y-2">
        {accounts.map(account => {
          const plan = claudePlanLabel(account.subscriptionType);
          const limited = limitedLine(account);
          return (
            <div key={account.id} className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-white/80 text-xs font-semibold truncate">{accountName(account)}</span>
                    {plan && <span className="text-white/40 text-[10px] shrink-0">{plan}</span>}
                    {account.active === true && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 shrink-0">
                        In use
                      </span>
                    )}
                  </div>
                  {limited && <div className="text-amber-300/80 text-[10px] mt-1">{limited}</div>}
                </div>
                {account.isDefault !== true && (
                  <button
                    type="button"
                    onClick={() => { void handleRemove(account); }}
                    disabled={removingId === account.id}
                    className="text-[10px] px-2 py-1 rounded border border-white/10 bg-white/[0.03] text-white/40 hover:bg-white/[0.08] hover:text-white/70 disabled:opacity-40 shrink-0"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {pending ? (
          <>
            <span className="text-white/40 text-[10px]">Waiting for sign-in in your browser…</span>
            <button
              type="button"
              onClick={() => { void cancelLogin(); }}
              className="text-[10px] px-2 py-1 rounded border border-white/10 bg-white/[0.03] text-white/40 hover:bg-white/[0.08] hover:text-white/70"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => { void addAccount(); }}
            className="text-[10px] px-2 py-1 rounded border border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20"
          >
            Add account
          </button>
        )}
      </div>
      {!pending && message && <div className="text-white/40 text-[10px] mt-2">{message}</div>}
    </section>
  );
}

export default ClaudeAccountsPanel;
