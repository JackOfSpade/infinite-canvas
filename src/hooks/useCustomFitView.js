import { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { getNodeDims } from '../utils/constants';

export function useCustomFitView(reactFlowWrapper, nodes, drawings, isAnimatingRef) {
  const { setViewport } = useReactFlow();

  const customFitView = useCallback(() => {
    if (isAnimatingRef?.current) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
    nodes.forEach(n => {
      const { w, h } = getNodeDims(n);
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    });

    drawings.forEach(stroke => {
      // Drawings are stored as { points, color } objects; handle legacy bare arrays defensively
      const pts = Array.isArray(stroke) ? stroke : stroke.points || [];
      pts.forEach(p => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      });
    });

    if (minX === Infinity) return;
    
    minX -= 100; minY -= 100;
    maxX += 100; maxY += 100;

    const width = maxX - minX;
    const height = maxY - minY;
    const containerWidth = reactFlowWrapper.current?.clientWidth || window.innerWidth;
    const containerHeight = reactFlowWrapper.current?.clientHeight || window.innerHeight;
    
    const scaleX = containerWidth / width;
    const scaleY = containerHeight / height;
    const zoom = Math.min(Math.max(Math.min(scaleX, scaleY), 0.1), 2);

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    setViewport({
      x: containerWidth / 2 - cx * zoom,
      y: containerHeight / 2 - cy * zoom,
      zoom
    }, { duration: 800 });
  }, [nodes, drawings, setViewport, reactFlowWrapper, isAnimatingRef]);

  return customFitView;
}
