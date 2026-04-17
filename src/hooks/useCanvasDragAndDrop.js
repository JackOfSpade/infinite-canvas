import { useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_FACTORIES } from '../utils/nodeFactory';
import { processDroppedFiles } from '../utils/dragUtils';

export function useCanvasDragAndDrop({
  setNodes,
  setIsDrawingMode,
  takeSnapshot,
  depth,
}) {
  const depthRef = useRef(depth);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    depthRef.current = depth;
  }, [depth]);
  const { screenToFlowPosition } = useReactFlow();

  const handleDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(async (event) => {
    event.preventDefault();
    setIsDrawingMode(false);
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const nodeType = event.dataTransfer.getData('app/node-type');

    if (nodeType) {
      position.x -= 12;
      position.y -= 20;
      const factory = NODE_FACTORIES[nodeType];
      if (factory) {
        takeSnapshot();
        setNodes(nds => nds.concat(factory(position)));
      }
      return;
    }

    if (event.dataTransfer.files?.length > 0) {
      const files = Array.from(event.dataTransfer.files);

      // Resume files (PDF/DOCX) → auto-create JobHubNode with filePath
      const resumeFile = files.find(f => f.name.match(/\.(pdf|docx|doc)$/i));
      if (resumeFile?.path) {
        takeSnapshot();
        setNodes(nds => nds.concat(NODE_FACTORIES.jobhub(position, { filePath: resumeFile.path })));
        return;
      }

      // Image-only drops → auto-create SellHubNode with imagePaths
      const imageFiles = files.filter(f => f.name.match(/\.(png|jpg|jpeg|webp|gif)$/i));
      if (imageFiles.length === files.length && imageFiles.length > 0) {
        takeSnapshot();
        setNodes(nds => nds.concat(NODE_FACTORIES.sellhub(position, { imagePaths: imageFiles.map(f => f.path) })));
        return;
      }

      // Default: treat as document/folder drops — only process items with valid system paths
      const validFiles = files.filter(f => f.path);
      if (validFiles.length === 0) return;

      takeSnapshot();
      const dropDepth = depthRef.current;
      const newItems = await processDroppedFiles(validFiles, position);
      if (!isMountedRef.current) return;
      if (depthRef.current !== dropDepth) return; // Canvas changed during processing

      if (newItems.length > 0) {
        setNodes(nds => nds.concat(newItems));
      }
      return;
    }

    // Handle dropping URLs from the browser address bar
    const droppedUrl = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
    if (droppedUrl && /^(https?:\/\/|[a-z0-9-]+\.[a-z]{2,}(\/.*)?$)/i.test(droppedUrl.trim())) {
      takeSnapshot();
      setNodes(nds => nds.concat(NODE_FACTORIES.link(position, { url: droppedUrl.trim() })));
    }
  }, [screenToFlowPosition, setNodes, takeSnapshot, setIsDrawingMode]);

  return { handleDrop, handleDragOver };
}
