import { useState, useCallback } from 'react';

export function useContextMenu() {
  const [contextMenu, setContextMenu] = useState(null);

  const onContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  return { contextMenu, onContextMenu, closeContextMenu };
}
