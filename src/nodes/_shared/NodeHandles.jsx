import React from 'react';
import { Handle, Position } from '@xyflow/react';

const HANDLE_BASE = 'pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity';

const POSITIONS = [
  { type: 'target', position: Position.Top,    id: 'top'    },
  { type: 'target', position: Position.Left,   id: 'left'   },
  { type: 'source', position: Position.Right,  id: 'right'  },
  { type: 'source', position: Position.Bottom, id: 'bottom' },
];

/**
 * The four target/source handles every node renders. They're absolute-positioned
 * by React Flow, so DOM order within the node doesn't matter — render them once.
 *
 * @param {string} className - Tailwind classes for size + background. Defaults to `w-2 h-2 bg-white`.
 * @param {object} style     - Inline style merged onto each handle (e.g. dynamic accent color).
 * @param {boolean} noResize - Adds `data-no-resize="true"` so resize logic ignores the handle.
 */
export const NodeHandles = React.memo(function NodeHandles({
  className = 'w-2 h-2 bg-white',
  style,
  noResize = false,
}) {
  const extra = noResize ? { 'data-no-resize': 'true' } : null;
  return (
    <>
      {POSITIONS.map(({ type, position, id }) => (
        <Handle
          key={id}
          type={type}
          position={position}
          id={id}
          className={`${HANDLE_BASE} ${className}`}
          style={style}
          {...extra}
        />
      ))}
    </>
  );
});
