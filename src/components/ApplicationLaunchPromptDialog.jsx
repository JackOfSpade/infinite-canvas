import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ClipboardCopy, X } from 'lucide-react';
import { updateModalCount } from './modalStack';

export function ApplicationLaunchPromptDialog({ prompt, onClose }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const dialogRef = useRef(null);
  const copiedTimerRef = useRef(null);
  const previousFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!prompt) return undefined;
    previousFocusRef.current = document.activeElement;
    updateModalCount(1);
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // This prompt owns keyboard input while open; do not let Escape reach
      // an underlying canvas control or a lower-priority dialog as it closes.
      event.stopImmediatePropagation();
      onCloseRef.current?.();
    };
    window.addEventListener('keydown', closeOnEscape, true);
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', closeOnEscape, true);
      updateModalCount(-1);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous?.isConnected && typeof previous.focus === 'function') previous.focus();
    };
  }, [prompt]);

  useEffect(() => () => {
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
  }, []);

  const copyPrompt = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(prompt);
      setCopyError('');
      setCopied(true);
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopied(false);
      }, 2000);
    } catch (error) {
      setCopyError(error?.message || 'Could not copy the prompt. Select it and copy manually.');
    }
  }, [prompt]);

  const trapFocus = useCallback((event) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }, []);

  if (!prompt) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[11000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current?.();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="application-launch-prompt-title"
        tabIndex={-1}
        onKeyDown={trapFocus}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-emerald-400/25 bg-neutral-900 shadow-2xl outline-none"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-white/10 px-5 py-4">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-emerald-400/25 bg-emerald-500/15">
            <ClipboardCopy size={16} className="text-emerald-300" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="application-launch-prompt-title" className="text-sm font-semibold text-white">Application bundle launch prompt</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-white/55">
              Paste this into any local coding agent with filesystem access. No response needs to be pasted back here.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onCloseRef.current?.()}
            className="rounded-md p-1.5 text-white/45 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Close launch prompt"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5 custom-scrollbar">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium uppercase tracking-wider text-white/65">Prompt</span>
            <button
              type="button"
              onClick={copyPrompt}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/30 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-500/25"
            >
              {copied ? <Check size={13} aria-hidden="true" /> : <ClipboardCopy size={13} aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy prompt'}
            </button>
          </div>
          <textarea
            readOnly
            value={prompt}
            onFocus={(event) => event.currentTarget.select()}
            className="h-[28rem] min-h-64 w-full resize-y rounded-lg border border-white/10 bg-black/35 p-3 font-mono text-xs leading-relaxed text-white/80 outline-none focus:border-emerald-400/60"
            aria-label="Application bundle prompt to send to a local coding agent"
            spellCheck={false}
          />
          {copyError && <p role="alert" className="text-xs text-red-300">{copyError}</p>}
          <p className="text-xs leading-relaxed text-white/40">
            Infinite Canvas will watch the generated local job, validate its result, and save the final bundle beside the canvas.
          </p>
        </div>
      </section>
    </div>,
    document.body,
  );
}
