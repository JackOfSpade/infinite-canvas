import React, { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { updateModalCount } from './modalStack';
import { dismissBlockingNotice, getBlockingNotices, subscribeBlockingNotices } from '../utils/blockingNotices';

function BlockingNotice({ notice, remaining }) {
  const titleId = useId();
  const buttonRef = useRef(null);

  useEffect(() => {
    updateModalCount(1);
    return () => updateModalCount(-1);
  }, []);
  useEffect(() => { buttonRef.current?.focus(); }, [notice.id]);

  // Only the button closes it: a click outside or a stray Escape must not
  // dismiss something the person has not read.
  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      data-testid="blocking-notice"
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[440px] max-w-[calc(100vw-48px)] rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-sm font-semibold text-white">{notice.title}</h2>
            {notice.detail && <p className="mt-1 text-xs font-medium text-white/70 break-words">{notice.detail}</p>}
            <p className="mt-2 text-xs leading-relaxed text-white/60 break-words">{notice.message}</p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-[10px] text-white/30">{remaining > 0 ? `${remaining} more after this` : ''}</span>
          <button
            ref={buttonRef}
            type="button"
            onClick={() => dismissBlockingNotice(notice.id)}
            className="rounded-md bg-amber-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-amber-600"
          >
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Shows queued must-dismiss notices one at a time, front and center. */
export function BlockingNoticeHost() {
  const notices = useSyncExternalStore(subscribeBlockingNotices, getBlockingNotices);
  if (notices.length === 0) return null;
  return <BlockingNotice key={notices[0].id} notice={notices[0]} remaining={notices.length - 1} />;
}
