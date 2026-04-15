import React from 'react';
import { useViewport } from '@xyflow/react';

export const DrawingLayer = React.memo(function DrawingLayer({ drawings, currentStroke, activeColor = 'white' }) {
  const { x, y, zoom } = useViewport();
  return (
    <svg className="absolute top-0 left-0 w-full h-full pointer-events-none z-50">
      <g transform={`translate(${x}, ${y}) scale(${zoom})`}>
        {drawings.map((stroke, i) => {
          const points = Array.isArray(stroke) ? stroke : stroke?.points;
          if (!Array.isArray(points) || points.length < 2) return null;
          const color = stroke?.color || 'white';
          return (
            <polyline 
              key={i} 
              points={points.map(p => `${p.x},${p.y}`).join(' ')} 
              fill="none" 
              stroke={color} 
              strokeWidth={3} 
              strokeLinecap="round" 
              strokeLinejoin="round" 
            />
          );
        })}
        {currentStroke && (
          <polyline 
            points={currentStroke.map(p => `${p.x},${p.y}`).join(' ')} 
            fill="none" 
            stroke={activeColor} 
            strokeWidth={3} 
            strokeLinecap="round" 
            strokeLinejoin="round" 
          />
        )}
      </g>
    </svg>
  );
});
