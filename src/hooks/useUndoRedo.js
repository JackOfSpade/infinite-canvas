import { useCallback, useRef, useEffect, useState } from 'react';
import { DEFAULT_SHORTCUTS } from './useSettings';
import { EventLogger } from '../utils/EventLogger';
import { fingerprint } from '../utils/serializationUtils';
import { TIMINGS, maxUndoHistory } from '../utils/timings';

// Resolved once at module load — each snapshot is a full canvas clone, so this
// scales down on low-memory devices (see maxUndoHistory).
const MAX_HISTORY = maxUndoHistory();

function matchesShortcut(e, binding) {
  if (!binding) return false;
  const isMod = e.ctrlKey || e.metaKey;
  if (binding.meta  && !isMod)    return false;
  if (!binding.meta && isMod)     return false;
  if (binding.shift !== e.shiftKey) return false;
  if (binding.alt   !== e.altKey)   return false;
  return e.key.toLowerCase() === binding.key.toLowerCase();
}

/**
 * Undo/Redo hook.
 *
 * Key fix: previously the 500ms debounce auto-snapshot was the only mechanism
 * that cleared futureRef when new state arrived, so "canRedo" stayed true for
 * up to 500ms after the user made a change. Now we detect any state change while
 * a future exists and *immediately* clear it + re-sync, making the redo button
 * disable instantly.
 */
export function useUndoRedo({ nodes, edges, drawings, setNodes, setEdges, setDrawings, shortcuts, isAnimatingRef, isInteractionRef }) {
  const sc = shortcuts || DEFAULT_SHORTCUTS;
  const pastRef   = useRef([]);
  const futureRef = useRef([]);
  const isRestoringRef     = useRef(false);
  const debounceTimerRef   = useRef(null);
  const lastFingerprintRef = useRef(null);

  const [historyLens, setHistoryLens] = useState({ past: 0, future: 0 });
  const [isStateDirty, setIsStateDirty] = useState(false);
  const isStateDirtyRef = useRef(false);

  const syncHistoryLen = useCallback(() => {
    setHistoryLens({ past: pastRef.current.length, future: futureRef.current.length });
  }, []);

  const stateRef = useRef({ nodes, edges, drawings });
  useEffect(() => { stateRef.current = { nodes, edges, drawings }; }, [nodes, edges, drawings]);

  const deepCloneState = useCallback(() => {
    const { nodes: n, edges: e, drawings: d } = stateRef.current;
    try {
      return {
        nodes:    structuredClone(n),
        edges:    structuredClone(e),
        drawings: structuredClone(d),
      };
    } catch (err) {
      // Fallback: if structuredClone fails (due to non-serializable data in 'data' fields),
      // we use a JSON-based clone which is safer for standard React Flow data.
      EventLogger.log('[undo-redo] structuredClone failed, falling back to JSON clone: ' + err.message);
      return JSON.parse(JSON.stringify({ nodes: n, edges: e, drawings: d }));
    }
  }, []);

  const takeSnapshot = useCallback(() => {
    if (isRestoringRef.current) return;
    const snap = deepCloneState();
    const fp   = fingerprint(snap);
    if (fp === lastFingerprintRef.current) {
      // Use ref to avoid closing over stale isStateDirty state value
      if (isStateDirtyRef.current) {
        isStateDirtyRef.current = false;
        setIsStateDirty(false);
      }
      return;
    }
    lastFingerprintRef.current = fp;

    pastRef.current   = [...pastRef.current.slice(-(MAX_HISTORY - 1)), snap];
    futureRef.current = []; // any new action clears redo
    syncHistoryLen();
    isStateDirtyRef.current = false;
    setIsStateDirty(false); // State is freshly saved, no longer dirty
  }, [deepCloneState, syncHistoryLen]); // isStateDirty intentionally omitted — read via ref

  // ── KEY FIX ─────────────────────────────────────────────────────────────────
  // When state changes while we have redo entries AND we're not restoring,
  // immediately clear the future so canRedo becomes false right away.
  // We do this check synchronously (no debounce) so the UI responds instantly.
  //
  // PERFORMANCE FIX: We avoid running `fingerprint` (a heavy JSON.stringify) on
  // every 60fps drag tick by tracking `isStateDirty` and fast-returning if there's
  // no future array to clear OR if an interaction is actively happening.
  useEffect(() => {
    if (isRestoringRef.current) return;

    // ── NEW PERFORMANCE GUARD ────────────────────────────────────────────────
    // If we're in the middle of a high-frequency interaction (drag, draw, etc.)
    // skip the full fingerprinting. We'll catch the final state via the 
    // debounced takeSnapshot once the interaction settles.
    if (isInteractionRef?.current) return;

    // Fast path: if state is already known to be dirty and we don't have future to clear, skip fingerprinting!
    // Use the ref (not the React state value) so this check is never stale between renders.
    if (isStateDirtyRef.current && futureRef.current.length === 0) return;

    const currentFp = fingerprint({ nodes, edges, drawings });
    const isCurrentlyDirty = currentFp !== lastFingerprintRef.current;

    if (isCurrentlyDirty !== isStateDirtyRef.current) {
      isStateDirtyRef.current = isCurrentlyDirty;
      setIsStateDirty(isCurrentlyDirty);
    }

    if (isCurrentlyDirty && futureRef.current.length > 0) {
      // State changed since last snapshot — wipe the future immediately
      futureRef.current = [];
      syncHistoryLen();
    }
  }, [nodes, edges, drawings, syncHistoryLen, isInteractionRef]); // intentionally tight deps for instant reaction; isStateDirtyRef read via ref

  // Auto-snapshot (debounced) — safety net for changes not explicitly snapshotted
  useEffect(() => {
    if (isRestoringRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      takeSnapshot();
    }, TIMINGS.UNDO_SNAPSHOT_DEBOUNCE_MS);
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
  }, [nodes, edges, drawings, takeSnapshot]);

  const undo = useCallback(() => {
    if (isAnimatingRef?.current) return;
    let past = pastRef.current;
    if (past.length === 0) return;

    const currentState = deepCloneState();
    let previous;

    // Use the cached fingerprint of the current state (set by the last takeSnapshot call)
    // to avoid a redundant JSON.stringify on every undo action.
    if (fingerprint(past[past.length - 1]) === lastFingerprintRef.current) {
      if (past.length < 2) return;
      previous        = past[past.length - 2];
      pastRef.current = past.slice(0, -2);
    } else {
      previous        = past[past.length - 1];
      pastRef.current = past.slice(0, -1);
    }

    futureRef.current = [...futureRef.current, currentState];

    EventLogger.log('undo');
    isRestoringRef.current = true;
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setDrawings(previous.drawings);
    lastFingerprintRef.current = fingerprint(previous);
    syncHistoryLen();
    setIsStateDirty(false);
    requestAnimationFrame(() => { isRestoringRef.current = false; });
  }, [deepCloneState, setNodes, setEdges, setDrawings, syncHistoryLen, isAnimatingRef]);

  const redo = useCallback(() => {
    if (isAnimatingRef?.current) return;
    const future = futureRef.current;
    if (future.length === 0) return;

    const next        = future[future.length - 1];
    futureRef.current = future.slice(0, -1);
    pastRef.current   = [...pastRef.current, deepCloneState()];

    EventLogger.log('redo');
    isRestoringRef.current = true;
    setNodes(next.nodes);
    setEdges(next.edges);
    setDrawings(next.drawings);
    lastFingerprintRef.current = fingerprint(next);
    syncHistoryLen();
    setIsStateDirty(false);
    requestAnimationFrame(() => { isRestoringRef.current = false; });
  }, [deepCloneState, setNodes, setEdges, setDrawings, syncHistoryLen, isAnimatingRef]);

  const [modalCount, setModalCount] = useState(0);

  useEffect(() => {
    const handler = (e) => setModalCount(e.detail.count || 0);
    window.addEventListener('modal-stack-changed', handler);
    return () => window.removeEventListener('modal-stack-changed', handler);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Guard: block shortcuts if any modal is active
      if (modalCount > 0) return;

      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) {
        // If it's an empty contentEditable, allow the workspace undo (to undo node creation)
        if (e.target.innerText && e.target.innerText.trim().length > 0) return;
        if (tag === 'INPUT' && e.target.value.trim().length > 0) return;
        if (tag === 'TEXTAREA' && e.target.value.trim().length > 0) return;
      }

      if (matchesShortcut(e, sc.undo)) {
        e.preventDefault();
        undo();
      } else if (matchesShortcut(e, sc.redo) || matchesShortcut(e, sc.redoAlt)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, sc, modalCount]);

  // Listen for global snapshot requests (e.g. from JobHub when spawning results)
  useEffect(() => {
    const handleSnapshot = () => takeSnapshot();
    document.addEventListener('canvas-take-snapshot', handleSnapshot);
    return () => document.removeEventListener('canvas-take-snapshot', handleSnapshot);
  }, [takeSnapshot]);

  const clearHistory = useCallback(() => {
    pastRef.current   = [];
    futureRef.current = [];
    lastFingerprintRef.current = null;
    syncHistoryLen();
    setIsStateDirty(false);
  }, [syncHistoryLen]);

  const canUndo = historyLens.past > 0 && (historyLens.past > 1 || isStateDirty);

  return {
    undo, redo, takeSnapshot, clearHistory,
    canUndo,
    canRedo: historyLens.future > 0,
  };
}
