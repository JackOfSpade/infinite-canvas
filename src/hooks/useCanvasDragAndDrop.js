import { useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_FACTORIES } from '../utils/nodeFactory';
import { processDroppedFiles } from '../utils/dragUtils';

// Compiled once at module load — not per drop event.
const CODE_EXT_RE = /\.(?:js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|cs|php|swift|kt|md|txt|sh|yaml|yml|toml|ini|env|log)(?:[?#].*)?$/i;
const URL_RE = /^(https?:\/\/[^\s]+|[a-z0-9]([a-z0-9-]*[a-z0-9])?\.([a-z]{2,}\.)*[a-z]{2,}([/?#][^\s]*)?)$/i;

export function useCanvasDragAndDrop({
  setNodes,
  setIsDrawingMode,
  takeSnapshot,
  depth,
}) {
  const depthRef = useRef(depth);
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
        setNodes(nds => nds.concat(NODE_FACTORIES.jobhub(position, { filePath: resumeFile.path })));
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
        setNodes(nds => nds.concat(newItems));
      } else {
        console.warn('processDroppedFiles returned 0 items for validFiles:', validFiles);
      }
      return;
    }

    // Handle dropping URLs from the browser address bar or other sources.
    // Strict regex: must start with an explicit protocol (https?://) OR look like a
    // real hostname (word.word format) followed by an optional path. Common code
    // file extensions (.js, .ts, .py, .md, etc.) are explicitly excluded so that
    // dropping source files or markdown links doesn't accidentally create Link nodes.
    const droppedUrl = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
    if (droppedUrl && droppedUrl.length < 2048) {
      const trimmedUrl = droppedUrl.trim();
      if (URL_RE.test(trimmedUrl) && !CODE_EXT_RE.test(trimmedUrl.split('?')[0].split('#')[0])) {
        takeSnapshot();
        setNodes(nds => nds.concat(NODE_FACTORIES.link(position, { url: trimmedUrl })));
      }
    }
  }, [screenToFlowPosition, setNodes, takeSnapshot, setIsDrawingMode]);

  return { handleDrop, handleDragOver };
}
