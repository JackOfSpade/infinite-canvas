import { useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { EventLogger } from '../utils/EventLogger';
import { WASD_BASE_SPEED_PX_PER_SEC, WASD_SHIFT_MULTIPLIER } from '../utils/layoutGeometry';
import { useModalStackCount } from '../components/modalStack';
import { isTextEditingTarget } from '../utils/nativeTextUndo';

export function useCanvasWASD({ isAnimatingRef }) {
  const { getViewport, setViewport } = useReactFlow();
  const movingRef = useRef(false);
  const modalCount = useModalStackCount();

  useEffect(() => {
    const keys = { w: false, a: false, s: false, d: false, arrowup: false, arrowleft: false, arrowdown: false, arrowright: false, shift: false };
    let rafId = null;
    let lastTs = null; // rAF timestamp of the previous frame, for dt-based speed

    const step = (ts) => {
      const { w, a, s, d, arrowup, arrowleft, arrowdown, arrowright, shift } = keys;
      const moveUp    = w || arrowup;
      const moveLeft  = a || arrowleft;
      const moveDown  = s || arrowdown;
      const moveRight = d || arrowright;

      const dx = (moveRight ? -1 : 0) + (moveLeft ? 1 : 0);
      const dy = (moveDown ? -1 : 0) + (moveUp ? 1 : 0);

      if (dx === 0 && dy === 0) {
        if (movingRef.current) {
          movingRef.current = false;
          EventLogger.log('WASD navigation stopped');
        }
        rafId = null;
        lastTs = null;   // reset so a resumed key-press doesn't see a stale dt
        return;
      }
      
      if (!movingRef.current) {
        movingRef.current = true;
        EventLogger.log('WASD navigation started');
      }
      
      // Suspend WASD viewport updates during dive-in/dive-out animations
      if (!isAnimatingRef.current) {
        const vp = getViewport();
        // Time-based pan: pixels/second × frame delta, so speed is identical on
        // 60Hz and 120Hz+ displays (was a fixed px-per-frame, 2× faster on 120Hz).
        // Clamp dt so a stalled/backgrounded frame can't teleport the view.
        // Zoom-divided so it feels consistent at all zoom levels.
        const dt = lastTs == null ? 1 / 60 : Math.min((ts - lastTs) / 1000, 1 / 30);
        const pxPerSec = (shift ? WASD_BASE_SPEED_PX_PER_SEC * WASD_SHIFT_MULTIPLIER : WASD_BASE_SPEED_PX_PER_SEC) / vp.zoom;
        const delta = pxPerSec * dt;

        setViewport({
          x: vp.x + dx * delta,
          y: vp.y + dy * delta,
          zoom: vp.zoom,
        });
      }
      lastTs = ts;
      rafId = requestAnimationFrame(step);
    };

    const onKeyDown = (e) => {
      // A dialog/menu/lightbox is open — don't let WASD/arrow keys typed into
      // it (or just held from before it opened) pan the canvas underneath.
      if (modalCount > 0) return;
      // Was an inline tag==='INPUT' check, which treats ANY input as
      // text-editing regardless of type — a focused checkbox/radio would
      // incorrectly block WASD panning. isTextEditingTarget checks the
      // input's actual type.
      if (isTextEditingTarget(e.target)) return;
      // Ignore arrow/WASD pans when Ctrl/Cmd/Alt are held — those are OS/app
      // shortcuts (e.g. macOS Ctrl+Arrow switches Spaces) that steal the matching
      // keyup, which would otherwise leave the key stuck "down" and pan forever.
      // Shift is allowed: it's the speed-boost modifier (read below as keys.shift).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'arrowup' || k === 'arrowleft' || k === 'arrowdown' || k === 'arrowright') {
        keys[k] = true;
        keys.shift = e.shiftKey;
        if (!rafId) rafId = requestAnimationFrame(step);
      }
    };
    
    const onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      if (k in keys) keys[k] = false;
    };
    
    const onBlur = () => {
      for (const k in keys) keys[k] = false;
    };
    
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    window.addEventListener('blur',    onBlur);
    
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
      window.removeEventListener('blur',    onBlur);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [getViewport, setViewport, isAnimatingRef, modalCount]);
}
