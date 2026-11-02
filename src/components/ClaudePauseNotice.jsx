import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useClaudeTaskStatus } from '../hooks/useClaudeTaskStatus';
import { claudePauseNotice } from '../utils/claudeTaskPause';

// A short line in the dock while Claude is held up by a usage limit or a
// sign-in problem. The queued work stays pending and resumes by itself.
export function ClaudePauseNotice({ className = '' }) {
  const notice = claudePauseNotice(useClaudeTaskStatus({ poll: true }));
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
      </div>
    </div>
  );
}

export default ClaudePauseNotice;
