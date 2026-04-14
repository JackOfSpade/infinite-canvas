import { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_FACTORIES } from '../utils/nodeFactory';
import { processDroppedFiles } from '../utils/dragUtils';

export function useCanvasDragAndDrop({
  nodes,
  setNodes,
  setEdges,
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

  const onNodeDragStop = useCallback((_event, draggedNode) => {
    const isMainCanvasNode = nodes.some(n => n.id === draggedNode.id);
    if (!isMainCanvasNode) return;

    const expandedGroups = nodes.filter(
      n => n.type === 'group' && n.data.collapsed === false && n.id !== draggedNode.id
    );

    for (const group of expandedGroups) {
      const gx = group.position.x;
      const gy = group.position.y;
      const gw = group.measured?.width || group.style?.width || 320;
      const gh = group.measured?.height || 250;

      const dw = draggedNode.measured?.width || 80;
      const dh = draggedNode.measured?.height || 40;
      const cx = draggedNode.position.x + dw / 2;
      const cy = draggedNode.position.y + dh / 2;

      if (cx >= gx && cx <= gx + gw && cy >= gy + 20 && cy <= gy + gh) {
        const newNode = { ...draggedNode, selected: false };
        newNode.position = {
          x: Math.max(0, draggedNode.position.x - gx - 10),
          y: Math.max(0, draggedNode.position.y - gy - 40)
        };

        takeSnapshot();
        setNodes(nds =>
          nds
            .filter(n => n.id !== draggedNode.id)
            .map(n => {
              if (n.id === group.id) {
                return { ...n, data: { ...n.data, nodes: [...(n.data.nodes || []), newNode] } };
              }
              return n;
            })
        );
        setEdges(eds => eds.filter(e => e.source !== draggedNode.id && e.target !== draggedNode.id));
        break;
      }
    }
  }, [nodes, setNodes, setEdges, takeSnapshot]);

  return { handleDrop, handleDragOver, onNodeDragStop };
}
