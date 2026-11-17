import { useCallback, useRef, useEffect } from 'react';
import { NODE_FACTORIES } from '../utils/nodeFactory';

export function useNestedCanvasDrag({ isAnimatingRef, screenToFlowPosition, takeSnapshot, setNodes, cursorsRef }) {
  const nestedDragListenersRef = useRef(null);
  const nestedDragRef = useRef(null);

  const detachListeners = useCallback(() => {
    const listeners = nestedDragListenersRef.current;
    if (!listeners) return;
    window.removeEventListener('pointermove', listeners.onMove);
    window.removeEventListener('pointerup', listeners.onUp);
    window.removeEventListener('pointercancel', listeners.onCancel);
    nestedDragListenersRef.current = null;
  }, []);

  useEffect(() => detachListeners, [detachListeners]);

  const onNestedCanvasDragStart = useCallback((startX, startY) => {
    // If a previous drag was somehow still active, clean it up first
    detachListeners();

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
      detachListeners();
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

    // A touch/pen gesture can be cancelled by the OS without a pointerup
    // (window blur, system gesture, device disconnect). Clear the drag cursor
    // and listeners without creating a node at a stale position.
    const onCancel = () => {
      detachListeners();
      nestedDragRef.current = null;
      cursorsRef.current?.updateNestedDrag(null);
    };

    nestedDragListenersRef.current = { onMove, onUp, onCancel };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }, [screenToFlowPosition, takeSnapshot, setNodes, isAnimatingRef, cursorsRef, detachListeners]);

  return { onNestedCanvasDragStart };
}
