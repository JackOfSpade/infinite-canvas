import React, { useState, useImperativeHandle, forwardRef } from 'react';
import { NestedCanvasIcon } from './CanvasToolbar';

export const CanvasCursors = forwardRef(({ eraserSize, placementMode }, ref) => {
  const [eraserPos, setEraserPos] = useState({ x: -999, y: -999 });
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [nestedDragPos, setNestedDragPos] = useState(null);

  useImperativeHandle(ref, () => ({
    updateEraser: (pos) => setEraserPos(prev => {
      if (prev.x === pos.x && prev.y === pos.y) return prev;
      return pos;
    }),
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

      {eraserPos.x > 0 && (
        <div
          className="fixed pointer-events-none z-[9998]"
          style={{
            left:   eraserPos.x - eraserSize,
            top:    eraserPos.y - eraserSize,
            width:  eraserSize * 2,
            height: eraserSize * 2,
            borderRadius: '50%',
            border: '1.5px solid rgba(255,255,255,0.7)',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
            background: 'rgba(255,255,255,0.04)',
          }}
        />
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
