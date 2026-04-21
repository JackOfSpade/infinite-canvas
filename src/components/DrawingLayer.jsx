import React, { useState, useImperativeHandle, useRef, forwardRef } from 'react';
import { useStore } from '@xyflow/react';

const vpTransformSelector = (s) => s.transform;

const ViewportG = React.memo(({ children }) => {
  const transform = useStore(vpTransformSelector);
  return (
    <g transform={`translate(${transform[0]}, ${transform[1]}) scale(${transform[2]})`}>
      {children}
    </g>
  );
});

const DrawingStroke = React.memo(({ stroke }) => {
  const points = Array.isArray(stroke) ? stroke : stroke?.points;
  if (!Array.isArray(points) || points.length < 2) return null;
  const color     = stroke?.color   || 'white';
  const thickness = stroke?.penSize ?? 3;
  return (
    <polyline
      points={points.map(p => `${p.x},${p.y}`).join(' ')}
      fill="none"
      stroke={color}
      strokeWidth={thickness}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
});

export const DrawingLayer = React.memo(forwardRef(function DrawingLayer({ drawings, activeColor = 'white', penSize = 3 }, ref) {
  const [currentStroke, setCurrentStroke] = useState(null);
  // Mirror currentStroke in a ref so getCurrentStroke never causes handle reconstruction.
  const currentStrokeRef = useRef(null);

  useImperativeHandle(ref, () => ({
    updateCurrentStroke: (stroke) => {
      currentStrokeRef.current = stroke;
      setCurrentStroke(stroke);
    },
    clearCurrentStroke: () => {
      currentStrokeRef.current = null;
      setCurrentStroke(null);
    },
    getCurrentStroke: () => currentStrokeRef.current,
  }), []); // stable — reads via ref, never needs to reconstruct

  // Pre-join points to avoid repeating the work on every sub-render.
  // Memoized so we only re-join when the reference changes (which happens
  // in useDrawingMode's point-reduction filter).
  const currentStrokePoints = React.useMemo(() => {
    if (!currentStroke) return '';
    return currentStroke.map(p => `${p.x},${p.y}`).join(' ');
  }, [currentStroke]);

  return (
    <svg className="absolute top-0 left-0 w-full h-full pointer-events-none z-[60]">
      <ViewportG>
        {drawings.map((stroke, i) => (
          <DrawingStroke key={stroke.id || i} stroke={stroke} />
        ))}
        {currentStroke && (
          <polyline
            points={currentStrokePoints}
            fill="none"
            stroke={activeColor}
            strokeWidth={penSize}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </ViewportG>
    </svg>
  );
}));
