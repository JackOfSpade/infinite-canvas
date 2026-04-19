import { useCallback } from 'react';
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
        const base = { id: n.id, type: n.type };
        if (n.type === 'group') {
          return {
            ...base,
            position:       n.position,
            width_prop:     n.width,
            height_prop:    n.height,
            style_width:    n.style?.width,
            style_height:   n.style?.height,
            measured_width:  n.measured?.width,
            measured_height: n.measured?.height,
          };
        }
        return base;
      });

      const payload = {
        description,
        nodes,
        edges,
        drawings,
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
      };

      if (mode === 'clipboard') {
        const res = await window.electronAPI.generateBugReportMarkdown(payload);

        if (res.success) {
          try {
            await navigator.clipboard.writeText(res.markdown);
            addToast({ title: 'Bug Report Copied', description: 'Report copied to clipboard.', type: "success" });
          } catch (clipErr) {
            console.error('Clipboard failed:', clipErr);
            addToast({ title: 'Clipboard Error', description: 'Generated report but could not copy to clipboard automatically.', type: "warning" });
          }
        } else {
          addToast({ title: 'Bug Report Failed', description: res.error || 'Could not generate the report.', type: "error" });
        }
      } else {
        const res = await window.electronAPI.exportBugReport(payload);

        if (res.success) {
          addToast({ title: 'Bug Report Saved', description: 'Your report has been exported successfully.', type: "success" });
        } else if (!res.canceled) {
          addToast({ title: 'Bug Report Failed', description: res.error || 'Could not save the report.', type: "error" });
        }
      }
    } catch (e) {
      addToast({ title: 'Bug Report Error', description: e?.message || String(e) || 'An unexpected error occurred.', type: "error" });
    }
  }, [
    nodes, edges, drawings, activeTool, placementMode, eraserType, settings, currentFile,
    hasUnsavedChanges, navigationDepth, snapToGrid, addToast, getViewport
  ]);

  return { handleIssueSubmit };
}
