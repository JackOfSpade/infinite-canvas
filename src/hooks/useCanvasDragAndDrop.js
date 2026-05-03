import { useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_FACTORIES } from '../utils/nodeFactory';
import { processDroppedFiles } from '../utils/dragUtils';
import { getNodeDims } from '../utils/constants';
import { EventLogger } from '../utils/EventLogger';

// Compiled once at module load — not per drop event.
const CODE_EXT_RE = /\.(?:js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|cs|php|swift|kt|md|txt|sh|yaml|yml|toml|ini|env|log)$/i;
const URL_RE = /^(https?:\/\/[^\s]+|[a-z0-9]([a-z0-9-]*[a-z0-9])?\.([a-z]{2,}\.)*[a-z]{2,}([/?#][^\s]*)?)$/i;
const RESUME_EXT_RE = /\.(pdf|docx|doc)$/i;

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
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);
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

      // Only process items with valid system paths
      const validFiles = files.filter(f => f.path);
      if (validFiles.length === 0) {
        EventLogger.log('Drop ignored: no valid paths on files. files=' +
          JSON.stringify(files.map(f => ({ name: f.name, type: f.type, size: f.size, path: f.path }))));
        return;
      }

      const resumeFiles = validFiles.filter(f => RESUME_EXT_RE.test(f.name));
      const otherFiles  = validFiles.filter(f => !RESUME_EXT_RE.test(f.name));

      // Resume dropped → auto-create a JobHub pre-seeded with that file path.
      // The JobHubNode's own mount effect kicks off pipeline automatically.
      if (resumeFiles.length > 0 && otherFiles.length === 0) {
        takeSnapshot();
        EventLogger.log(`drop routed type=jobhub files=${resumeFiles.length}`);
        insertNodes([NODE_FACTORIES.jobhub(position, { filePath: resumeFiles[0].path })]);
        return;
      }

      // Default: treat as document/folder drops. Images become document nodes
      // that display the image inline. SellHub is created intentionally by
      // dragging it from the sidebar, not auto-routed from image drops.
      takeSnapshot();
      const dropDepth = depthRef.current;
      const newItems = await processDroppedFiles(validFiles, position);
      if (!isMountedRef.current) return;
      if (depthRef.current !== dropDepth) return; // Canvas changed during processing

      if (newItems.length > 0) {
        EventLogger.log(`drop routed type=document files=${validFiles.length}`);
        insertNodes(newItems);
      } else {
        EventLogger.log('Drop ignored: processDroppedFiles returned 0 items. count=' + validFiles.length);
      }
      return;
    }

    // Handle dropping URLs from the browser address bar or other sources.
    const droppedText = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
    if (droppedText && droppedText.length < 2048) {
      const trimmedText = droppedText.trim();
      if (URL_RE.test(trimmedText) && !CODE_EXT_RE.test(trimmedText.split('?')[0].split('#')[0])) {
        takeSnapshot();
        const newNode = NODE_FACTORIES.link(position, { url: trimmedText });
        insertNodes([newNode]);
      } else if (trimmedText.length > 0) {
        takeSnapshot();
        // Insert as a TextNode if it doesn't match a URL format.
        // createTextNode only accepts position, so we patch the text field manually.
        const newNode = { ...NODE_FACTORIES.text(position), data: { text: trimmedText, isNew: false } };
        insertNodes([newNode]);
      }
    }
  }, [screenToFlowPosition, setNodes, takeSnapshot, setIsDrawingMode, handleDragLeave, getNode, addElementsGlobally]);

  return { handleDrop, handleDragOver, handleDragLeave };
}
