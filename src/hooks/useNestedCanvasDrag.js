import { useCallback, useRef, useEffect } from 'react';
import { NODE_FACTORIES } from '../utils/nodeFactory';

export function useNestedCanvasDrag({ isAnimatingRef, screenToFlowPosition, takeSnapshot, setNodes, cursorsRef }) {
  const nestedDragListenersRef = useRef(null);
  const nestedDragRef = useRef(null);

  useEffect(() => {
    return () => {
      if (nestedDragListenersRef.current) {
        window.removeEventListener('pointermove', nestedDragListenersRef.current.onMove);
        window.removeEventListener('pointerup', nestedDragListenersRef.current.onUp);
      }
    };
  }, []);

  const onNestedCanvasDragStart = useCallback((startX, startY) => {
    // If a previous drag was somehow still active, clean it up first
    if (nestedDragListenersRef.current) {
      window.removeEventListener('pointermove', nestedDragListenersRef.current.onMove);
      window.removeEventListener('pointerup', nestedDragListenersRef.current.onUp);
    }

    nestedDragRef.current = { dragging: false, startX, startY };

    const onMove = (e) => {
      const ref = nestedDragRef.current;
      if (!ref) return;
      if (!ref.dragging) {
        const dx = e.clientX - ref.startX;
        const dy = e.clientY - ref.startY;
        if (dx * dx + dy * dy < 25) return; // < 5px threshold
        ref.dragging = true;
      }
      cursorsRef.current?.updateNestedDrag({ x: e.clientX, y: e.clientY });
    };

    const onUp = (e) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      nestedDragListenersRef.current = null;
      const ref = nestedDragRef.current;
      nestedDragRef.current = null;
      cursorsRef.current?.updateNestedDrag(null);

      if (ref?.dragging) {
        if (isAnimatingRef.current) return;
        // Place node at drop position — same offset as handleDrop uses for node-type drops
        const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const factory = NODE_FACTORIES['group'];
        if (factory) {
          takeSnapshot();
          setNodes(nds => nds.concat(factory({ x: pos.x - 12, y: pos.y - 20 })));
        }
      }
    };

    nestedDragListenersRef.current = { onMove, onUp };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [screenToFlowPosition, takeSnapshot, setNodes, isAnimatingRef, cursorsRef]);

  return { onNestedCanvasDragStart };
}
