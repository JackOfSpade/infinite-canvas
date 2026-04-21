import { EventLogger } from './EventLogger';

/**
 * Creates a drag ghost element, sets it as drag image, and auto-removes it.
 * Used when dragging items from the toolbar onto the canvas.
 *
 * @param {DragEvent} e - The native DOM drag event
 * @param {string} text - The text icon or generic name for the ghost UI
 * @param {string} color - The text color representing the node type
 */
export function setupDragGhost(e, text, color) {
  const ghost = document.createElement('div');
  ghost.textContent = text;
  Object.assign(ghost.style, {
    color,
    backgroundColor: 'transparent',
    position: 'absolute',
    top: '-1000px',
    fontFamily: 'sans-serif',
    fontSize: '14px',
    fontWeight: '500',
  });
  document.body.appendChild(ghost);
  const rect = ghost.getBoundingClientRect();
  e.dataTransfer.setDragImage(ghost, rect.width / 2, rect.height);
  setTimeout(() => document.body.removeChild(ghost), 0);
}

/**
 * Creates an SVG-based drag ghost for folder/group nodes.
 * Shows the same blue folder outline as the click-to-place hover icon.
 */
export function setupCanvasDragGhost(e) {
  const ghost = document.createElement('div');
  ghost.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgb(96,165,250)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3a2 2 0 0 0-2 2"/><path d="M19 3a2 2 0 0 1 2 2"/><path d="M21 19a2 2 0 0 1-2 2"/><path d="M5 21a2 2 0 0 1-2-2"/><path d="M9 3h1"/><path d="M9 21h1"/><path d="M14 3h1"/><path d="M14 21h1"/><path d="M3 9v1"/><path d="M21 9v1"/><path d="M3 14v1"/><path d="M21 14v1"/></svg>';
  Object.assign(ghost.style, {
    position: 'absolute',
    top: '-1000px',
    backgroundColor: 'transparent',
  });
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => document.body.removeChild(ghost), 0);
}

/**
 * Processes dropped OS files asynchronously into canvas Node objects.
 * Handles single files (DocumentNode) and scanned folders (CanvasNode with nested children).
 * Automatically shifts positions diagonally to prevent overlapping drops.
 */
export async function processDroppedFiles(files, startPosition) {
  if (!window.electronAPI) return [];
  const newItems = [];
  let currentPos = { ...startPosition };
  
  const buildNode = (fsItem, pos) => {
    if (fsItem.type === 'document') {
      return {
        id: crypto.randomUUID(),
        type: 'document',
        position: { ...pos },
        data: { filename: fsItem.filename, filePath: fsItem.filePath }
      };
    } else {
      const items = fsItem.items || [];
      const cols = 3;
      const childNodes = items.map((child, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return buildNode(child, { x: 20 + col * 220, y: 60 + row * 180 });
      });

      // Calculate a reasonable diameter for the circular folder node.
      // Base size 180, grows slightly with item count, capped at 400.
      const size = Math.min(400, 180 + Math.floor(items.length / 5) * 40);

      return {
        id: crypto.randomUUID(),
        type: 'group',
        position: { ...pos },
        style: { width: size, height: size },
        data: { 
          title: fsItem.title, 
          filePath: fsItem.filePath,
          canvasData: {
            nodes: childNodes,
            edges: [],
            drawings: [],
          },
        }
      };
    }
  };

  for (const file of files) {
    try {
      const result = await window.electronAPI.scanDirectory(file.path);
      if (result && result.success === false) {
        EventLogger.log(`Drop: skipping file/folder ${file.path}: ${result.error}`);
        continue;
      }
      const fsItem = result.isFile ? result.file : result;
      newItems.push(buildNode(fsItem, currentPos));
      // Offset subsequent items slightly to prevent them stacking perfectly on top of each other
      currentPos = { x: currentPos.x + 40, y: currentPos.y + 40 };
    } catch (e) {
      EventLogger.error('Failed to read file/folder on drop payload', e);
    }
  }
  
  return newItems;
}
