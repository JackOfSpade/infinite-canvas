import { useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { EventLogger } from '../utils/EventLogger';

export function useCanvasWASD({ isAnimatingRef }) {
  const { getViewport, setViewport } = useReactFlow();
  const movingRef = useRef(false);

  useEffect(() => {
    const keys = { w: false, a: false, s: false, d: false, arrowup: false, arrowleft: false, arrowdown: false, arrowright: false, shift: false };
    let rafId = null;
    const BASE_SPEED = 6; // pixels per frame at zoom=1

    const step = () => {
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
        return; 
      }
      
      if (!movingRef.current) {
        movingRef.current = true;
        EventLogger.log('WASD navigation started');
      }
      
      // Suspend WASD viewport updates during dive-in/dive-out animations
      if (!isAnimatingRef.current) {
        const vp = getViewport();
        // Adjust speed by zoom level so it feels consistent at all distances
        const speed = (shift ? BASE_SPEED * 4 : BASE_SPEED) / vp.zoom;
        
        setViewport({
          x: vp.x + dx * speed,
          y: vp.y + dy * speed,
          zoom: vp.zoom,
        });
      }
      rafId = requestAnimationFrame(step);
    };

    const onKeyDown = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
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
  }, [getViewport, setViewport, isAnimatingRef]);
}
