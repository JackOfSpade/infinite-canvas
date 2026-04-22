import { getNodeDims } from './constants';

/**
 * Computes a tidied grid layout for the provided nodes.
 * Preserves nodes not in the target group.
 * @param {Array} nds - Array of React Flow nodes
 * @param {boolean} onlySelected - If true, only tidies selected nodes 
 * @returns {Array} - New array of nodes with updated positions
 */
export function computeTidiedNodes(nds, onlySelected) {
  const targets = nds.filter(n => {
    if (n.data?.locked) return false;
    return onlySelected ? n.selected : true;
  });
  
  if (targets.length === 0) return nds;

  const parentGroups = {};
  targets.forEach(n => {
    const key = n.parentId || 'ROOT';
    if (!parentGroups[key]) parentGroups[key] = [];
    parentGroups[key].push(n);
  });

  const newPositions = {};

  Object.values(parentGroups).forEach(group => {
    const sorted = [...group].sort((a, b) => {
      if (Math.abs(a.position.y - b.position.y) > 100) return a.position.y - b.position.y;
      return a.position.x - b.position.x;
    });

    const cols = Math.ceil(Math.sqrt(group.length));
    const rows = Math.ceil(group.length / cols);
    const gutter = 40;

    const colWidths = new Array(cols).fill(0);
    const rowHeights = new Array(rows).fill(0);

    sorted.forEach((n, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const { w, h } = getNodeDims(n);
      colWidths[col] = Math.max(colWidths[col], w);
      rowHeights[row] = Math.max(rowHeights[row], h);
    });

    const colOffsets = new Array(cols).fill(0);
    const rowOffsets = new Array(rows).fill(0);
    for (let i = 1; i < cols; i++) colOffsets[i] = colOffsets[i - 1] + colWidths[i - 1] + gutter;
    for (let i = 1; i < rows; i++) rowOffsets[i] = rowOffsets[i - 1] + rowHeights[i - 1] + gutter;

    let anchorX = Infinity;
    let anchorY = Infinity;
    sorted.forEach(n => {
      anchorX = Math.min(anchorX, n.position.x);
      anchorY = Math.min(anchorY, n.position.y);
    });

    sorted.forEach((n, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      newPositions[n.id] = {
        x: anchorX + colOffsets[col],
        y: anchorY + rowOffsets[row]
      };
    });
  });

  return nds.map(n => {
    if (newPositions[n.id]) {
      return {
        ...n,
        position: newPositions[n.id]
      };
    }
    return n;
  });
}

/**
 * Returns true if placing the `nodesToAbsorb` cluster at `(anchorX, anchorY)`
 * (relative to `dropMinX`/`dropMinY`) overlaps any existing `childNodes`.
 */
export function placementOverlaps(anchorX, anchorY, nodesToAbsorb, dropMinX, dropMinY, childNodes, padding = 40) {
  return childNodes.some(child => {
    const cDims  = getNodeDims(child);
    const cLeft  = child.position.x - padding;
    const cRight = child.position.x + cDims.w + padding;
    const cTop   = child.position.y - padding;
    const cBottom = child.position.y + cDims.h + padding;
    return nodesToAbsorb.some(dragged => {
      const dDims   = getNodeDims(dragged);
      const dLeft   = anchorX + (dragged.position.x - dropMinX);
      const dRight  = dLeft + dDims.w;
      const dTop    = anchorY + (dragged.position.y - dropMinY);
      const dBottom = dTop + dDims.h;
      return !(dRight <= cLeft || dLeft >= cRight || dBottom <= cTop || dTop >= cBottom);
    });
  });
}

/**
 * Calculates a non-overlapping placement position for a cluster of nodes
 * being dropped into a subcanvas.
 */
export function findNonOverlappingPlacement(nodesToAbsorb, childNodes) {
  let dropMinX = Infinity, dropMaxX = -Infinity, dropMinY = Infinity, dropMaxY = -Infinity;
  nodesToAbsorb.forEach(n => {
    const d = getNodeDims(n);
    dropMinX = Math.min(dropMinX, n.position.x);
    dropMaxX = Math.max(dropMaxX, n.position.x + d.w);
    dropMinY = Math.min(dropMinY, n.position.y);
    dropMaxY = Math.max(dropMaxY, n.position.y + d.h);
  });
  const dropWidth  = dropMaxX - dropMinX;
  const dropHeight = dropMaxY - dropMinY;

  let anchorX = 0;
  let anchorY = 0;

  if (childNodes.length > 0) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    childNodes.forEach(child => {
      const cDims = getNodeDims(child);
      minX = Math.min(minX, child.position.x);
      maxX = Math.max(maxX, child.position.x + cDims.w);
      minY = Math.min(minY, child.position.y);
      maxY = Math.max(maxY, child.position.y + cDims.h);
    });
    
    const padding = 40;
    const childCx = (minX + maxX) / 2;
    const childCy = (minY + maxY) / 2;

    // Start by trying the absolute center of the cluster view
    anchorX = childCx - (dropWidth / 2);
    anchorY = childCy - (dropHeight / 2);

    // Spiral search for non-overlapping placement
    if (placementOverlaps(anchorX, anchorY, nodesToAbsorb, dropMinX, dropMinY, childNodes, padding)) {
      let found = false;
      let radius = 60;
      const radStep = 60;
      const maxRadius = Math.max(5000, dropWidth * 3, dropHeight * 3);

      while (!found && radius < maxRadius) {
        const numPoints = Math.max(8, Math.floor((2 * Math.PI * radius) / radStep));
        const angleStep = (2 * Math.PI) / numPoints;

        for (let i = 0; i < numPoints; i++) {
          const angle = i * angleStep;
          const testX = anchorX + radius * Math.cos(angle);
          const testY = anchorY + radius * Math.sin(angle);

          if (!placementOverlaps(testX, testY, nodesToAbsorb, dropMinX, dropMinY, childNodes, padding)) {
            anchorX = testX;
            anchorY = testY;
            found = true;
            break;
          }
        }
        radius += radStep;
      }
    }
  } else {
    // Empty sub-canvas, place dead center so view centers perfectly
    anchorX = -dropWidth / 2;
    anchorY = -dropHeight / 2;
  }

  return { anchorX, anchorY, dropMinX, dropMinY };
}
