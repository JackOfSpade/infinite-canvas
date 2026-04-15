import { useCallback, useRef, useEffect, useState } from 'react';
import { DEFAULT_SHORTCUTS } from './useSettings';

const MAX_HISTORY = 100;

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
export function useUndoRedo({ nodes, edges, drawings, setNodes, setEdges, setDrawings, shortcuts }) {
  const sc = shortcuts || DEFAULT_SHORTCUTS;
  const pastRef   = useRef([]);
  const futureRef = useRef([]);
  const isRestoringRef     = useRef(false);
  const debounceTimerRef   = useRef(null);
  const lastFingerprintRef = useRef(null);

  const [historyLens, setHistoryLens] = useState({ past: 0, future: 0, topPastFp: null });

  const fingerprint = useCallback((snap) => {
    const n = snap.nodes;
    const e = snap.edges;
    return JSON.stringify({
      n: n.map(x => ({ id: x.id, x: x.position?.x, y: x.position?.y, d: x.data, s: x.style })),
      e: e.map(x => ({ id: x.id, s: x.source, t: x.target })),
      dl: snap.drawings.map(d => {
        const pts   = Array.isArray(d) ? d : d.points || [];
        const first = pts[0];
        const last  = pts[pts.length - 1];
        return { c: d.color, pl: pts.length, f: first && [first.x, first.y], l: last && [last.x, last.y] };
      }),
    });
  }, []);

  const syncHistoryLen = useCallback(() => {
    const topPastFp = pastRef.current.length > 0
      ? fingerprint(pastRef.current[pastRef.current.length - 1])
      : null;
    setHistoryLens({ past: pastRef.current.length, future: futureRef.current.length, topPastFp });
  }, [fingerprint]);

  const stateRef = useRef({ nodes, edges, drawings });
  useEffect(() => { stateRef.current = { nodes, edges, drawings }; }, [nodes, edges, drawings]);

  const deepCloneState = useCallback(() => {
    const { nodes: n, edges: e, drawings: d } = stateRef.current;
    return {
      nodes:    structuredClone(n),
      edges:    structuredClone(e),
      drawings: structuredClone(d),
    };
  }, []);

  const takeSnapshot = useCallback(() => {
    if (isRestoringRef.current) return;
    const snap = deepCloneState();
    const fp   = fingerprint(snap);
    if (fp === lastFingerprintRef.current) return;
    lastFingerprintRef.current = fp;

    pastRef.current   = [...pastRef.current.slice(-(MAX_HISTORY - 1)), snap];
    futureRef.current = []; // any new action clears redo
    syncHistoryLen();
  }, [deepCloneState, fingerprint, syncHistoryLen]);

  // ── KEY FIX ─────────────────────────────────────────────────────────────────
  // When state changes while we have redo entries AND we're not restoring,
  // immediately clear the future so canRedo becomes false right away.
  // We do this check synchronously (no debounce) so the UI responds instantly.
  const prevFpRef = useRef(null);
  useEffect(() => {
    if (isRestoringRef.current) return;
    if (futureRef.current.length === 0) return; // nothing to clear

    const currentFp = fingerprint({ nodes, edges, drawings });
    if (currentFp !== prevFpRef.current && currentFp !== lastFingerprintRef.current) {
      // State changed since last snapshot — wipe the future immediately
      futureRef.current = [];
      syncHistoryLen();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, drawings]); // intentionally tight deps for instant reaction

  useEffect(() => {
    prevFpRef.current = fingerprint({ nodes, edges, drawings });
  }, [nodes, edges, drawings, fingerprint]);

  // Auto-snapshot (500ms debounce) — safety net for changes not explicitly snapshotted
  useEffect(() => {
    if (isRestoringRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => { takeSnapshot(); }, 500);
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
  }, [nodes, edges, drawings, takeSnapshot]);

  const undo = useCallback(() => {
    let past = pastRef.current;
    if (past.length === 0) return;

    const currentState = deepCloneState();
    let previous;

    if (fingerprint(past[past.length - 1]) === fingerprint(currentState)) {
      if (past.length < 2) return;
      previous        = past[past.length - 2];
      pastRef.current = past.slice(0, -2);
    } else {
      previous        = past[past.length - 1];
      pastRef.current = past.slice(0, -1);
    }

    futureRef.current = [...futureRef.current, currentState];

    isRestoringRef.current = true;
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setDrawings(previous.drawings);
    lastFingerprintRef.current = fingerprint(previous);
    syncHistoryLen();
    requestAnimationFrame(() => { isRestoringRef.current = false; });
  }, [deepCloneState, fingerprint, setNodes, setEdges, setDrawings, syncHistoryLen]);

  const redo = useCallback(() => {
    const future = futureRef.current;
    if (future.length === 0) return;

    const next        = future[future.length - 1];
    futureRef.current = future.slice(0, -1);
    pastRef.current   = [...pastRef.current, deepCloneState()];

    isRestoringRef.current = true;
    setNodes(next.nodes);
    setEdges(next.edges);
    setDrawings(next.drawings);
    lastFingerprintRef.current = fingerprint(next);
    syncHistoryLen();
    requestAnimationFrame(() => { isRestoringRef.current = false; });
  }, [deepCloneState, fingerprint, setNodes, setEdges, setDrawings, syncHistoryLen]);

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

  const clearHistory = useCallback(() => {
    pastRef.current   = [];
    futureRef.current = [];
    lastFingerprintRef.current = null;
    syncHistoryLen();
  }, [syncHistoryLen]);

  const currentStateStr    = fingerprint({ nodes, edges, drawings });
  const isTopSameAsCurrent = historyLens.past > 0 && historyLens.topPastFp === currentStateStr;
  const effectivePastLength = isTopSameAsCurrent ? historyLens.past - 1 : historyLens.past;

  return {
    undo, redo, takeSnapshot, clearHistory,
    canUndo: effectivePastLength > 0,
    canRedo: historyLens.future > 0,
  };
}
