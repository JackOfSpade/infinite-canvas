import { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_FACTORIES } from '../utils/nodeFactory';
import { processDroppedFiles } from '../utils/dragUtils';

export function useCanvasDragAndDrop({
  setNodes,
  setIsDrawingMode,
  takeSnapshot,
}) {
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

      // Default: treat as document/folder drops
      takeSnapshot();
      const newItems = await processDroppedFiles(event.dataTransfer.files, position);
      if (newItems.length > 0) {
        setNodes(nds => nds.concat(newItems));
      }
    }
  }, [screenToFlowPosition, setNodes, takeSnapshot, setIsDrawingMode]);

  return { handleDrop, handleDragOver };
}
