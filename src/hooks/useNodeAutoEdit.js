import { useState, useRef, useEffect, useCallback } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';

/**
 * Custom hook to handle auto-edit focusing for nodes upon initial placement,
 * and deleting nodes if they lose focus without any content.
 * 
 * @param {string} id - The ID of the node.
 * @param {boolean} isNew - Indicates if the node was just placed.
 * @param {Function} isEmptyPredicate - A function returning true if the node is considered empty.
 */
export function useNodeAutoEdit(id, isNew, isEmptyPredicate, inputRef) {
  const [isNewInitial] = useState(isNew);
  const [isEditing, setIsEditing] = useState(isNewInitial);
  const { updateNodeData, setNodes, setViewport } = useReactFlow();
  const store = useStoreApi();
  const hasFocusedRef = useRef(false);

  // Auto-edit on initial placement
  useEffect(() => {
    let timeoutId;
    let rafId;

    if (isNewInitial && !hasFocusedRef.current) {
      hasFocusedRef.current = true;
      updateNodeData(id, { isNew: undefined });
      
      timeoutId = setTimeout(() => {
        if (inputRef.current) {
          // Capture viewport state before focus to prevent any auto-zoom/pan
          const { transform } = store.getState();
          const savedViewport = { x: transform[0], y: transform[1], zoom: transform[2] };

          if (typeof inputRef.current.select === 'function') {
            inputRef.current.select();
          }
          if (inputRef.current.isContentEditable) {
            inputRef.current.innerText = '';
          }
          inputRef.current.focus({ preventScroll: true });

          // Restore viewport immediately after focus to undo any shift
          rafId = requestAnimationFrame(() => {
            setViewport(savedViewport);
          });
        }
      }, 50);
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [id, updateNodeData, store, setViewport, isNewInitial, inputRef]);

  // Handle blurring the input
  const handleBlur = useCallback((dataUpdates = {}) => {
    setIsEditing(false);
    // Never auto-delete locked nodes — the user deliberately locked them
    const currentNode = store.getState().nodeLookup?.get(id);
    const isLocked = currentNode?.data?.locked;
    if (isEmptyPredicate() && !isLocked) {
      setNodes(nds => nds.filter(n => n.id !== id));
    } else {
      updateNodeData(id, dataUpdates);
    }
  }, [id, isEmptyPredicate, setNodes, updateNodeData, store]);

  return {
    isEditing,
    setIsEditing,
    inputRef,
    handleBlur,
  };
}
