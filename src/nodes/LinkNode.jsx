import React, { useState, useRef, useCallback, useContext, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { Dialog } from '../components/Dialog';
import { useNodeAutoEdit } from '../hooks/useNodeAutoEdit';
import { NodeHandles } from './_shared/NodeHandles';
import { LockBadge } from './_shared/LockBadge';
import { normalizeExternalHttpUrl } from '../utils/urlSafety';

const URL_LIKE = /^(https?:\/\/|[a-z0-9-]+\.[a-z]{2,}(\/.*)?$)/i;

export const LinkNode = React.memo(function LinkNode({ id, data }) {
  const [showDialog, setShowDialog] = useState(null); // 'url' | null
  const [urlInput, setUrlInput] = useState(data.url || '');
  const clickTimeoutRef = useRef(null);
  const focusTimerRef   = useRef(null);
  const inputRef        = useRef(null);

  const { updateNodeData } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;

  // Cancel pending timers on unmount so a stale callback can't fire after teardown.
  useEffect(() => () => {
    if (clickTimeoutRef.current !== null) clearTimeout(clickTimeoutRef.current);
    if (focusTimerRef.current   !== null) clearTimeout(focusTimerRef.current);
  }, []);

  const isEmptyPredicate = useCallback(
    () => !inputRef.current?.innerText?.trim(),
    [],
  );

  const {
    isEditing: isEditingLabel,
    setIsEditing: setIsEditingLabel,
    handleBlur,
  } = useNodeAutoEdit(id, data.isNew, isEmptyPredicate, inputRef);

  const handleLabelBlur = useCallback(() => {
    const rawText = inputRef.current?.innerText || '';
    // Auto-detect a raw URL pasted into a blank link node's label field; promote it
    // to `url` and leave `label` empty so the title auto-fetcher can populate it.
    if (URL_LIKE.test(rawText.trim()) && !data.url) {
      handleBlur({ url: rawText.trim(), label: '' });
    } else {
      handleBlur({ label: rawText });
    }
  }, [data.url, handleBlur]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') inputRef.current?.blur();
  }, []);

  const handlePaste = useCallback((e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

  // Sync label content when data changes externally (undo/redo).
  useEffect(() => {
    if (!isEditingLabel && inputRef.current) {
      const next = data.label || data.url || '';
      if (inputRef.current.innerText !== next) inputRef.current.innerText = next;
    }
  }, [data.label, data.url, isEditingLabel]);

  // Auto-fetch page title when we have a URL but no custom label yet.
  useEffect(() => {
    if (!data.url || data.label || !window.electronAPI?.fetchUrlTitle) return;
    let cancelled = false;
    // Small delay debounces rapid URL changes while user is still typing.
    const timer = setTimeout(() => {
      window.electronAPI.fetchUrlTitle(data.url)
        .then((title) => { if (!cancelled && title) updateGlobal(id, { label: title }); })
        .catch(() => {});
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [data.url, data.label, updateGlobal, id]);

  const openLink = useCallback(() => {
    const target = (data.url || inputRef.current?.innerText || '').trim();
    if (!target) return;
    const url = normalizeExternalHttpUrl(target);
    if (!url) return;
    if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
    else window.open(url, '_blank');
  }, [data.url]);

  // Single click: open the link, but defer so a follow-up dblclick can cancel.
  const handleClick = useCallback((e) => {
    e.stopPropagation();
    if (clickTimeoutRef.current !== null) return;
    clickTimeoutRef.current = setTimeout(() => {
      openLink();
      clickTimeoutRef.current = null;
    }, 250);
  }, [openLink]);

  const handleDoubleClick = useCallback((e) => {
    if (data.locked) return;
    e.stopPropagation();
    if (clickTimeoutRef.current !== null) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
    setIsEditingLabel(true);
    // Defer focus a tick so React commits the contentEditable=true flip first.
    if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => {
      focusTimerRef.current = null;
      inputRef.current?.focus({ preventScroll: true });
    }, 0);
  }, [data.locked, setIsEditingLabel]);

  const applyUrl = useCallback(() => {
    const urlChanged = urlInput !== data.url;
    // Clear label on URL change so the title auto-fetcher repopulates it.
    updateNodeData(id, { url: urlInput, ...(urlChanged && { label: '' }) });
    setShowDialog(null);
  }, [urlInput, data.url, updateNodeData, id]);

  // Listen for the global context-menu "Edit URL" trigger.
  useEffect(() => {
    const handleOpenUrl = () => {
      if (data.locked) return;
      setUrlInput(data.url || '');
      setShowDialog('url');
    };
    document.addEventListener(`edit-node-url-${id}`, handleOpenUrl);
    return () => document.removeEventListener(`edit-node-url-${id}`, handleOpenUrl);
  }, [id, data.url, data.locked]);

  const fontSize = data.fontSize || 14;
  const fontFamily = data.fontFamily || 'sans-serif';
  const textColor = data.textColor || null; // null keeps the default `text-blue-400`.
  const isEmpty = !data.label && !data.url;

  return (
    <div
      className={`relative group px-1 rounded-md transition-colors ${isEditingLabel ? 'nodrag' : ''}`}
      style={{ backgroundColor: data.backgroundColor || 'transparent' }}
    >
      <NodeHandles className="w-2 h-2 bg-blue-400" />

      {data.locked && <LockBadge />}

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
        onPaste={handlePaste}
        className={`${textColor ? '' : 'text-blue-400'} outline-none whitespace-nowrap min-w-[20px] min-h-[1em] ${
          isEditingLabel ? 'cursor-text' : 'select-none cursor-pointer hover:underline'
        }`}
        style={{
          fontSize: `${fontSize}px`,
          fontFamily,
          ...(textColor ? { color: textColor } : null),
          ...(isEditingLabel ? { userSelect: 'text' } : null),
        }}
      />

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
          <button
            className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-2 mt-2 font-medium transition-colors"
            onClick={applyUrl}
          >
            Done
          </button>
        </Dialog>
      )}
    </div>
  );
});
