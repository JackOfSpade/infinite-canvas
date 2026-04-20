import { useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_FACTORIES } from '../utils/nodeFactory';
import { processDroppedFiles } from '../utils/dragUtils';
import { getNodeDims } from '../utils/constants';

// Compiled once at module load — not per drop event.
const CODE_EXT_RE = /\.(?:js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|cs|php|swift|kt|md|txt|sh|yaml|yml|toml|ini|env|log)(?:[?#].*)?$/i;
const URL_RE = /^(https?:\/\/[^\s]+|[a-z0-9]([a-z0-9-]*[a-z0-9])?\.([a-z]{2,}\.)*[a-z]{2,}([/?#][^\s]*)?)$/i;

export function useCanvasDragAndDrop({
  setNodes,
  setIsDrawingMode,
  takeSnapshot,
  depth,
  addElementsGlobally,
}) {
  const depthRef = useRef(depth);
  useEffect(() => {
    depthRef.current = depth;
  }, [depth]);
  const { screenToFlowPosition, getIntersectingNodes, updateNodeData, getNode } = useReactFlow();
  const hoveredGroupIdRef = useRef(null);

  const handleDragLeave = useCallback(() => {
    if (hoveredGroupIdRef.current) {
      updateNodeData(hoveredGroupIdRef.current, { isDropTarget: false });
      hoveredGroupIdRef.current = null;
    }
  }, [updateNodeData]);

  const handleDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';

    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const intersections = getIntersectingNodes({ x: position.x, y: position.y, width: 1, height: 1 });
    const targetGroup = intersections.find(n => n.type === 'group' && !n.data?.locked);
    const newTargetId = targetGroup ? targetGroup.id : null;

    if (newTargetId !== hoveredGroupIdRef.current) {
      if (hoveredGroupIdRef.current) updateNodeData(hoveredGroupIdRef.current, { isDropTarget: false });
      if (newTargetId) updateNodeData(newTargetId, { isDropTarget: true });
      hoveredGroupIdRef.current = newTargetId;
    }
  }, [screenToFlowPosition, getIntersectingNodes, updateNodeData]);

  const handleDrop = useCallback(async (event) => {
    event.preventDefault();
    setIsDrawingMode(false);
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const nodeType = event.dataTransfer.getData('app/node-type');

    // Capture hover target before clearing it
    const targetId = hoveredGroupIdRef.current;
    handleDragLeave();

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
      const files = Array.from(event.dataTransfer.files).map(f => ({
        name: f.name,
        type: f.type,
        size: f.size,
        path: f.path || (window.electronAPI?.getPathForFile ? window.electronAPI.getPathForFile(f) : '')
      }));

      // Resume files (PDF/DOCX) → auto-create JobHubNode with filePath
      const resumeFile = files.find(f => f.name.match(/\.(pdf|docx|doc)$/i));
      if (resumeFile?.path) {
        takeSnapshot();
        const newNode = NODE_FACTORIES.jobhub(position, { filePath: resumeFile.path });
        insertNodes([newNode]);
        return;
      }

      // Default: treat as document/folder drops — only process items with valid system paths
      const validFiles = files.filter(f => f.path);
      if (validFiles.length === 0) {
        console.warn('Drop ignored: No paths found on files. Debug data:', JSON.stringify({
          files: files.map(f => ({ name: f.name, type: f.type, size: f.size, path: f.path })),
          types: event.dataTransfer.types,
          items: Array.from(event.dataTransfer.items || []).map(i => ({ kind: i.kind, type: i.type })),
          userAgent: navigator.userAgent
        }, null, 2));
        return;
      }

      takeSnapshot();
      const dropDepth = depthRef.current;
      const newItems = await processDroppedFiles(validFiles, position);
      if (depthRef.current !== dropDepth) return; // Canvas changed during processing

      if (newItems.length > 0) {
        insertNodes(newItems);
      } else {
        console.warn('processDroppedFiles returned 0 items for validFiles:', validFiles);
      }
      return;
    }

    // Handle dropping URLs from the browser address bar or other sources.
    const droppedUrl = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
    if (droppedUrl && droppedUrl.length < 2048) {
      const trimmedUrl = droppedUrl.trim();
      if (URL_RE.test(trimmedUrl) && !CODE_EXT_RE.test(trimmedUrl.split('?')[0].split('#')[0])) {
        takeSnapshot();
        const newNode = NODE_FACTORIES.link(position, { url: trimmedUrl });
        insertNodes([newNode]);
      }
    }
  }, [screenToFlowPosition, setNodes, takeSnapshot, setIsDrawingMode, handleDragLeave, getNode, addElementsGlobally]);

  return { handleDrop, handleDragOver, handleDragLeave };
}
