import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';

export function useCanvasWASD({ isAnimatingRef }) {
  const { getViewport, setViewport } = useReactFlow();

  useEffect(() => {
    const keys = { w: false, a: false, s: false, d: false, arrowup: false, arrowleft: false, arrowdown: false, arrowright: false, shift: false };
    let rafId = null;
    const BASE_SPEED = 6; // pixels per frame at zoom=1

    const step = () => {
      const { w, a, s, d, arrowup, arrowleft, arrowdown, arrowright, shift } = keys;
      const up = w || arrowup;
      const left = a || arrowleft;
      const down = s || arrowdown;
      const right = d || arrowright;

      if (!up && !left && !down && !right) { rafId = null; return; }
      
      // Suspend WASD viewport updates during dive-in/dive-out animations
      if (!isAnimatingRef.current) {
        const speed = shift ? BASE_SPEED * 5 : BASE_SPEED;
        const vp = getViewport();
        setViewport({
          x: vp.x + (left ? speed : right ? -speed : 0),
          y: vp.y + (up ? speed : down ? -speed : 0),
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
