import { useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_FACTORIES } from '../utils/nodeFactory';
import { processDroppedFiles } from '../utils/dragUtils';
import { getNodeDims } from '../utils/constants';
import { EventLogger } from '../utils/EventLogger';
import { CODE_EXT_RE } from '../utils/fileExtensions';
import { filesToDropPayloads } from '../utils/fileDropUtils';
import { useIsMountedRef } from './useIsMountedRef';

// Compiled once at module load — not per drop event.
const URL_RE = /^(https?:\/\/[^\s]+|[a-z0-9]([a-z0-9-]*[a-z0-9])?\.([a-z]{2,}\.)*[a-z]{2,}([/?#][^\s]*)?)$/i;

export function useCanvasDragAndDrop({
  setNodes,
  setIsDrawingMode,
  takeSnapshot,
  depth,
  addElementsGlobally,
  quitGateRef,
}) {
  const depthRef = useRef(depth);
  useEffect(() => {
    depthRef.current = depth;
  }, [depth]);
  const isMountedRef = useIsMountedRef();
  const { screenToFlowPosition, getIntersectingNodes, updateNodeData, getNode } = useReactFlow();
  const hoveredGroupIdRef = useRef(null);
  // Native `dragover` can fire faster than the display refresh rate; coalesce
  // to at most one intersection scan (screenToFlowPosition + an O(n) node scan)
  // per animation frame instead of running it on every single event.
  const dragOverRafRef = useRef(null);
  const pendingClientPosRef = useRef(null);

  const cancelPendingDragOverScan = useCallback(() => {
    if (dragOverRafRef.current != null) {
      cancelAnimationFrame(dragOverRafRef.current);
      dragOverRafRef.current = null;
    }
  }, []);

  useEffect(() => cancelPendingDragOverScan, [cancelPendingDragOverScan]);

  const handleDragLeave = useCallback(() => {
    cancelPendingDragOverScan();
    if (hoveredGroupIdRef.current) {
      // dragHover is also cleared here (not just isDropTarget) so a stale reject
      // label left by a node-absorption drag (useDragCorrections.js) can't
      // survive into this sidebar/Finder file-drop path.
      updateNodeData(hoveredGroupIdRef.current, { isDropTarget: false, dragHover: null });
      hoveredGroupIdRef.current = null;
    }
  }, [updateNodeData, cancelPendingDragOverScan]);

  const handleDragOver = useCallback((event) => {
    // preventDefault()/dropEffect must run synchronously on EVERY dragover per
    // the HTML5 DnD spec — only the (expensive) intersection scan is throttled.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';

    pendingClientPosRef.current = { x: event.clientX, y: event.clientY };
    if (dragOverRafRef.current != null) return; // a scan is already scheduled this frame

    dragOverRafRef.current = requestAnimationFrame(() => {
      dragOverRafRef.current = null;
      const { x: clientX, y: clientY } = pendingClientPosRef.current;
      const position = screenToFlowPosition({ x: clientX, y: clientY });
      const intersections = getIntersectingNodes({ x: position.x, y: position.y, width: 1, height: 1 });
      const targetGroup = intersections.find(n => n.type === 'group' && !n.data?.locked);
      const newTargetId = targetGroup ? targetGroup.id : null;

      if (newTargetId !== hoveredGroupIdRef.current) {
        // Clear dragHover alongside isDropTarget — see handleDragLeave above.
        if (hoveredGroupIdRef.current) updateNodeData(hoveredGroupIdRef.current, { isDropTarget: false, dragHover: null });
        if (newTargetId) updateNodeData(newTargetId, { isDropTarget: true });
        hoveredGroupIdRef.current = newTargetId;
      }
    });
  }, [screenToFlowPosition, getIntersectingNodes, updateNodeData]);

  const handleDrop = useCallback(async (event) => {
    event.preventDefault();
    if (quitGateRef?.current?.frozen) return;
    // A native file extraction can outlive a cancelled global quit. Keep the
    // drop bound to the interactive generation that started it rather than
    // appending its stale result after the renderer is released.
    const gateGeneration = quitGateRef?.current?.generation;
    const isCurrentDrop = () => !quitGateRef?.current?.frozen
      && quitGateRef?.current?.generation === gateGeneration;
    setIsDrawingMode(false);
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const nodeType = event.dataTransfer.getData('app/node-type');

    // Don't trust hoveredGroupIdRef here — handleDragOver's intersection scan
    // is rAF-throttled, so a scan can still be scheduled-but-not-yet-run at the
    // instant `drop` fires (the browser doesn't guarantee a frame boundary
    // between the last dragover and drop). Reading the ref would risk a stale
    // group from an earlier frame. handleDragLeave cancels that pending scan
    // and clears whatever highlight IS currently set; re-scan fresh at the
    // exact drop position for the actual target instead.
    handleDragLeave();
    const dropIntersections = getIntersectingNodes({ x: position.x, y: position.y, width: 1, height: 1 });
    const dropTargetGroup = dropIntersections.find(n => n.type === 'group' && !n.data?.locked);
    const targetId = dropTargetGroup ? dropTargetGroup.id : null;

    const insertNodes = (nodesToInsert) => {
      if (targetId) {
        const targetGroup = getNode(targetId);
        if (targetGroup) {
          const dims = getNodeDims(targetGroup);
          const cx = dims.w / 2;
          const cy = dims.h / 2;
          const nestedItems = nodesToInsert.map(n => ({
            ...n,
            position: {
              x: n.position.x - targetGroup.position.x - cx + 100,
              y: n.position.y - targetGroup.position.y - cy + 100
            }
          }));
          addElementsGlobally(targetId, nestedItems);
          return;
        }
      }
      setNodes(nds => nds.concat(nodesToInsert));
    };

    if (nodeType) {
      position.x -= 12;
      position.y -= 20;
      const factory = NODE_FACTORIES[nodeType];
      if (factory) {
        takeSnapshot();
        const newNode = factory(position);
        insertNodes([newNode]);
      }
      return;
    }

    if (event.dataTransfer.files?.length > 0) {
      const droppedFiles = Array.from(event.dataTransfer.files);
      const files = filesToDropPayloads(droppedFiles);

      // Only process items with valid system paths
      if (files.length === 0) {
        EventLogger.log('Drop ignored: no valid paths on files. files=' +
          JSON.stringify(droppedFiles.map(f => ({ name: f.name, type: f.type, size: f.size }))));
        return;
      }

      // EVERY file drop becomes a standalone document/picture node that displays
      // the file inline. Modules are NEVER auto-spawned by a file drop — the Job Search Module
      // (job search) and SellHub (marketplace) are created ONLY by dragging them
      // from the left sidebar; the user then drops their résumé / product photos
      // ONTO that hub (the hub has its own drop handler). Auto-spawning a Job Search Module
      // from a résumé drop surprised users (a dropped .docx is just a document) and
      // fired the pipeline on accidental drops — so a résumé/PDF/image now drops in
      // as a plain document like any other file.
      const dropDepth = depthRef.current;
      const newItems = await processDroppedFiles(files, position);
      if (!isMountedRef.current || !isCurrentDrop()) return;
      if (depthRef.current !== dropDepth) return; // Canvas changed during processing

      if (newItems.length > 0) {
        // File preparation is asynchronous and may legitimately yield no
        // insertable nodes (for example, an unreadable directory). Snapshot
        // immediately before the actual mutation so Undo never gets a no-op
        // entry, and so it still captures edits made while the scan was in
        // flight.
        takeSnapshot();
        EventLogger.log(`drop routed type=document files=${files.length}`);
        insertNodes(newItems);
      } else {
        EventLogger.log('Drop ignored: processDroppedFiles returned 0 items. count=' + files.length);
      }
      return;
    }

    // Handle dropping URLs from the browser address bar or other sources.
    // Guard: skip empty or near-empty text/plain payloads (e.g. sidebar hub drags
    // explicitly set text/plain to '' to prevent browser auto-fill from creating
    // spurious text nodes).
    const droppedText = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
    if (droppedText && droppedText.trim().length > 3) {
      const trimmedText = droppedText.trim();
      if (URL_RE.test(trimmedText) && !CODE_EXT_RE.test(trimmedText.split('?')[0].split('#')[0])) {
        takeSnapshot();
        const newNode = NODE_FACTORIES.link(position, { url: trimmedText });
        insertNodes([newNode]);
      } else if (trimmedText.length > 0) {
        takeSnapshot();
        // Insert as a TextNode if it doesn't match a URL format.
        // createTextNode only accepts position, so we patch the text field
        // manually — merging into the factory's data so the remembered text
        // style (font, colors) survives.
        const base = NODE_FACTORIES.text(position);
        const newNode = { ...base, data: { ...base.data, text: trimmedText, isNew: false } };
        insertNodes([newNode]);
      }
    }
  }, [screenToFlowPosition, setNodes, takeSnapshot, setIsDrawingMode, handleDragLeave, getIntersectingNodes, getNode, addElementsGlobally, isMountedRef, quitGateRef]);

  return { handleDrop, handleDragOver, handleDragLeave };
}
