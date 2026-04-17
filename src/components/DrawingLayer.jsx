import React, { useState, useImperativeHandle, forwardRef } from 'react';
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

  useImperativeHandle(ref, () => ({
    updateCurrentStroke: (stroke) => setCurrentStroke(stroke),
    clearCurrentStroke: () => setCurrentStroke(null),
    getCurrentStroke: () => currentStroke,
  }), [currentStroke]);

  return (
    <svg className="absolute top-0 left-0 w-full h-full pointer-events-none z-[60]">
      <ViewportG>
        {drawings.map((stroke, i) => (
          <DrawingStroke key={i} stroke={stroke} />
        ))}
        {currentStroke && (
          <polyline
            points={currentStroke.map(p => `${p.x},${p.y}`).join(' ')}
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
