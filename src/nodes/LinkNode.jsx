import React, { useState, useRef, useCallback, useContext, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { Dialog } from '../components/Dialog';
import { CustomizeDialog } from '../components/CustomizeDialog';
import { useNodeAutoEdit } from '../hooks/useNodeAutoEdit';
import { Lock } from 'lucide-react';

export const LinkNode = React.memo(function LinkNode({ id, data }) {
  const [showDialog, setShowDialog] = useState(null); // 'font' | 'url'
  const [urlInput, setUrlInput] = useState(data.url || '');
  const clickTimeoutRef = useRef(null);
  const focusTimerRef   = useRef(null);
  const { updateNodeData } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;

  const inputRef = useRef(null);
  useEffect(() => {
    return () => {
      if (clickTimeoutRef.current !== null) clearTimeout(clickTimeoutRef.current);
      if (focusTimerRef.current   !== null) clearTimeout(focusTimerRef.current);
    };
  }, []);

  const isEmptyPredicate = useCallback(() => {
    return !inputRef.current?.innerText?.trim();
  }, []);

  const { isEditing: isEditingLabel, setIsEditing: setIsEditingLabel, handleBlur } = useNodeAutoEdit(id, data.isNew, isEmptyPredicate, inputRef);

  const handleLabelBlur = useCallback(() => {
    const rawText = inputRef.current?.innerText || '';
    
    // Auto-detect if user pasted a raw URL directly into a blank link node's label field
    const isProbablyUrl = /^(https?:\/\/|[a-z0-9-]+\.[a-z]{2,}(\/.*)?$)/i.test(rawText.trim());
    
    if (isProbablyUrl && !data.url) {
      handleBlur({ url: rawText.trim(), label: '' }); // Leave label empty to trigger the auto-fetcher
    } else {
      handleBlur({ label: rawText });
    }
  }, [data.url, handleBlur]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') inputRef.current?.blur();
  }, []);

  const handlePointerDown = useCallback((e) => {
    if (isEditingLabel) e.stopPropagation();
  }, [isEditingLabel]);

  // Sync label content when data changes externally (undo/redo)
  useEffect(() => {
    if (!isEditingLabel && inputRef.current) {
      if (inputRef.current.innerText !== (data.label || data.url || '')) {
        inputRef.current.innerText = data.label || data.url || '';
      }
    }
  }, [data.label, data.url, isEditingLabel]);

  // Auto-fetch title if we have a URL but no custom label yet
  useEffect(() => {
    let isMounted = true;
    if (data.url && !data.label && window.electronAPI?.fetchUrlTitle) {
      // Small delay to prevent rapid fires if user is actively typing a URL
      const timer = setTimeout(() => {
        window.electronAPI.fetchUrlTitle(data.url).then(title => {
          if (isMounted && title) {
            updateGlobal(id, { label: title });
          }
        }).catch(() => {});
      }, 500);
      return () => {
        isMounted = false;
        clearTimeout(timer);
      };
    }
    return () => { isMounted = false; };
  }, [data.url, data.label, updateGlobal, id]);

  const openLink = useCallback(() => {
    const targetUrl = data.url || inputRef.current?.innerText || '';
    if (targetUrl && targetUrl.trim()) {
      let target = targetUrl;
      if (!target.startsWith('http://') && !target.startsWith('https://')) {
        target = 'https://' + target;
      }
      if (window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(target);
      } else {
        window.open(target, '_blank');
      }
    }
  }, [data.url]);

  const handleClick = useCallback((e) => {
    e.stopPropagation();
    if (clickTimeoutRef.current !== null) return;
    clickTimeoutRef.current = setTimeout(() => {
      openLink();
      clickTimeoutRef.current = null;
    }, 250);
  }, [openLink]);

  const handleDoubleClick = useCallback((e) => {
    if (data.locked) return; // Locked nodes are not editable
    e.stopPropagation();
    if (clickTimeoutRef.current !== null) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
    setIsEditingLabel(true);
    // Use a separate ref so this delay doesn't collide with the click-debounce guard
    if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => {
      focusTimerRef.current = null;
      if (inputRef.current) inputRef.current.focus({ preventScroll: true });
    }, 0);
  }, [data.locked, setIsEditingLabel]);

  const applyUrl = useCallback(() => {
    const urlChanged = urlInput !== data.url;
    updateNodeData(id, { url: urlInput, ...(urlChanged ? { label: '' } : {}) });
    setShowDialog(null);
  }, [urlInput, data.url, updateNodeData, id]);

  const fontSize = data.fontSize || 14;
  const fontFamily = data.fontFamily || 'sans-serif';
  // textColor overrides the default blue; null means keep the CSS class default
  const textColor = data.textColor || null;
  const isEmpty = !data.label && !data.url;

  // Listen for dialog triggers from global context menu
  useEffect(() => {
    const handleOpenFont = () => {
      if (data.locked) return; // Locked nodes are not editable
      setShowDialog('customize');
    };
    const handleOpenUrl = () => {
      if (data.locked) return; // Locked nodes are not editable
      setUrlInput(data.url || '');
      setShowDialog('url');
    };
    
    document.addEventListener(`edit-node-font-${id}`, handleOpenFont);
    document.addEventListener(`edit-node-url-${id}`, handleOpenUrl);
    
    return () => {
      document.removeEventListener(`edit-node-font-${id}`, handleOpenFont);
      document.removeEventListener(`edit-node-url-${id}`, handleOpenUrl);
    };
  }, [id, data.url, data.locked]);

  return (
    <div 
      className="relative group px-1 rounded-md transition-colors"
      style={{
        backgroundColor: data.backgroundColor || 'transparent'
      }}
    >
      <Handle type="target" position={Position.Top} id="top" className="w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity bg-blue-400" />
      <Handle type="target" position={Position.Left} id="left" className="w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity bg-blue-400" />
      
      {data.locked && (
        <div className="absolute -top-2 -right-2 bg-black/60 rounded-full p-0.5 text-white/70 backdrop-blur-sm pointer-events-none z-10">
          <Lock size={10} />
        </div>
      )}
      
      {/* Placeholder shown on hover when empty and not editing */}
      {isEmpty && !isEditingLabel && (
        <div 
          className="absolute inset-0 flex items-center text-blue-400/40 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ fontSize: `${fontSize}px`, fontFamily }}
        >
          link
        </div>
      )}

      <div
        ref={inputRef}
        contentEditable={isEditingLabel}
        suppressContentEditableWarning
        onClick={isEditingLabel ? undefined : handleClick}
        onDoubleClick={handleDoubleClick}
        onBlur={handleLabelBlur}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        className={`${textColor ? '' : 'text-blue-400'} outline-none whitespace-nowrap min-w-[20px] min-h-[1em] ${isEditingLabel ? 'cursor-text' : 'select-none cursor-pointer hover:underline'}`}
        style={{ fontSize: `${fontSize}px`, fontFamily, ...(textColor ? { color: textColor } : {}), ...(isEditingLabel ? { userSelect: 'text' } : {}) }}
      />

      <Handle type="source" position={Position.Right} id="right" className="w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity bg-blue-400" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity bg-blue-400" />

      {showDialog === 'customize' && (
        <CustomizeDialog
          fontSize={fontSize}
          fontFamily={fontFamily}
          textColor={data.textColor || '#60a5fa'}
          backgroundColor={data.backgroundColor}
          onApply={(updates) => updateNodeData(id, updates)}
          onClose={() => setShowDialog(null)}
        />
      )}

      {showDialog === 'url' && (
        <Dialog title="Edit URL" onClose={() => setShowDialog(null)}>
          <input 
            type="text"
            className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-white font-mono text-sm outline-none"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://..."
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') applyUrl(); }}
          />
          <button className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-2 mt-2 font-medium transition-colors" onClick={applyUrl}>Done</button>
        </Dialog>
      )}
    </div>
  );
});
