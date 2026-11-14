import React, { useSyncExternalStore } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useClaudeTaskStatus } from '../hooks/useClaudeTaskStatus';
import { claudePauseNotice, claudeUsageLimitNotice } from '../utils/claudeTaskPause';
import { getClaudeTaskActivity, subscribeClaudeTaskActivity } from '../utils/claudeTaskActivityStore';
import { useClaudeAccountAddFlow } from '../utils/claudeAccountsActions';

// A short line in the dock while Claude is held up by a usage limit or a
// sign-in problem. The queued work stays pending and resumes by itself; when
// every signed-in account is limited the user can add another one right here.
export function ClaudePauseNotice({ className = '' }) {
  const status = useClaudeTaskStatus({ poll: true });
  const { usageLimit, claudeAccounts } = useSyncExternalStore(subscribeClaudeTaskActivity, getClaudeTaskActivity, getClaudeTaskActivity);
  const notice = claudeUsageLimitNotice(usageLimit, claudeAccounts) || claudePauseNotice(status);
  const { pending, message, addAccount, cancelLogin } = useClaudeAccountAddFlow();
  if (!notice) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-2 rounded-xl border border-amber-400/40 bg-neutral-900/95 px-3 py-2 text-xs leading-relaxed text-amber-100 ${className}`}
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
      <div className="min-w-0">
        <div className="font-semibold text-amber-50">{notice.headline}</div>
        <div className="mt-0.5 text-amber-100/80">{notice.reason}</div>
        {usageLimit && (
          <div className="mt-1.5 flex items-center gap-1.5">
            <button type="button" onClick={() => { void window.electronAPI?.resumeClaudeUsageNow?.(); }} className="rounded-md border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-50 hover:bg-amber-500/20">
              Resume now
            </button>
            {pending ? (
              <button type="button" onClick={() => { void cancelLogin(); }} className="rounded-md border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-50 hover:bg-amber-500/20">
                Cancel
              </button>
            ) : (
              <button type="button" onClick={() => { void addAccount(); }} className="rounded-md border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-50 hover:bg-amber-500/20">
                Add Claude account
              </button>
            )}
          </div>
        )}
        {usageLimit && pending ? (
          <div className="mt-1.5 text-[11px] text-amber-100/80">Waiting for sign-in in your browser…</div>
        ) : null}
        {usageLimit && message ? (
          <div className="mt-1.5 text-[11px] text-amber-100/80">{message}</div>
        ) : null}
      </div>
    </div>
  );
}

export default ClaudePauseNotice;
