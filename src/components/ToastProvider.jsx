import React, { createContext, useContext, useState, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { generateId } from '../utils/idGenerator';

const ToastContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

const ToastIcon = ({ type }) => {
  switch (type) {
    case 'success':
      return <CheckCircle2 className="text-emerald-400" size={18} />;
    case 'error':
      return <AlertCircle className="text-red-400" size={18} />;
    case 'info':
    default:
      return <Info className="text-blue-400" size={18} />;
  }
};

// Toasts never time out: each stays until its X (or its action) is pressed.
// `duration` is still accepted from callers and ignored. Older toasts collect
// behind the newest one like a stack of cards; hovering or focusing the stack
// fans it out into a scrollable list.
const MAX_TOASTS = 50;
const STACK_PEEK = 3;
const STACK_OFFSET_PX = 12;
const STACK_SCALE_STEP = 0.06;

function isKeyboardFocus(target) {
  try { return !!target?.matches?.(':focus-visible'); } catch { return false; }
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback(({
    title, description, type = 'info', actionLabel = '', onAction = null, dedupeKey = '',
  }) => {
    const id = generateId();
    setToasts((prev) => {
      const normalizedDedupeKey = String(dedupeKey || '');
      // Durable recovery notices are refreshed by a poller. Keep at most one
      // visible copy, while allowing a dismissed notice to be offered again on
      // a later poll.
      if (normalizedDedupeKey && prev.some(toast => toast.dedupeKey === normalizedDedupeKey)) return prev;
      const next = [...prev, {
        id,
        title,
        description,
        type,
        actionLabel: String(actionLabel || ''),
        onAction: typeof onAction === 'function' ? onAction : null,
        dedupeKey: normalizedDedupeKey,
        createdAt: Date.now(),
      }];
      // A bound on memory only: far more than anyone leaves unread.
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    });
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => setToasts([]), []);

  // Toast list changes should not force every useToast consumer in the canvas to
  // render again; only the provider's stable actions belong in context.
  const contextValue = useMemo(() => ({ addToast, removeToast }), [addToast, removeToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <ToastStack toasts={toasts} onRemove={removeToast} onClearAll={clearToasts} />
    </ToastContext.Provider>
  );
}

function ToastStack({ toasts, onRemove, onClearAll }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [frontHeight, setFrontHeight] = useState(0);
  const frontRef = useRef(null);
  // Newest first: the top card is the latest notice.
  const ordered = useMemo(() => [...toasts].reverse(), [toasts]);
  const expanded = (hovered || focused) && ordered.length > 1;
  const frontId = ordered[0]?.id;

  useLayoutEffect(() => {
    const node = frontRef.current;
    if (!node) return undefined;
    const measure = () => setFrontHeight(node.offsetHeight);
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [frontId, expanded]);

  // The last card unmounts under the pointer without a mouseleave, so the
  // next stack would open already fanned out. Reset when it goes.
  const resetPointer = () => { setHovered(false); setFocused(false); };
  const remove = (id) => {
    // The pressed X leaves the DOM while focused, so no blur ever arrives.
    setFocused(false);
    if (ordered.length <= 1) setHovered(false);
    onRemove(id);
  };
  const clearAll = () => { resetPointer(); onClearAll(); };

  if (ordered.length === 0) {
    return <div role="region" aria-label="Notifications" aria-live="polite" className="fixed top-4 right-4 z-[10001] pointer-events-none" />;
  }

  const peekCount = Math.min(ordered.length - 1, STACK_PEEK);
  const collapsedHeight = frontHeight + peekCount * STACK_OFFSET_PX;

  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      data-testid="toast-stack"
      data-expanded={expanded ? 'true' : 'false'}
      className="fixed top-2 right-2 z-[10001] w-[22rem] pt-2 pr-2 pointer-events-none"
    >
      <div
        className="pointer-events-auto"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        // Keyboard focus fans the stack out; a mouse click is covered by hover.
        onFocus={(event) => { if (isKeyboardFocus(event.target)) setFocused(true); }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        {/* One keyed tree for both layouts: cards never remount when the stack
            opens or closes, so a focused X keeps its focus. */}
        <div
          className={expanded
            ? 'flex flex-col gap-3 max-h-[calc(100vh-2rem)] overflow-y-auto overflow-x-hidden overscroll-contain -mt-2 -mr-2 pt-2 pr-2'
            : 'relative transition-[height] duration-200'}
          style={expanded || !frontHeight ? undefined : { height: collapsedHeight }}
        >
          {ordered.map((toast, depth) => {
            const isFront = depth === 0;
            const tucked = !expanded && !isFront;
            const peeking = tucked && depth <= STACK_PEEK;
            return (
              <div
                key={toast.id}
                ref={isFront ? frontRef : undefined}
                aria-hidden={tucked ? 'true' : undefined}
                inert={tucked ? true : undefined}
                data-stack-peek={peeking ? 'true' : undefined}
                className={tucked
                  ? 'absolute inset-x-0 top-0 overflow-hidden rounded-xl transition-transform duration-200'
                  : 'relative'}
                style={tucked ? {
                  display: peeking ? undefined : 'none',
                  zIndex: STACK_PEEK + 1 - depth,
                  transform: `translateY(${depth * STACK_OFFSET_PX}px) scale(${1 - depth * STACK_SCALE_STEP})`,
                  transformOrigin: 'bottom center',
                  height: frontHeight || undefined,
                  opacity: 1 - depth * 0.18,
                } : { zIndex: STACK_PEEK + 1 }}
              >
                <ToastCard toast={toast} onRemove={remove} />
                {/* Cards underneath show only their edge, never their text. */}
                {tucked && <div data-testid="toast-stack-edge" className="absolute inset-0 rounded-xl border border-white/25 bg-neutral-600 shadow-md shadow-black/30" />}
              </div>
            );
          })}
          {expanded ? (
            // Below the cards, so opening the stack never slides it under a
            // pointer that was aiming at the top card's X.
            <div className="flex items-center justify-between px-1 pb-1 text-[11px] text-white/60">
              <span>{ordered.length} notifications</span>
              <button
                type="button"
                onClick={clearAll}
                className="rounded px-1.5 py-0.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
              >
                Clear all
              </button>
            </div>
          ) : ordered.length > 1 && (
            <div className="absolute -bottom-5 right-2 text-[10px] text-white/50" aria-hidden="true">
              +{ordered.length - 1} more
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const ICON_TILE = {
  success: 'bg-emerald-500/15 text-emerald-300',
  error: 'bg-red-500/15 text-red-300',
  info: 'bg-blue-500/15 text-blue-300',
};

function toastTime(createdAt) {
  if (!Number.isFinite(createdAt)) return '';
  const when = new Date(createdAt);
  const today = new Date().toDateString() === when.toDateString();
  return today
    ? when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function ToastCard({ toast, onRemove }) {
  const time = toastTime(toast.createdAt);
  return (
    <div className="relative w-full bg-neutral-900 border border-white/10 shadow-lg shadow-black/30 rounded-xl p-3 flex items-start gap-3 pointer-events-auto animate-in slide-in-from-right-4 fade-in duration-300">
      <div className={`shrink-0 w-11 h-11 rounded-lg flex items-center justify-center [&>svg]:text-current ${ICON_TILE[toast.type] || ICON_TILE.info}`}>
        <ToastIcon type={toast.type} />
      </div>
      <div className="flex-1 min-w-0 pr-1">
        <div className="text-white text-sm font-semibold break-words">{toast.title}</div>
        {toast.description && (
          <div className="text-white/60 text-xs mt-0.5 break-words">{toast.description}</div>
        )}
        {toast.actionLabel && toast.onAction && (
          <button
            type="button"
            onClick={() => {
              onRemove(toast.id);
              void toast.onAction();
            }}
            className="mt-2 rounded-md border border-white/15 bg-white/10 px-2 py-1 text-xs font-medium text-white/80 transition-colors hover:bg-white/15 hover:text-white"
          >
            {toast.actionLabel}
          </button>
        )}
        {time && <div className="mt-1.5 text-right text-[10px] text-white/40">{time}</div>}
      </div>
      <button
        type="button"
        aria-label={`Dismiss ${toast.title || 'notification'}`}
        onClick={() => onRemove(toast.id)}
        className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-neutral-700 text-white/70 shadow-md transition-colors hover:bg-neutral-600 hover:text-white"
      >
        <X size={12} />
      </button>
    </div>
  );
}
