import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { EventLogger } from '../utils/EventLogger';
import { useModalStackCount } from '../components/modalStack';
import { isTextEditingTarget } from '../utils/nativeTextUndo';

export function useCanvasKeyboardShortcuts({
  placementMode, setPlacementMode, 
  activeTool, setActiveTool, 
  setIsSettingsOpen,
  isAnimatingRef,
  duplicateNodes, copyNodes, pasteNodes,
  shortcuts
}) {
  const { getNodes } = useReactFlow();
  const modalCount = useModalStackCount();

  useEffect(() => {
    const handleKey = (e) => {
      // A dialog/menu/lightbox is open — its own Escape handling owns the
      // keyboard; without this, e.g. Cmd+D on a dialog button duplicated the
      // canvas selection underneath it.
      if (modalCount > 0) return;
      if (isAnimatingRef?.current) return;

      // Was an inline tag==='INPUT' check, which treats ANY input as text-editing
      // regardless of type — a focused checkbox/radio would incorrectly block
      // these shortcuts. isTextEditingTarget checks the input's actual type.
      if (isTextEditingTarget(e.target)) return;

      const k = e.key.toLowerCase();
      const s = shortcuts || {};

      const isMatch = (binding) => {
        if (!binding) return false;
        const matched = k === binding.key.toLowerCase() &&
               !!e.metaKey === !!binding.meta &&
               !!e.ctrlKey === !!binding.ctrl &&
               !!e.altKey === !!binding.alt &&
               !!e.shiftKey === !!binding.shift;
        if (matched) {
          EventLogger.log(`Shortcut triggered: ${binding.label || 'unknown'}`);
        }
        return matched;
      };

      // Prevent OS key-repeat from re-firing any shortcut below while a key is
      // held — Duplicate in particular would otherwise rapid-clone nodes for
      // as long as Cmd+D stays pressed. Applied before the hardcoded D/C/V
      // branches, not just the tool-selection ones further down.
      if (e.repeat) return;

      // Duplicate / Copy / Paste are intentionally hardcoded to Ctrl/Cmd+D/C/V
      // rather than going through the configurable `shortcuts` map — they mirror
      // OS conventions users expect and aren't meant to be rebindable.
      if (k === 'd' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const selectedNodes = getNodes().filter(n => n.selected);
        if (selectedNodes.length === 0) return;
        EventLogger.log('Shortcut triggered: Duplicate');
        duplicateNodes(selectedNodes);
        return;
      }

      if (k === 'c' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const selectedNodes = getNodes().filter(n => n.selected);
        if (selectedNodes.length === 0) return;
        EventLogger.log('Shortcut triggered: Copy');
        copyNodes(selectedNodes);
        return;
      }

      if (k === 'v' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        EventLogger.log('Shortcut triggered: Paste');
        pasteNodes();
        return;
      }

      // Ignore if any modifier keys are pressed (to avoid colliding with OS/Browser shortcuts)
      // Exception: Escape is allowed to fire regardless of modifiers for emergency cancellation.
      if (e.key !== 'Escape' && (e.metaKey || e.ctrlKey || e.altKey)) return;

      if (e.key === 'Escape') {
        if (placementMode) { setPlacementMode(null); return; }
        if (activeTool)    { setActiveTool(null);    return; }
      }

      if (isMatch(s.selectTool)) {
        e.preventDefault();
        setActiveTool(prev => prev === 'select' ? null : 'select');
        setPlacementMode(null);
        return;
      }

      if (isMatch(s.textTool)) {
        e.preventDefault();
        setPlacementMode('text');
        setActiveTool(null);
        return;
      }

      if (isMatch(s.linkTool)) {
        e.preventDefault();
        setPlacementMode('link');
        setActiveTool(null);
        return;
      }

      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setIsSettingsOpen(true);
        return;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [placementMode, activeTool, setPlacementMode, setActiveTool, setIsSettingsOpen, isAnimatingRef, getNodes, duplicateNodes, copyNodes, pasteNodes, shortcuts, modalCount]);
}
