import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';

export function useCanvasWASD({ isAnimatingRef }) {
  const { getViewport, setViewport } = useReactFlow();

  useEffect(() => {
    const keys = { w: false, a: false, s: false, d: false, shift: false };
    let rafId = null;
    const BASE_SPEED = 6; // pixels per frame at zoom=1

    const step = () => {
      const { w, a, s, d, shift } = keys;
      if (!w && !a && !s && !d) { rafId = null; return; }
      
      // Suspend WASD viewport updates during dive-in/dive-out animations
      if (!isAnimatingRef.current) {
        const speed = shift ? BASE_SPEED * 5 : BASE_SPEED;
        const vp = getViewport();
        setViewport({
          x: vp.x + (a ? speed : d ? -speed : 0),
          y: vp.y + (w ? speed : s ? -speed : 0),
          zoom: vp.zoom,
        });
      }
      rafId = requestAnimationFrame(step);
    };

    const onKeyDown = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'a' || k === 's' || k === 'd') {
        keys[k] = true;
        keys.shift = e.shiftKey;
        if (!rafId) rafId = requestAnimationFrame(step);
      }
      if (k === 'shift') keys.shift = true;
    };
    
    const onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      if (k in keys) keys[k] = false;
      if (k === 'shift') keys.shift = false;
    };
    
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [getViewport, setViewport, isAnimatingRef]);
}
