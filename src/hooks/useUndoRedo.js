import { useCallback, useRef, useEffect, useState } from 'react';
import { DEFAULT_SHORTCUTS } from './useSettings';

const MAX_HISTORY = 100;

/**
 * Returns true if the keyboard event matches a shortcut binding.
 */
function matchesShortcut(e, binding) {
  if (!binding) return false;
  const isMod = e.ctrlKey || e.metaKey;
  if (binding.meta && !isMod)    return false;
  if (!binding.meta && isMod)    return false;
  if (binding.shift !== e.shiftKey) return false;
  if (binding.alt   !== e.altKey)   return false;
  return e.key.toLowerCase() === binding.key.toLowerCase();
}

/**
 * A generic undo/redo hook for the canvas.
 * Accepts an optional `shortcuts` config (from useSettings) to allow
 * user-customisable key bindings. Falls back to DEFAULT_SHORTCUTS.
 *
 * Tracks snapshots of { nodes, edges, drawings } and restores them.
 * Debounces auto-capture; exposes `takeSnapshot` for explicit moments.
 */
export function useUndoRedo({ nodes, edges, drawings, setNodes, setEdges, setDrawings, shortcuts }) {
  const sc = shortcuts || DEFAULT_SHORTCUTS;
  const pastRef = useRef([]);          // stack of past snapshots
  const futureRef = useRef([]);        // stack of future snapshots (for redo)
  const isRestoringRef = useRef(false);
  const debounceTimerRef = useRef(null);
  const lastFingerprintRef = useRef(null);

  // Reactive state to drive canUndo/canRedo button rendering
  const [historyLens, setHistoryLens] = useState({ past: 0, future: 0, topPastFp: null });

  // Lightweight fingerprint for dedup — checks structural identity
  const fingerprint = useCallback((snap) => {
    const n = snap.nodes;
    const e = snap.edges;
    return JSON.stringify({
      n: n.map(x => ({ id: x.id, x: x.position?.x, y: x.position?.y, d: x.data, s: x.style })),
      e: e.map(x => ({ id: x.id, s: x.source, t: x.target })),
      dl: snap.drawings.map(d => {
        const pts = Array.isArray(d) ? d : d.points || [];
        const first = pts[0];
        const last = pts[pts.length - 1];
        return { c: d.color, pl: pts.length, f: first && [first.x, first.y], l: last && [last.x, last.y] };
      }),
    });
  }, []);

  /** Sync the reactive length counters with the refs. */
  const syncHistoryLen = useCallback(() => {
    const topPastFp = pastRef.current.length > 0
      ? fingerprint(pastRef.current[pastRef.current.length - 1])
      : null;
    setHistoryLens({ past: pastRef.current.length, future: futureRef.current.length, topPastFp });
  }, [fingerprint]);

  // Keep latest state in refs so callbacks stay stable
  const stateRef = useRef({ nodes, edges, drawings });
  useEffect(() => {
    stateRef.current = { nodes, edges, drawings };
  }, [nodes, edges, drawings]);

  const deepCloneState = useCallback(() => {
    const { nodes: n, edges: e, drawings: d } = stateRef.current;
    return {
      nodes: structuredClone(n),
      edges: structuredClone(e),
      drawings: structuredClone(d),
    };
  }, []);

  // Push the current canvas state onto the undo stack (call this BEFORE making a change)
  // Stable — never recreated.
  const takeSnapshot = useCallback(() => {
    if (isRestoringRef.current) return;
    const snap = deepCloneState();
    const fp = fingerprint(snap);
    // Don't push duplicate consecutive snapshots
    if (fp === lastFingerprintRef.current) return;
    lastFingerprintRef.current = fp;

    pastRef.current = [...pastRef.current.slice(-(MAX_HISTORY - 1)), snap];
    futureRef.current = []; // any new action clears redo
    syncHistoryLen();
  }, [deepCloneState, fingerprint, syncHistoryLen]);

  // Auto-snapshot on state changes (debounced 500ms) — safety net for changes not explicitly snapshotted
  useEffect(() => {
    if (isRestoringRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      takeSnapshot();
    }, 500);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [nodes, edges, drawings, takeSnapshot]);

  // Stable undo — reads current state from ref
  const undo = useCallback(() => {
    let past = pastRef.current;
    if (past.length === 0) return;

    const currentState = deepCloneState();
    let previous;

    // If the top snapshot matches current state (due to debounce auto-capture),
    // we need to go back one step further.
    if (fingerprint(past[past.length - 1]) === fingerprint(currentState)) {
      if (past.length < 2) return; // Nothing real to undo
      previous = past[past.length - 2];
      pastRef.current = past.slice(0, -2);
    } else {
      previous = past[past.length - 1];
      pastRef.current = past.slice(0, -1);
    }

    // Push current state to future before restoring
    futureRef.current = [...futureRef.current, currentState];

    isRestoringRef.current = true;
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setDrawings(previous.drawings);
    lastFingerprintRef.current = fingerprint(previous);
    syncHistoryLen();
    requestAnimationFrame(() => {
      isRestoringRef.current = false;
    });
  }, [deepCloneState, fingerprint, setNodes, setEdges, setDrawings, syncHistoryLen]);

  // Stable redo — reads current state from ref
  const redo = useCallback(() => {
    const future = futureRef.current;
    if (future.length === 0) return;

    const next = future[future.length - 1];
    futureRef.current = future.slice(0, -1);

    // Push current state to past before restoring
    pastRef.current = [...pastRef.current, deepCloneState()];

    isRestoringRef.current = true;
    setNodes(next.nodes);
    setEdges(next.edges);
    setDrawings(next.drawings);
    lastFingerprintRef.current = fingerprint(next);
    syncHistoryLen();
    requestAnimationFrame(() => {
      isRestoringRef.current = false;
    });
  }, [deepCloneState, fingerprint, setNodes, setEdges, setDrawings, syncHistoryLen]);

  // Keyboard listener — uses the customisable shortcuts config
  useEffect(() => {
    const handleKeyDown = (e) => {
      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

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
  }, [undo, redo, sc]);

  // Clear all history (used when navigating between canvas levels)
  const clearHistory = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    lastFingerprintRef.current = null;
    syncHistoryLen();
  }, [syncHistoryLen]);

  const currentStateStr = fingerprint({ nodes, edges, drawings });
  const isTopSameAsCurrent = historyLens.past > 0 && historyLens.topPastFp === currentStateStr;
  const effectivePastLength = isTopSameAsCurrent ? historyLens.past - 1 : historyLens.past;

  return {
    undo,
    redo,
    takeSnapshot,
    clearHistory,
    canUndo: effectivePastLength > 0,
    canRedo: historyLens.future > 0,
  };
}
