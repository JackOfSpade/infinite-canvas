import { useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { EventLogger } from '../utils/EventLogger';

export function useIssueReporter({
  nodes,
  edges,
  drawings,
  activeTool,
  placementMode,
  eraserType,
  settings,
  currentFile,
  hasUnsavedChanges,
  navigationDepth,
  snapToGrid,
  addToast,
}) {
  const { getViewport } = useReactFlow();
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);

  const handleIssueSubmit = useCallback(async (description, mode = 'file') => {
    if (!window.electronAPI) {
      addToast({ title: 'Bug Report', description: "Not running in Electron, can't generate report.", type: "error" });
      return;
    }
    try {
      // Snapshot the viewport so resize/position math can be verified in reports.
      const viewport = getViewport();

      // For group nodes (CanvasNode), capture all three size fields separately.
      const nodeInternals = nodes.map(n => {
        return {
          id: n.id, 
          type: n.type,
          selected: !!n.selected,
          position:       n.position,
          fontSize:       n.data?.fontSize,
          fontFamily:     n.data?.fontFamily,
          textColor:      n.data?.textColor,
          backgroundColor: n.data?.backgroundColor,
          width_prop:     n.width,
          height_prop:    n.height,
          style_width:    n.style?.width,
          style_height:   n.style?.height,
          measured_width:  n.measured?.width,
          measured_height: n.measured?.height,
        };
      });

      // Snapshot whether any contenteditable is currently focused. A "save lost
      // my edit" bug is almost always caused by the user pressing Cmd+S while
      // still inside a text editor — TextNode only flushes innerText into
      // data.text on blur, so we record the live DOM text alongside the saved
      // data.text. A divergence here is the smoking gun.
      const ae = document.activeElement;
      let activeEditableText = null;
      if (ae && ae.isContentEditable) {
        const liveText = ae.innerText || '';
        const nearestNode = ae.closest('.react-flow__node');
        const editingNodeId = nearestNode?.getAttribute('data-id') || null;
        const savedNode = editingNodeId ? nodes.find(n => n.id === editingNodeId) : null;
        activeEditableText = {
          editingNodeId,
          liveText: liveText.length > 500 ? liveText.slice(0, 500) + '…' : liveText,
          savedText: savedNode?.data?.text != null
            ? (String(savedNode.data.text).length > 500
                ? String(savedNode.data.text).slice(0, 500) + '…'
                : String(savedNode.data.text))
            : null,
          divergent: savedNode ? (liveText !== (savedNode.data?.text || '')) : null,
        };
      }

      // Snapshot any active media elements so reports include playback position,
      // duration, error codes, network state, plus seekable/buffered ranges at
      // the moment of the report. An empty `seekable` while `buffered` is full
      // is the smoking gun for a non-Range-capable source.
      const trToArr = (tr) => {
        if (!tr) return [];
        const out = [];
        for (let i = 0; i < tr.length; i++) {
          out.push([tr.start(i), tr.end(i)]);
        }
        return out;
      };
      const mediaState = Array.from(
        document.querySelectorAll('video, audio')
      ).map(el => ({
        tag:          el.tagName.toLowerCase(),
        src:          el.currentSrc || el.getAttribute('src') || null,
        currentTime:  el.currentTime,
        duration:     isFinite(el.duration) ? el.duration : (Number.isNaN(el.duration) ? 'NaN' : (el.duration === Infinity ? 'Infinity' : null)),
        paused:       el.paused,
        ended:        el.ended,
        muted:        el.muted,
        volume:       el.volume,
        readyState:   el.readyState,   // 0=HAVE_NOTHING … 4=HAVE_ENOUGH_DATA
        networkState: el.networkState, // 0=EMPTY 1=IDLE 2=LOADING 3=NO_SOURCE
        seekable:     trToArr(el.seekable), // empty ⇒ source advertised as non-seekable
        buffered:     trToArr(el.buffered),
        errorCode:    el.error?.code ?? null,
        errorMessage: el.error?.message ?? null,
      }));

      // Snapshot all <img> elements so broken-image reports include the load
      // state at the moment of the report. naturalWidth/naturalHeight = 0 on a
      // `complete` img is the protocol-level failure signature (4xx/5xx response
      // or a decode error that Chromium couldn't handle). The src helps trace
      // which filePath / protocol scheme is misbehaving.
      const imageState = Array.from(document.querySelectorAll('img')).map(el => ({
        src:          el.getAttribute('src') || null,
        complete:     el.complete,
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight,
        broken:       el.complete && el.naturalWidth === 0,
      }));

      const payload = {
        description,
        nodes,
        edges,
        drawings,
        mediaState,
        imageState,
        frontEndState: {
          activeTool,
          placementMode,
          eraserType,
          settings,
          currentFile,
          hasUnsavedChanges,
          navigationDepth,
          snapToGrid,
          windowInnerWidth: window.innerWidth,
          windowInnerHeight: window.innerHeight,
          viewport: {
            x:    parseFloat(viewport.x.toFixed(2)),
            y:    parseFloat(viewport.y.toFixed(2)),
            zoom: parseFloat(viewport.zoom.toFixed(4)),
          },
        },
        nodeInternals,
        nodeComponentStates: EventLogger.getNodeStates(),
        eventLogs: EventLogger.getLogs(),
        lastSaveError: EventLogger.getLastSaveError(),
        activeEditableText,
      };

      if (mode === 'clipboard') {
        const res = await window.electronAPI.generateBugReportMarkdown(payload);
        if (!isMountedRef.current) return;

        if (res.success) {
          try {
            await navigator.clipboard.writeText(res.markdown);
            addToast({ title: 'Bug Report Copied', description: 'Report copied to clipboard.', type: "success" });
          } catch (clipErr) {
            EventLogger.error('Clipboard failed:', clipErr);
            addToast({ title: 'Clipboard Error', description: 'Generated report but could not copy to clipboard automatically.', type: "warning" });
          }
        } else {
          addToast({ title: 'Bug Report Failed', description: res.error || 'Could not generate the report.', type: "error" });
        }
      } else {
        const res = await window.electronAPI.exportBugReport(payload);
        if (!isMountedRef.current) return;

        if (res.success) {
          addToast({ title: 'Bug Report Saved', description: 'Your report has been exported successfully.', type: "success" });
        } else if (!res.canceled) {
          addToast({ title: 'Bug Report Failed', description: res.error || 'Could not save the report.', type: "error" });
        }
      }
    } catch (e) {
      if (isMountedRef.current) {
        addToast({ title: 'Bug Report Error', description: e?.message || String(e) || 'An unexpected error occurred.', type: "error" });
      }
    }
  }, [
    nodes, edges, drawings, activeTool, placementMode, eraserType, settings, currentFile,
    hasUnsavedChanges, navigationDepth, snapToGrid, addToast, getViewport
  ]);

  return { handleIssueSubmit };
}
