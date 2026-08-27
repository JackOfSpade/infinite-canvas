import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ClipboardCopy, FolderOpen, LoaderCircle, Paperclip, Send, XCircle } from 'lucide-react';
import { updateModalCount } from './modalStack';

const stringifyValidationError = (value) => {
  if (Array.isArray(value)) return value.filter(Boolean).join('\n');
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return value.message || value.error || JSON.stringify(value);
  }
  return '';
};

const requestLabel = (request) => {
  if (!request) return 'AI response';
  const task = request.task || 'AI response';
  const itemLabel = Number.isFinite(request.itemCount)
    ? ` · ${request.itemCount} ${request.itemCount === 1 ? 'item' : 'items'}`
    : '';
  if (Number.isFinite(request.batch) && Number.isFinite(request.batchTotal)) {
    return `${task} · batch ${request.batch} of ${request.batchTotal}${itemLabel}`;
  }
  if (Number.isFinite(request.batch)) return `${task} · batch ${request.batch}${itemLabel}`;
  return `${task}${itemLabel}`;
};

const attachmentName = (filePath) => String(filePath || '').split(/[/\\]/).filter(Boolean).pop() || 'Attachment';

/**
 * Global manual-AI handoff UI. It deliberately has no close action: closing a
 * prompt would leave its corresponding main-process promise pending. The
 * explicit Cancel task action rejects the matching request and cancels its
 * owning job operation; `non-api-ai-settled` then removes it from this queue.
 */
export function NonApiAiDialog() {
  const [requests, setRequests] = useState([]);
  const [selectedRequestId, setSelectedRequestId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [errors, setErrors] = useState({});
  const [submittingRequestIds, setSubmittingRequestIds] = useState(() => new Set());
  const [cancellingRequestIds, setCancellingRequestIds] = useState(() => new Set());
  const [acceptedRequestIds, setAcceptedRequestIds] = useState(() => new Set());
  const [copiedRequestId, setCopiedRequestId] = useState(null);
  const responseRef = useRef(null);
  const dialogRef = useRef(null);
  const copiedTimerRef = useRef(null);
  const activeRequestIdRef = useRef(null);
  const requestsRef = useRef([]);
  const previousFocusRef = useRef(null);
  const actionRequestIdsRef = useRef(new Set());

  const activeRequest = requests.find(request => request.requestId === selectedRequestId) || requests[0] || null;
  const activeRequestId = activeRequest?.requestId || null;
  const activeNodeId = activeRequest?.nodeId || null;
  // Async clipboard/IPC completions must never update whichever queued prompt
  // happened to become active while they were in flight.
  activeRequestIdRef.current = activeRequestId;
  const activeResponse = activeRequestId ? (drafts[activeRequestId] || '') : '';
  const activeError = activeRequestId ? (errors[activeRequestId] || '') : '';
  const isSubmitting = activeRequestId ? submittingRequestIds.has(activeRequestId) : false;
  const isCancelling = activeRequestId ? cancellingRequestIds.has(activeRequestId) : false;
  const isAccepted = activeRequestId ? acceptedRequestIds.has(activeRequestId) : false;
  const isCopied = copiedRequestId === activeRequestId;

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onNonApiAiRequest || !api?.onNonApiAiSettled) return undefined;

    const removeRequest = (payload) => {
      const requestId = typeof payload === 'string' ? payload : payload?.requestId;
      if (!requestId) return;
      const currentRequests = requestsRef.current;
      const settledIndex = currentRequests.findIndex(request => request.requestId === requestId);
      const replacement = settledIndex >= 0
        ? currentRequests[settledIndex + 1] || currentRequests[settledIndex - 1] || null
        : null;
      setRequests(previous => previous.filter(request => request.requestId !== requestId));
      if (activeRequestIdRef.current === requestId) setSelectedRequestId(replacement?.requestId || null);
      else setSelectedRequestId(previous => previous === requestId ? replacement?.requestId || null : previous);
      setDrafts(previous => {
        if (!(requestId in previous)) return previous;
        const { [requestId]: _removed, ...remaining } = previous;
        return remaining;
      });
      setErrors(previous => {
        if (!(requestId in previous)) return previous;
        const { [requestId]: _removed, ...remaining } = previous;
        return remaining;
      });
      setSubmittingRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
      setCancellingRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
      setAcceptedRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
      setCopiedRequestId(previous => previous === requestId ? null : previous);
    };

    const receiveRequest = (incoming) => {
      if (!incoming?.requestId || typeof incoming.prompt !== 'string') return;
      const validationError = stringifyValidationError(incoming.validationError);
      setRequests(previous => {
        const index = previous.findIndex(request => request.requestId === incoming.requestId);
        if (index === -1) return [...previous, incoming];
        const next = [...previous];
        next[index] = { ...next[index], ...incoming };
        return next;
      });
      if (validationError) {
        setErrors(previous => ({ ...previous, [incoming.requestId]: validationError }));
        setAcceptedRequestIds(previous => {
          if (!previous.has(incoming.requestId)) return previous;
          const next = new Set(previous);
          next.delete(incoming.requestId);
          return next;
        });
      }
    };

    // Both listeners are registered before replaying outstanding prompts.
    // This closes both races: a job can issue its first request from a sibling
    // mount effect, and this app-level dialog can remount while the same
    // renderer frame remains live. `receiveRequest` de-duplicates replays by
    // request id. A true renderer navigation cancels its job in the main
    // process rather than preserving a prompt with no response UI.
    const unsubscribeRequest = api.onNonApiAiRequest(receiveRequest);
    const unsubscribeSettled = api.onNonApiAiSettled(removeRequest);
    void api.replayPendingNonApiAiRequests?.().catch(() => {
      // The ordinary live IPC listeners still work if an older main process
      // does not yet provide replay support.
    });
    return () => {
      unsubscribeRequest?.();
      unsubscribeSettled?.();
    };
  }, []);

  requestsRef.current = requests;

  const hasPendingRequests = requests.length > 0;

  // Keep all canvas keyboard controls dormant while this non-dismissable
  // prompt owns the user's typing. Track queue presence rather than the active
  // request object so a validation retry or a move to the next queued request
  // cannot briefly drop the modal count to zero.
  useEffect(() => {
    if (!hasPendingRequests) return undefined;
    previousFocusRef.current = document.activeElement;
    updateModalCount(1);
    return () => {
      updateModalCount(-1);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous?.isConnected && typeof previous.focus === 'function') previous.focus();
    };
  }, [hasPendingRequests]);

  useLayoutEffect(() => {
    if (!activeRequestId || isAccepted) return;
    responseRef.current?.focus();
  }, [activeRequestId, isAccepted]);

  // This listener is registered for the life of the app-level dialog, before
  // transient modal listeners are mounted. Escape must not close a lightbox or
  // another dialog underneath this non-dismissable handoff.
  useLayoutEffect(() => {
    const blockEscape = (event) => {
      if (event.key !== 'Escape' || !activeRequestIdRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', blockEscape, true);
    return () => window.removeEventListener('keydown', blockEscape, true);
  }, []);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const setActiveResponse = useCallback((response) => {
    if (!activeRequestId) return;
    setDrafts(previous => ({ ...previous, [activeRequestId]: response }));
    setErrors(previous => {
      if (!previous[activeRequestId]) return previous;
      const { [activeRequestId]: _cleared, ...remaining } = previous;
      return remaining;
    });
  }, [activeRequestId]);

  const copyPrompt = useCallback(async () => {
    if (!activeRequest?.prompt) return;
    const requestId = activeRequest.requestId;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(activeRequest.prompt);
      setCopiedRequestId(requestId);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null;
        setCopiedRequestId(previous => previous === requestId ? null : previous);
      }, 2000);
    } catch (error) {
      setErrors(previous => ({
        ...previous,
        [requestId]: error?.message || 'Could not copy the prompt. Select it and copy manually.',
      }));
    }
  }, [activeRequest]);

  const revealAttachment = useCallback(async (filePath) => {
    if (!activeRequestId || !filePath) return;
    const requestId = activeRequestId;
    try {
      if (!window.electronAPI?.revealNonApiAiAttachment) {
        throw new Error('Showing attachments in Finder is unavailable.');
      }
      await window.electronAPI.revealNonApiAiAttachment(requestId, filePath);
    } catch (error) {
      setErrors(previous => ({
        ...previous,
        [requestId]: error?.message || 'Could not show that attachment in Finder.',
      }));
    }
  }, [activeRequestId]);

  const submit = useCallback(async (event) => {
    event?.preventDefault();
    if (!activeRequestId || !activeResponse.trim() || isSubmitting || isCancelling || isAccepted) return;
    if (actionRequestIdsRef.current.has(activeRequestId)) return;
    if (!window.electronAPI?.submitNonApiAiResponse) {
      setErrors(previous => ({ ...previous, [activeRequestId]: 'Manual AI response submission is unavailable.' }));
      return;
    }

    const requestId = activeRequestId;
    actionRequestIdsRef.current.add(requestId);
    setSubmittingRequestIds(previous => new Set(previous).add(requestId));
    setErrors(previous => {
      const { [activeRequestId]: _cleared, ...remaining } = previous;
      return remaining;
    });
    try {
      const result = await window.electronAPI.submitNonApiAiResponse({
        requestId,
        response: activeResponse,
      });
      if (result?.accepted) {
        // Do not close optimistically. The settled event is the authoritative
        // signal that this particular request has left the main-process queue.
        setAcceptedRequestIds(previous => new Set(previous).add(requestId));
      } else {
        const detail = stringifyValidationError(result?.validationErrors) ||
          stringifyValidationError(result?.error) ||
          'That response could not be validated. Adjust it and try again.';
        setErrors(previous => ({ ...previous, [requestId]: detail }));
      }
    } catch (error) {
      setErrors(previous => ({
        ...previous,
        [requestId]: error?.message || 'Could not submit that response. Please try again.',
      }));
    } finally {
      actionRequestIdsRef.current.delete(requestId);
      setSubmittingRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
    }
  }, [activeRequestId, activeResponse, isAccepted, isCancelling, isSubmitting]);

  const cancelTask = useCallback(async () => {
    if (!activeRequestId || isSubmitting || isCancelling || isAccepted) return;
    if (actionRequestIdsRef.current.has(activeRequestId)) return;
    if (!window.electronAPI?.cancelNonApiAiRequest) {
      setErrors(previous => ({ ...previous, [activeRequestId]: 'Manual AI task cancellation is unavailable.' }));
      return;
    }

    const requestId = activeRequestId;
    actionRequestIdsRef.current.add(requestId);
    setCancellingRequestIds(previous => new Set(previous).add(requestId));
    try {
      const result = await window.electronAPI.cancelNonApiAiRequest(requestId);
      if (!result?.cancelled) {
        setErrors(previous => ({
          ...previous,
          [requestId]: result?.error || 'This task is no longer pending and could not be cancelled.',
        }));
      } else if (result.nodeCancelled && activeNodeId) {
        // The main process can abort the request immediately, but the owning
        // React component does not otherwise know that the user chose Cancel
        // in this app-level dialog. Tell it to run its normal reset path so it
        // clears transient state instead of rendering the abort as an error.
        document.dispatchEvent(new CustomEvent('non-api-ai-node-cancelled', {
          detail: { nodeId: activeNodeId },
        }));
      }
      // As with accepted responses, wait for the request-specific settled
      // event instead of closing whichever item happens to be active now.
    } catch (error) {
      setErrors(previous => ({
        ...previous,
        [requestId]: error?.message || 'Could not cancel this task. Please try again.',
      }));
    } finally {
      actionRequestIdsRef.current.delete(requestId);
      setCancellingRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
    }
  }, [activeRequestId, activeNodeId, isAccepted, isCancelling, isSubmitting]);

  const trapFocus = useCallback((event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )].filter(element => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }, []);

  const queueLabel = useMemo(() => {
    if (requests.length < 2) return null;
    return `${requests.length} pending`;
  }, [requests.length]);

  if (!activeRequest) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[11000] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="presentation"
      onKeyDown={trapFocus}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="non-api-ai-dialog-title"
        aria-busy={isSubmitting || isCancelling || isAccepted}
        className="w-full max-w-4xl max-h-[calc(100vh-2rem)] overflow-hidden rounded-2xl border border-violet-400/25 bg-neutral-900 shadow-2xl flex flex-col"
      >
        <header className="shrink-0 px-5 py-4 border-b border-white/10">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 h-8 w-8 shrink-0 rounded-lg bg-violet-500/15 border border-violet-400/25 flex items-center justify-center">
              <ClipboardCopy size={16} className="text-violet-300" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="non-api-ai-dialog-title" className="text-sm font-semibold text-white">
                Non-API AI handoff
              </h2>
              <p aria-live="polite" aria-atomic="true" className="mt-0.5 text-xs text-white/55 break-words">{requestLabel(activeRequest)}</p>
            </div>
            {queueLabel && <span className="shrink-0 text-[11px] text-white/40">{queueLabel}</span>}
          </div>
          {requests.length > 1 && (
            <nav aria-label="Pending AI handoff batches" className="mt-3 -mb-1 overflow-x-auto custom-scrollbar">
              <div className="flex min-w-max gap-1.5 pb-1">
                {requests.map((request, index) => {
                  const selected = request.requestId === activeRequestId;
                  const hasDraft = Boolean(drafts[request.requestId]?.trim());
                  const hasError = Boolean(errors[request.requestId]);
                  const isWorking = submittingRequestIds.has(request.requestId)
                    || cancellingRequestIds.has(request.requestId)
                    || acceptedRequestIds.has(request.requestId);
                  const count = Number.isFinite(request.itemCount) ? ` · ${request.itemCount}` : '';
                  const label = Number.isFinite(request.batch) ? `Batch ${request.batch}${count}` : `Prompt ${index + 1}${count}`;
                  return (
                    <button
                      key={request.requestId}
                      type="button"
                      onClick={() => setSelectedRequestId(request.requestId)}
                      aria-current={selected ? 'page' : undefined}
                      aria-label={`${label}: ${requestLabel(request)}${hasDraft ? ', response pasted' : ''}${hasError ? ', needs correction' : ''}`}
                      title={requestLabel(request)}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${selected
                        ? 'border-violet-300/60 bg-violet-500/20 text-violet-100'
                        : 'border-white/10 bg-black/20 text-white/60 hover:border-violet-400/35 hover:text-white/85'}`}
                    >
                      <span>{label}</span>
                      {(hasDraft || isWorking || hasError) && (
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 rounded-full ${hasError ? 'bg-red-300' : isWorking ? 'bg-amber-300' : 'bg-emerald-300'}`}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </nav>
          )}
        </header>

        <form onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto p-5 flex flex-col gap-4 custom-scrollbar">
          <p className="text-sm leading-relaxed text-white/70">
            Copy this exact prompt into your AI chat, then paste its complete response below. This task stays open until the response validates or the running job is cancelled.
          </p>

          {activeRequest.attachments?.length > 0 && (
            <section aria-labelledby="non-api-ai-attachments-title" className="rounded-lg border border-amber-400/25 bg-amber-500/10 p-3">
              <div className="flex items-center gap-2 text-amber-100">
                <Paperclip size={14} aria-hidden="true" />
                <h3 id="non-api-ai-attachments-title" className="text-xs font-semibold uppercase tracking-wider">Attachments required</h3>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-amber-100/70">Attach {activeRequest.attachments.length === 1 ? 'this file' : 'these files'} to your AI chat before sending the prompt.</p>
              <ul className="mt-2 space-y-2">
                {activeRequest.attachments.map((filePath) => (
                  <li key={filePath} className="flex items-center gap-2 rounded-md border border-white/10 bg-black/20 p-2">
                    <span className="min-w-0 flex-1 font-mono text-xs text-white/75 break-all" title={filePath}>{filePath}</span>
                    <button
                      type="button"
                      onClick={() => revealAttachment(filePath)}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-amber-300/30 bg-amber-400/10 px-2.5 py-1.5 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-400/20"
                      title={`Show ${attachmentName(filePath)} in Finder`}
                    >
                      <FolderOpen size={13} aria-hidden="true" />
                      Show in Finder
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-col gap-2 min-h-0">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="non-api-ai-prompt" className="text-xs font-medium text-white/65 uppercase tracking-wider">Prompt</label>
              <button
                type="button"
                onClick={copyPrompt}
                className="inline-flex items-center gap-1.5 rounded-md border border-violet-400/30 bg-violet-500/15 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-500/25 transition-colors"
              >
                {isCopied ? <Check size={13} aria-hidden="true" /> : <ClipboardCopy size={13} aria-hidden="true" />}
                {isCopied ? 'Copied' : 'Copy prompt'}
              </button>
            </div>
            <textarea
              id="non-api-ai-prompt"
              readOnly
              value={activeRequest.prompt}
              onFocus={(event) => event.currentTarget.select()}
              className="h-48 w-full resize-y rounded-lg border border-white/10 bg-black/35 p-3 font-mono text-xs leading-relaxed text-white/80 outline-none focus:border-violet-400/60"
              aria-label="Prompt to send to your AI chat"
              spellCheck={false}
            />
          </div>

          <div className="flex flex-col gap-2 min-h-0">
            <label htmlFor="non-api-ai-response" className="text-xs font-medium text-white/65 uppercase tracking-wider">Paste AI response</label>
            <textarea
              ref={responseRef}
              id="non-api-ai-response"
              value={activeResponse}
              onChange={(event) => setActiveResponse(event.target.value)}
              disabled={isSubmitting || isCancelling || isAccepted}
              placeholder="Paste the full response here…"
              className="h-44 w-full resize-y rounded-lg border border-white/15 bg-black/45 p-3 font-mono text-xs leading-relaxed text-white placeholder:text-white/30 outline-none focus:border-violet-400/60 disabled:opacity-60"
              aria-describedby={activeError ? 'non-api-ai-validation-error' : undefined}
              spellCheck={false}
            />
          </div>

          {activeError && (
            <div id="non-api-ai-validation-error" role="alert" className="flex items-start gap-2 rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200 whitespace-pre-wrap">
              <XCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{activeError}</span>
            </div>
          )}

          <div className="shrink-0 flex items-center justify-between gap-3 pt-1">
            <span className="text-xs text-white/40" aria-live="polite">
              {isAccepted ? 'Response accepted — continuing task…' : isCancelling ? 'Cancelling the owning job operation…' : 'Cancel task stops the owning job operation. You can retry as many times as needed.'}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={cancelTask}
                disabled={isSubmitting || isCancelling || isAccepted}
                className="rounded-md border border-red-400/30 px-3 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                title="Cancel the job operation waiting for this AI response"
              >
                {isCancelling ? 'Cancelling…' : 'Cancel task'}
              </button>
              <button
                type="submit"
                disabled={!activeResponse.trim() || isSubmitting || isCancelling || isAccepted}
                className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
                {isSubmitting ? 'Validating…' : isAccepted ? 'Accepted' : 'Submit response'}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}
