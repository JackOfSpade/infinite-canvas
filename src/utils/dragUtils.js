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
