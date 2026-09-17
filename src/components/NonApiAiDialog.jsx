import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, ChevronDown, ChevronUp, ClipboardCopy, FolderOpen, LoaderCircle, Paperclip, Send, XCircle } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { EventLogger } from '../utils/EventLogger';

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
  const attemptLabel = request.attemptKind === 'partial-recovery'
    ? 'partial recovery for '
    : request.attemptKind === 'split' ? 'split retry for ' : '';
  const itemLabel = Number.isFinite(request.itemCount)
    ? ` · ${request.itemCount} ${request.itemCount === 1 ? 'item' : 'items'}`
    : '';
  const rootLabel = request.attemptKind !== 'initial'
    && Number.isFinite(request.rootBatchSize)
    && request.rootBatchSize !== request.itemCount
    ? ` · ${request.rootBatchSize}-item root batch`
    : '';
  // Overall progress through the task, not just this handoff's position in the
  // batch list: with ~25 batches the useful question is "how many left", and a
  // batch number alone does not answer it when batches vary in size.
  const progressLabel = Number.isFinite(request.itemsDone) && Number.isFinite(request.itemsTotal)
    && request.itemsTotal > 0
    ? ` · ${request.itemsDone}/${request.itemsTotal} done`
    : '';
  if (Number.isFinite(request.batch) && Number.isFinite(request.batchTotal)) {
    return `${task} · ${attemptLabel}batch ${request.batch} of ${request.batchTotal}${itemLabel}${rootLabel}${progressLabel}`;
  }
  if (Number.isFinite(request.batch)) return `${task} · ${attemptLabel}batch ${request.batch}${itemLabel}${rootLabel}${progressLabel}`;
  return `${task}${attemptLabel ? ` · ${attemptLabel.trim()}` : ''}${itemLabel}${rootLabel}${progressLabel}`;
};

const attachmentName = (filePath) => String(filePath || '').split(/[/\\]/).filter(Boolean).pop() || 'Attachment';

// Node ids are opaque persistence keys, not useful labels for a person who
// returns to several pending Job Search hubs. Give each owner a short,
// deterministic badge without displaying (or deriving a readable fragment
// from) that internal identifier.
const ownerBadgeForNode = (nodeId) => {
  const value = typeof nodeId === 'string' ? nodeId.trim() : '';
  if (!value) return null;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return `Hub ${((hash >>> 0).toString(36).toUpperCase()).padStart(7, '0')}`;
};

/**
 * Global manual-AI handoff dock. A pending request is deliberately never
 * dismissed: Minimize only collapses this renderer UI, while Cancel task
 * rejects the matching request and cancels its owning job operation.
 */
export function NonApiAiDialog() {
  const [requests, setRequests] = useState([]);
  const [selectedRequestId, setSelectedRequestId] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [errors, setErrors] = useState({});
  const [submittingRequestIds, setSubmittingRequestIds] = useState(() => new Set());
  const [steppingBackRequestIds, setSteppingBackRequestIds] = useState(() => new Set());
  const [cancellingRequestIds, setCancellingRequestIds] = useState(() => new Set());
  const [acceptedRequestIds, setAcceptedRequestIds] = useState(() => new Set());
  const [copiedRequestId, setCopiedRequestId] = useState(null);
  // Holds the full ownership tuple captured when the confirm opens. The confirm
  // is async and a settled event can swap the active request underneath it, so
  // the prompt must act on what the user was actually looking at.
  const [cancelConfirmTarget, setCancelConfirmTarget] = useState(null);
  const dockButtonRef = useRef(null);
  const copiedTimerRef = useRef(null);
  const activeRequestIdRef = useRef(null);
  const requestsRef = useRef([]);
  const actionRequestIdsRef = useRef(new Set());

  const activeRequest = requests.find(request => request.requestId === selectedRequestId) || requests[0] || null;
  const activeRequestId = activeRequest?.requestId || null;
  // Async clipboard/IPC completions must never update whichever queued prompt
  // happened to become active while they were in flight.
  activeRequestIdRef.current = activeRequestId;
  const activeResponse = activeRequestId ? (drafts[activeRequestId] || '') : '';
  const activeError = activeRequestId ? (errors[activeRequestId] || '') : '';
  const isSubmitting = activeRequestId ? submittingRequestIds.has(activeRequestId) : false;
  const isSteppingBack = activeRequestId ? steppingBackRequestIds.has(activeRequestId) : false;
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
      setSteppingBackRequestIds(previous => {
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
      if (incoming.nodeId && incoming.runId) {
        document.dispatchEvent(new CustomEvent('non-api-ai-node-pending', {
          detail: {
            nodeId: incoming.nodeId,
            runId: incoming.runId,
            task: incoming.task || null,
            stepKey: incoming.stepKey || null,
            recoveryMode: incoming.recoveryMode || null,
          },
        }));
      }
      const validationError = stringifyValidationError(incoming.validationError);
      setRequests(previous => {
        const index = previous.findIndex(request => request.requestId === incoming.requestId);
        if (index >= 0) {
          const next = [...previous];
          next[index] = { ...next[index], ...incoming };
          return next;
        }
        // Arrival order is NOT batch order. Every top-level scoring batch is
        // dispatched in a single Promise.all pass (jobs.js), and only a batch
        // holding MORE than one item awaits the context-window preflight first
        // — so a 1-item batch issues its handoff inside that synchronous pass
        // and lands here ahead of its lower-numbered siblings (61 jobs at 15/
        // batch arrived 5,1,2,3,4). Insert by batch number rather than
        // appending so the chip strip, the `requests[0]` default selection, and
        // removeRequest's adjacency fallback all follow the order the person is
        // asked to work through. Ordering is scoped to one owner (same node +
        // task); unrelated or unnumbered handoffs keep arrival order by falling
        // through to the end.
        const next = [...previous];
        let at = next.length;
        for (let i = 0; i < next.length; i += 1) {
          const queued = next[i];
          if (queued.nodeId === incoming.nodeId
            && queued.task === incoming.task
            && Number.isFinite(queued.batch)
            && Number.isFinite(incoming.batch)
            && queued.batch > incoming.batch) { at = i; break; }
        }
        next.splice(at, 0, incoming);
        return next;
      });
      if (typeof incoming.initialResponse === 'string' && incoming.initialResponse) {
        setDrafts(previous => (
          previous[incoming.requestId] === undefined
            ? { ...previous, [incoming.requestId]: incoming.initialResponse }
            : previous
        ));
        // A non-empty initial response is emitted only by a genuine rewind.
        // Bring that reissued predecessor to the front even if unrelated
        // handoffs are also queued in the global dialog.
        setSelectedRequestId(incoming.requestId);
      }
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

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const setActiveResponse = useCallback((response) => {
    if (!activeRequestId) return;
    setDrafts(previous => ({ ...previous, [activeRequestId]: response }));
    // Queue every edit in the main process. Writes are serialized there, and
    // the window-close handshake waits for that queue before destroying the
    // renderer, so even a close immediately after Paste retains the draft.
    void window.electronAPI?.updateNonApiAiDraft?.(activeRequestId, response).catch(() => {});
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
    if (!activeRequestId || !activeResponse.trim() || isSubmitting || isSteppingBack || isCancelling || isAccepted) return;
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
  }, [activeRequestId, activeResponse, isAccepted, isCancelling, isSteppingBack, isSubmitting]);

  const stepBack = useCallback(async () => {
    if (!activeRequestId || !activeRequest?.canStepBack || isSubmitting || isSteppingBack || isCancelling || isAccepted) return;
    if (actionRequestIdsRef.current.has(activeRequestId)) return;
    if (!window.electronAPI?.stepBackNonApiAiRequest) {
      setErrors(previous => ({ ...previous, [activeRequestId]: 'Returning to the previous AI step is unavailable.' }));
      return;
    }

    const requestId = activeRequestId;
    actionRequestIdsRef.current.add(requestId);
    setSteppingBackRequestIds(previous => new Set(previous).add(requestId));
    setErrors(previous => {
      const { [requestId]: _cleared, ...remaining } = previous;
      return remaining;
    });
    try {
      const result = await window.electronAPI.stepBackNonApiAiRequest(requestId);
      if (!result?.steppedBack) {
        setErrors(previous => ({
          ...previous,
          [requestId]: result?.error || 'Could not return to the previous AI step.',
        }));
      }
      // The settled event removes this request; its owning workflow then
      // emits the preceding prompt as a new request with the accepted paste
      // restored for editing.
    } catch (error) {
      setErrors(previous => ({
        ...previous,
        [requestId]: error?.message || 'Could not return to the previous AI step.',
      }));
    } finally {
      actionRequestIdsRef.current.delete(requestId);
      setSteppingBackRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
    }
  }, [activeRequest, activeRequestId, isAccepted, isCancelling, isSteppingBack, isSubmitting]);

  const performCancelTask = useCallback(async ({ requestId, nodeId, runId }) => {
    // Entry guards live in requestCancelConfirm; re-check only what can have
    // changed while the confirmation was open.
    if (!requestId || actionRequestIdsRef.current.has(requestId)) return;
    if (!requestsRef.current.some(request => request.requestId === requestId)) return;

    // Ownership was captured when the prompt opened: the settled event can
    // change the selected request while the confirm is up or while the
    // cancellation is in flight.
    const cancelledNodeId = nodeId || null;
    const cancelledRunId = runId || null;
    actionRequestIdsRef.current.add(requestId);
    setCancellingRequestIds(previous => new Set(previous).add(requestId));
    try {
      const result = await window.electronAPI.cancelNonApiAiRequest(requestId);
      if (!result?.cancelled) {
        setErrors(previous => ({
          ...previous,
          [requestId]: result?.error || 'This task is no longer pending and could not be cancelled.',
        }));
      } else if (result.nodeCancelled && cancelledNodeId) {
        // The main process can abort the request immediately, but the owning
        // React component does not otherwise know that the user chose Cancel
        // in this app-level dialog. Include the immutable run identity so the
        // owner can route an active Board child through exact rollback without
        // letting a late event reset a newer run on the same node.
        document.dispatchEvent(new CustomEvent('non-api-ai-node-cancelled', {
          detail: { nodeId: cancelledNodeId, runId: cancelledRunId },
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
  }, []);

  const requestCancelConfirm = useCallback(() => {
    if (!activeRequestId || isSubmitting || isSteppingBack || isCancelling || isAccepted) return;
    if (actionRequestIdsRef.current.has(activeRequestId)) return;
    if (!window.electronAPI?.cancelNonApiAiRequest) {
      setErrors(previous => ({ ...previous, [activeRequestId]: 'Manual AI task cancellation is unavailable.' }));
      return;
    }
    EventLogger.log('ConfirmDialog requested: title="Cancel this AI task?"');
    setCancelConfirmTarget({
      requestId: activeRequestId,
      nodeId: activeRequest?.nodeId || null,
      runId: activeRequest?.runId || null,
      label: activeRequest ? requestLabel(activeRequest) : '',
    });
  }, [activeRequest, activeRequestId, isAccepted, isCancelling, isSteppingBack, isSubmitting]);

  // Self-dismiss if the request settles while the confirm is open, so Confirm
  // can never act on a request id that is already gone.
  useEffect(() => {
    if (cancelConfirmTarget && !requests.some(request => request.requestId === cancelConfirmTarget.requestId)) {
      setCancelConfirmTarget(null);
    }
  }, [cancelConfirmTarget, requests]);

  const minimize = useCallback(() => {
    setIsExpanded(false);
    // Collapsing removes the button that initiated this action. Return focus
    // to the still-available compact control without making the dock modal.
    requestAnimationFrame(() => dockButtonRef.current?.focus());
  }, []);

  const queueLabel = useMemo(() => {
    if (requests.length < 2) return null;
    return `${requests.length} pending`;
  }, [requests.length]);

  const multipleHubQueue = useMemo(() => {
    const owners = new Set(requests
      .map(request => typeof request.nodeId === 'string' ? request.nodeId.trim() : '')
      .filter(Boolean));
    return owners.size > 1;
  }, [requests]);

  if (!activeRequest) return null;

  const dockLabel = requests.length === 1 ? '1 handoff waiting' : `${requests.length} handoffs waiting`;

  return createPortal(
    // The dock normally sits above everything (z-11000/11001). ConfirmDialog
    // self-portals to the body at z-10000, so while the cancel confirmation is
    // open the dock must drop BELOW it — otherwise the opaque dock panel covers
    // the confirm card (entirely, on a narrow viewport) and its buttons cannot
    // be clicked. Dropping the dock is preferable to raising ConfirmDialog,
    // which would change the stacking of every other call site.
    <div
      className={`pointer-events-none fixed inset-0 ${cancelConfirmTarget ? 'z-[9998]' : 'z-[11000]'}`}
      role="presentation"
    >
      <div className={`pointer-events-auto fixed bottom-4 right-4 ${cancelConfirmTarget ? 'z-[9999]' : 'z-[11001]'} w-[min(32rem,calc(100vw-2rem))]`}>
        {!isExpanded ? (
          <button
            ref={dockButtonRef}
            type="button"
            onClick={() => setIsExpanded(true)}
            aria-expanded="false"
            className="ml-auto flex max-w-full items-center gap-2 rounded-xl border border-violet-400/35 bg-neutral-900/95 px-3.5 py-2.5 text-left text-sm text-white shadow-xl backdrop-blur transition-colors hover:border-violet-300/60 hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-violet-400/70"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-violet-400/25 bg-violet-500/15">
              <ClipboardCopy size={14} className="text-violet-200" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium">Pending AI handoffs</span>
              <span aria-live="polite" aria-atomic="true" className="block text-xs text-white/55">{dockLabel}</span>
            </span>
            <span className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-violet-200">
              Expand <ChevronUp size={15} aria-hidden="true" />
            </span>
          </button>
        ) : (
      <section
        id="non-api-ai-handoff-panel"
        role="region"
        aria-labelledby="non-api-ai-dialog-title"
        aria-busy={isSubmitting || isSteppingBack || isCancelling || isAccepted}
        className="max-h-[calc(100vh-2rem)] overflow-hidden rounded-2xl border border-violet-400/25 bg-neutral-900 shadow-2xl flex flex-col"
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
              <p aria-live="polite" aria-atomic="true" className="mt-0.5 text-xs text-white/55 break-words">
                {multipleHubQueue && ownerBadgeForNode(activeRequest.nodeId) && (
                  <span className="mr-1.5 inline-flex rounded border border-violet-400/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-200">
                    {ownerBadgeForNode(activeRequest.nodeId)}
                  </span>
                )}
                {requestLabel(activeRequest)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {queueLabel && <span className="text-[11px] text-white/40">{queueLabel}</span>}
              <button
                type="button"
                onClick={minimize}
                aria-label="Minimize pending AI handoffs"
                className="inline-flex items-center gap-1 rounded-md border border-white/15 px-2 py-1.5 text-xs font-medium text-white/70 transition-colors hover:border-violet-300/40 hover:bg-violet-500/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-400/70"
              >
                <ChevronDown size={14} aria-hidden="true" />
                Minimize
              </button>
            </div>
          </div>
          {requests.length > 1 && (
            <nav aria-label="Pending AI handoff batches" className="mt-3 -mb-1 overflow-x-auto custom-scrollbar">
              <div className="flex min-w-max gap-1.5 pb-1">
                {requests.map((request, index) => {
                  const selected = request.requestId === activeRequestId;
                  const hasDraft = Boolean(drafts[request.requestId]?.trim());
                  const hasError = Boolean(errors[request.requestId]);
                  const isWorking = submittingRequestIds.has(request.requestId)
                    || steppingBackRequestIds.has(request.requestId)
                    || cancellingRequestIds.has(request.requestId)
                    || acceptedRequestIds.has(request.requestId);
                  const count = Number.isFinite(request.itemCount) ? ` · ${request.itemCount}` : '';
                  const label = request.attemptKind === 'partial-recovery'
                    ? `Recovery ${request.batch}${count}`
                    : request.attemptKind === 'split'
                      ? `Split ${request.batch}${count}`
                      : Number.isFinite(request.batch) ? `Batch ${request.batch}${count}` : `Prompt ${index + 1}${count}`;
                  const ownerBadge = multipleHubQueue ? ownerBadgeForNode(request.nodeId) : null;
                  const chipLabel = ownerBadge ? `${ownerBadge} · ${label}` : label;
                  return (
                    <button
                      key={request.requestId}
                      type="button"
                      onClick={() => setSelectedRequestId(request.requestId)}
                      // Switching the panel to another hub's handoff while the
                      // confirm is open would let the prompt say one thing and
                      // cancel another.
                      disabled={!!cancelConfirmTarget}
                      aria-current={selected ? 'page' : undefined}
                      aria-label={`${chipLabel}: ${requestLabel(request)}${hasDraft ? ', response pasted' : ''}${hasError ? ', needs correction' : ''}`}
                      title={requestLabel(request)}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${selected
                        ? 'border-violet-300/60 bg-violet-500/20 text-violet-100'
                        : 'border-white/10 bg-black/20 text-white/60 hover:border-violet-400/35 hover:text-white/85'}`}
                    >
                      <span>{chipLabel}</span>
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
              id="non-api-ai-response"
              value={activeResponse}
              onChange={(event) => setActiveResponse(event.target.value)}
              disabled={isSubmitting || isSteppingBack || isCancelling || isAccepted || !!cancelConfirmTarget}
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

          <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 pt-1">
            <span className="min-w-48 flex-1 text-xs text-white/40" aria-live="polite">
              {isAccepted ? 'Response accepted — continuing task…' : isSteppingBack ? 'Returning to the previous AI step…' : isCancelling ? 'Cancelling the owning job operation…' : 'Cancel task stops the owning job operation. Every response you already pasted for this run is discarded. You can retry as many times as needed.'}
            </span>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {activeRequest.canStepBack && (
                <button
                  type="button"
                  onClick={stepBack}
                  disabled={isSubmitting || isSteppingBack || isCancelling || isAccepted || !!cancelConfirmTarget}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/20 px-3 py-2 text-sm font-medium text-white/75 transition-colors hover:border-violet-300/40 hover:bg-violet-500/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  title="Return to the previous AI prompt and edit its accepted response"
                >
                  {isSteppingBack ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <ArrowLeft size={15} aria-hidden="true" />}
                  {isSteppingBack ? 'Going back…' : (activeRequest.stepBackLabel || 'Back one step')}
                </button>
              )}
              <button
                type="button"
                onClick={requestCancelConfirm}
                disabled={isSubmitting || isSteppingBack || isCancelling || isAccepted || !!cancelConfirmTarget}
                className="rounded-md border border-red-400/30 px-3 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                title="Cancel the job operation waiting for this AI response"
              >
                {isCancelling ? 'Cancelling…' : 'Cancel task'}
              </button>
              <button
                type="submit"
                disabled={!activeResponse.trim() || isSubmitting || isSteppingBack || isCancelling || isAccepted || !!cancelConfirmTarget}
                className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
                {isSubmitting ? 'Validating…' : isAccepted ? 'Accepted' : 'Submit response'}
              </button>
            </div>
          </div>
        </form>
      </section>
        )}
      </div>
      {/* Sibling of the expanded/minimized branch so the prompt survives a
          Minimize. ConfirmDialog self-portals at z-[10000] and self-registers
          with the modal stack; while it is open the dock wrappers above drop to
          z-[9998]/z-[9999] so the confirm paints on top and the backdrop
          intercepts clicks on the dock. The dock controls are ALSO disabled —
          belt and braces, and so a click that does reach one (e.g. via keyboard
          focus, which the backdrop does not intercept) cannot switch the panel
          to a different hub's handoff and desync the prompt from its target.
          No onAbort: there is nothing to roll back. */}
      {cancelConfirmTarget && (
        <ConfirmDialog
          title="Cancel this AI task?"
          message={`${cancelConfirmTarget.label ? `${cancelConfirmTarget.label}\n\n` : ''}This stops the whole job operation waiting on this handoff, not just this prompt. Every AI response you have already pasted for this run is discarded and cannot be restored. Job data already scraped and saved to disk is kept.`}
          confirmLabel="Cancel task"
          cancelLabel="Keep working"
          variant="danger"
          onConfirm={() => {
            const target = cancelConfirmTarget;
            setCancelConfirmTarget(null);
            EventLogger.log('ConfirmDialog CONFIRMED');
            void performCancelTask(target);
          }}
          onCancel={() => {
            setCancelConfirmTarget(null);
            EventLogger.log('ConfirmDialog CANCELLED');
          }}
        />
      )}
    </div>,
    document.body,
  );
}
