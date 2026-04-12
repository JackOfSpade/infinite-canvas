import { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { v4 as uuidv4 } from 'uuid';

export function useCanvasDragAndDrop({
  nodes,
  setNodes,
  setEdges,
  setIsDrawingMode,
  setPendingListing,
  setListingUrlInput,
  takeSnapshot
}) {
  const { screenToFlowPosition } = useReactFlow();

  const handleDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(async (event) => {
    event.preventDefault();
    if (!window.electronAPI) return;
    setIsDrawingMode(false);
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const nodeType = event.dataTransfer.getData('app/node-type');

    if (nodeType) {
      position.x -= 12;
      position.y -= 20;
      if (nodeType === 'text') {
        takeSnapshot();
        setNodes(nds => nds.concat({ id: uuidv4(), type: 'text', position, data: { text: '', isNew: true } }));
      } else if (nodeType === 'link') {
        takeSnapshot();
        setNodes(nds => nds.concat({ id: uuidv4(), type: 'link', position, data: { url: '', label: '', isNew: true } }));
      } else if (nodeType === 'group') {
        takeSnapshot();
        setNodes(nds => nds.concat({ id: uuidv4(), type: 'group', dragHandle: '.drag-handle', style: { width: 320 }, position, data: { title: '', nodes: [], edges: [], collapsed: false, isNew: true } }));
      } else if (nodeType.startsWith('listing-')) {
        setPendingListing({ position, platform: nodeType.replace('listing-', '') });
        setListingUrlInput('');
      }
      return;
    }

    if (event.dataTransfer.files?.length > 0) {
      takeSnapshot();
      let currentPos = { ...position };
      for (const file of event.dataTransfer.files) {
        try {
          const result = await window.electronAPI.scanDirectory(file.path);
          if (result.isFile) {
            const f = result.file;
            setNodes(nds => nds.concat({ id: f.id, type: 'document', position: { ...currentPos }, data: { filename: f.filename, filePath: f.filePath } }));
          } else {
            setNodes(nds => nds.concat({ id: result.id, type: 'group', position: { ...currentPos }, data: { title: result.title, nodes: [], edges: [], collapsed: true } }));
          }
          currentPos = { x: currentPos.x + 40, y: currentPos.y + 40 };
        } catch (e) {
          console.error('Failed to read file/folder', e);
        }
      }
    }
  }, [screenToFlowPosition, setNodes, takeSnapshot, setIsDrawingMode, setPendingListing, setListingUrlInput]);

  const onNodeDragStop = useCallback((_event, draggedNode) => {
    // Only capture nodes dragged within the main canvas (fixes nested graph bubbling bug)
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

      // Calculate dragged node center
      const dw = draggedNode.measured?.width || 80;
      const dh = draggedNode.measured?.height || 40;
      const cx = draggedNode.position.x + dw / 2;
      const cy = draggedNode.position.y + dh / 2;

      // Does the center of the node fall within the group's content area?
      if (
        cx >= gx &&
        cx <= gx + gw &&
        cy >= gy + 20 && // Give some leeway for the title bar
        cy <= gy + gh
      ) {
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
                return {
                  ...n,
                  data: { ...n.data, nodes: [...(n.data.nodes || []), newNode] },
                };
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
