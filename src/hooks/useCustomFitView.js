import { useCallback, useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { getNodesBounds } from '../utils/constants';
import { strokePoints } from '../utils/geometry';
import { EventLogger } from '../utils/EventLogger';

export function useCustomFitView(reactFlowWrapper, nodes, drawings, isAnimatingRef) {
  const { setViewport } = useReactFlow();

  // Mirror nodes/drawings into refs so the callback can always read the latest
  // values without needing them as dependencies (the callback is only ever called
  // imperatively — it never needs to be a new function because its inputs changed).
  const nodesRef    = useRef(nodes);
  const drawingsRef = useRef(drawings);
  useEffect(() => { nodesRef.current = nodes; },    [nodes]);
  useEffect(() => { drawingsRef.current = drawings; }, [drawings]);

  const customFitView = useCallback((options = {}) => {
    if (isAnimatingRef?.current) return;
    const duration = Number.isFinite(options?.duration) ? Math.max(0, options.duration) : 800;
    const reason = options?.reason || 'manual';
    const currentNodes    = nodesRef.current;
    const currentDrawings = drawingsRef.current;

    // Fit to what's actually VISIBLE. Collapsed job-tree cards/groups are
    // `hidden` and keep their last (often expanded) positions — including them
    // would stretch the fit to empty space around invisible nodes, so the button
    // wouldn't re-calibrate as the tree collapses/expands. (RF's built-in fitView
    // already excludes hidden; this custom one must too.)
    const visibleNodes = currentNodes.filter(n => !n.hidden);

    let { minX, minY, maxX, maxY } = getNodesBounds(visibleNodes);

    currentDrawings.forEach(stroke => {
      for (const p of strokePoints(stroke)) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    });

    if (minX === Infinity) return;

    minX -= 100; minY -= 100;
    maxX += 100; maxY += 100;

    const width  = maxX - minX;
    const height = maxY - minY;
    const containerWidth  = reactFlowWrapper.current?.clientWidth  || window.innerWidth;
    const containerHeight = reactFlowWrapper.current?.clientHeight || window.innerHeight;

    const scaleX = containerWidth  / width;
    const scaleY = containerHeight / height;
    const zoom = Math.min(Math.max(Math.min(scaleX, scaleY), 0.1), 2);

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    EventLogger.log(`fit-view reason=${reason} nodes=${visibleNodes.length} drawings=${currentDrawings.length} duration=${duration}ms zoom=${zoom.toFixed(3)}`);

    setViewport({
      x: containerWidth  / 2 - cx * zoom,
      y: containerHeight / 2 - cy * zoom,
      zoom
    }, { duration });
  }, [setViewport, reactFlowWrapper, isAnimatingRef]); // nodes/drawings read via refs — stable callback

  return customFitView;
}
