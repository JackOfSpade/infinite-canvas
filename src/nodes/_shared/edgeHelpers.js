/**
 * Edge helpers shared by hubs that radially spawn child cards.
 *
 * Both SellHub (comp source cards) and JobHub (job source cards) need:
 *   - To route hub→card edges to the hub's nearest side (not always right).
 *   - The same "structural" edge config so users can't accidentally detach
 *     spawn-tracking edges.
 */

/**
 * Pick source/target handle ids based on a card's position relative to its
 * hub center. Dominant axis (horizontal vs vertical) wins. Handle ids match
 * the slots NodeHandles renders on both ends.
 *
 * @param {{x: number, y: number}} cardCenter — card's center in canvas coords
 * @param {{x: number, y: number}} hubCenter  — hub's center in canvas coords
 * @returns {{sourceHandle: string, targetHandle: string}}
 */
export function pickEdgeHandles(cardCenter, hubCenter) {
  const dx = cardCenter.x - hubCenter.x;
  const dy = cardCenter.y - hubCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'right',    targetHandle: 'left'     }
      : { sourceHandle: 'left-out', targetHandle: 'right-in' };
  }
  return dy >= 0
    ? { sourceHandle: 'bottom',  targetHandle: 'top'        }
    : { sourceHandle: 'top-out', targetHandle: 'bottom-in'  };
}

/**
 * Standard config for a structural hub→card edge. The edge represents the
 * spawn relationship, not a user-managed connection — selectable/deletable
 * are off so the user can't strand an orphan card whose progress events
 * still route back to the hub.
 *
 * @param {string} stroke — `rgba(...)` color matching the hub theme
 */
export function structuralEdge(stroke) {
  return {
    type: 'smoothstep',
    animated: true,
    selectable: false,
    deletable: false,
    focusable: false,
    style: { stroke, strokeWidth: 2 },
  };
}
