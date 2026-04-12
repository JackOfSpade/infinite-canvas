import { useCallback, useRef, useEffect, useState } from 'react';

const MAX_HISTORY = 100;

/**
 * A generic undo/redo hook for the canvas.
 * Tracks snapshots of { nodes, edges, drawings } and restores them on Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
 *
 * To avoid capturing every intermediate React Flow drag-frame, we debounce snapshot capture.
 * The hook exposes `takeSnapshot` which the Canvas calls at meaningful moments (drop, connect, delete, etc.),
 * plus an auto-capture via a debounced effect on the state itself as a safety net.
 *
 * All callbacks are stable (never recreated) by reading current state from refs.
 */
export function useUndoRedo({ nodes, edges, drawings, setNodes, setEdges, setDrawings }) {
  const pastRef = useRef([]);          // stack of past snapshots
  const futureRef = useRef([]);        // stack of future snapshots (for redo)
  const isRestoringRef = useRef(false);
  const debounceTimerRef = useRef(null);
  const lastFingerprintRef = useRef(null);

  // Reactive state to drive canUndo/canRedo button rendering
  const [historyLen, setHistoryLen] = useState({ past: 0, future: 0 });

  /** Sync the reactive length counters with the refs. */
  const syncHistoryLen = useCallback(() => {
    setHistoryLen({ past: pastRef.current.length, future: futureRef.current.length });
  }, []);

  // Keep latest state in refs so callbacks stay stable
  const stateRef = useRef({ nodes, edges, drawings });
  useEffect(() => {
    stateRef.current = { nodes, edges, drawings };
  }, [nodes, edges, drawings]);

  // Lightweight fingerprint for dedup — checks structural identity
  const fingerprint = useCallback((snap) => {
    const n = snap.nodes;
    const e = snap.edges;
    return JSON.stringify({
      n: n.map(x => ({ id: x.id, x: x.position?.x, y: x.position?.y, d: x.data })),
      e: e.map(x => ({ id: x.id, s: x.source, t: x.target })),
      dl: snap.drawings.length,
    });
  }, []);

  const deepCloneState = useCallback(() => {
    const { nodes: n, edges: e, drawings: d } = stateRef.current;
    return {
      nodes: JSON.parse(JSON.stringify(n)),
      edges: JSON.parse(JSON.stringify(e)),
      drawings: JSON.parse(JSON.stringify(d)),
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
    const past = pastRef.current;
    if (past.length === 0) return;

    const previous = past[past.length - 1];
    pastRef.current = past.slice(0, -1);

    // Push current state to future before restoring
    futureRef.current = [...futureRef.current, deepCloneState()];

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

  // Keyboard listener — stable undo/redo means this effect rarely re-attaches
  useEffect(() => {
    const handleKeyDown = (e) => {
      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;

      // Don't intercept if user is typing in an input/textarea/contenteditable
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  return {
    undo,
    redo,
    takeSnapshot,
    canUndo: historyLen.past > 0,
    canRedo: historyLen.future > 0,
  };
}
