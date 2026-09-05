import React, { useState, useImperativeHandle, forwardRef } from 'react';
import { NestedCanvasIcon } from './CanvasToolbar';

export const CanvasCursors = forwardRef(({ placementMode }, ref) => {
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [nestedDragPos, setNestedDragPos] = useState(null);

  useImperativeHandle(ref, () => ({
    updateMouse: (pos) => setMousePos(prev => {
      if (prev.x === pos.x && prev.y === pos.y) return prev;
      return pos;
    }),
    updateNestedDrag: (pos) => setNestedDragPos(prev => {
      if (prev?.x === pos?.x && prev?.y === pos?.y) return prev;
      return pos;
    }),
  }), []);

  return (
    <>
      {placementMode && (
        <div
          className="fixed pointer-events-none z-50 flex flex-col items-center"
          style={{ left: mousePos.x, top: mousePos.y, transform: 'translate(-50%, -100%)' }}
        >
          {placementMode === 'text' && <span className="text-sm font-medium text-white/90">text</span>}
          {placementMode === 'link' && <span className="text-sm font-medium text-blue-400">link</span>}
          {placementMode === 'group' && (
            <span className="text-blue-400 opacity-90 drop-shadow-lg">
              <NestedCanvasIcon size={28} />
            </span>
          )}
        </div>
      )}

      {nestedDragPos && (
        <div
          className="fixed pointer-events-none z-50 flex flex-col items-center"
          style={{ left: nestedDragPos.x, top: nestedDragPos.y, transform: 'translate(-50%, -100%)' }}
        >
          <span className="text-blue-400 opacity-90 drop-shadow-lg">
            <NestedCanvasIcon size={28} />
          </span>
        </div>
      )}
    </>
  );
});
