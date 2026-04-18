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

/** Stable, pure snapshot fingerprint — no hook needed. */
function fingerprint(snap) {
  if (!snap || !snap.nodes) return '';
  const n = snap.nodes || [];
  const e = snap.edges || [];
  const d = snap.drawings || [];
  return JSON.stringify({
    n: n.map(x => {
      // Optimization: skip heavy recursive canvasData for groups in the fingerprint.
      // Changes inside groups are managed by their own local undo/redo stacks.
      const data = x.type === 'group' ? { ...x.data, canvasData: undefined } : x.data;
      return { id: x.id, x: x.position?.x, y: x.position?.y, t: x.type, d: data, s: x.style };
    }),
    e: e.map(x => ({ id: x.id, s: x.source, t: x.target })),
    dl: d.map(x => {
      if (!x) return null;
      const pts   = Array.isArray(x) ? x : (x.points || []);
      const first = pts[0];
      const last  = pts[pts.length - 1];
      // Defensive: only record coords if they exist
      const fCoord = first ? [first.x, first.y] : null;
      const lCoord = last ? [last.x, last.y] : null;
      // Also sample the middle point to detect shape changes that preserve first/last/length
      const mid = pts.length > 2 ? pts[Math.floor(pts.length / 2)] : null;
      const mCoord = mid ? [mid.x, mid.y] : null;

      return { c: x.color, pl: pts.length, f: fCoord, l: lCoord, m: mCoord };
    }),
  });
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

  const isMountedRef       = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const [historyLens, setHistoryLens] = useState({ past: 0, future: 0 });
  const [isStateDirty, setIsStateDirty] = useState(false);

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
      console.warn('[undo-redo] structuredClone failed, falling back to JSON clone:', err.message);
      return JSON.parse(JSON.stringify({ nodes: n, edges: e, drawings: d }));
    }
  }, []);

  const takeSnapshot = useCallback(() => {
    if (isRestoringRef.current) return;
    const snap = deepCloneState();
    const fp   = fingerprint(snap);
    if (fp === lastFingerprintRef.current) {
      if (isStateDirty) setIsStateDirty(false);
      return;
    }
    lastFingerprintRef.current = fp;

    pastRef.current   = [...pastRef.current.slice(-(MAX_HISTORY - 1)), snap];
    futureRef.current = []; // any new action clears redo
    syncHistoryLen();
    setIsStateDirty(false); // State is freshly saved, no longer dirty
  }, [deepCloneState, syncHistoryLen, isStateDirty]);

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
    if (isStateDirty && futureRef.current.length === 0) return;

    const currentFp = fingerprint({ nodes, edges, drawings });
    const isCurrentlyDirty = currentFp !== lastFingerprintRef.current;

    if (isCurrentlyDirty !== isStateDirty) {
      setIsStateDirty(isCurrentlyDirty);
    }

    if (isCurrentlyDirty && futureRef.current.length > 0) {
      // State changed since last snapshot — wipe the future immediately
      futureRef.current = [];
      syncHistoryLen();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, drawings]); // intentionally tight deps for instant reaction

  // Auto-snapshot (500ms debounce) — safety net for changes not explicitly snapshotted
  useEffect(() => {
    if (isRestoringRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => { 
      if (!isMountedRef.current) return;
      takeSnapshot(); 
    }, 500);
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
  }, [nodes, edges, drawings, takeSnapshot]);

  const undo = useCallback(() => {
    if (isAnimatingRef?.current) return;
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
    setIsStateDirty(false);
    requestAnimationFrame(() => { if (isMountedRef.current) isRestoringRef.current = false; });
  }, [deepCloneState, setNodes, setEdges, setDrawings, syncHistoryLen, isAnimatingRef]);

  const redo = useCallback(() => {
    if (isAnimatingRef?.current) return;
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
    setIsStateDirty(false);
    requestAnimationFrame(() => { if (isMountedRef.current) isRestoringRef.current = false; });
  }, [deepCloneState, setNodes, setEdges, setDrawings, syncHistoryLen, isAnimatingRef]);

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
    setIsStateDirty(false);
  }, [syncHistoryLen]);

  const canUndo = historyLens.past > 0 && (historyLens.past > 1 || isStateDirty);

  return {
    undo, redo, takeSnapshot, clearHistory,
    canUndo,
    canRedo: historyLens.future > 0,
  };
}
