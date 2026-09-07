import { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { EventLogger } from '../utils/EventLogger';
import { applyBugReportCode } from '../utils/bugReportCodes';
import { isJobNodeType, isSellNodeType } from '../utils/nodePresence';
import { buildSellHubResolveSnapshot } from '../utils/sellHubResolveSnapshot';
import { redactNodeForIssueReport } from '../utils/issueReportRedaction';
import { useIsMountedRef } from './useIsMountedRef';

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
  enumerateAllNodes,
}) {
  const { getViewport } = useReactFlow();
  const isMountedRef = useIsMountedRef();

  const handleIssueSubmit = useCallback(async (description, filterCode, mode = 'file') => {
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
          // Visibility: collapsed job-tree cards/groups carry hidden:true. The
          // bug report's Node Diagnostics flags this and treats hidden cards as
          // anomalies that are always shown (never omitted) — it expects this
          // field. Without it, visibility/minimap/culling bugs are invisible in
          // the report even at FULL.
          hidden:         !!n.hidden,
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

      // Snapshot the issue reporter draft states to debug persistence issues.
      let issueReporterDraft = {
        localStoragePresent: false,
        localStorageLength: 0,
        localStoragePrefix: '',
        sessionStoragePresent: false,
        sessionStorageLength: 0,
        sessionStoragePrefix: '',
      };
      try {
        const lsDraft = localStorage.getItem('issue-reporter-draft');
        if (lsDraft !== null) {
          issueReporterDraft.localStoragePresent = true;
          issueReporterDraft.localStorageLength = lsDraft.length;
          issueReporterDraft.localStoragePrefix = lsDraft.slice(0, 50) + (lsDraft.length > 50 ? '…' : '');
        }
      } catch (e) {
        issueReporterDraft.localStorageError = e?.message || String(e);
      }
      try {
        const ssDraft = sessionStorage.getItem('issue-reporter-draft');
        if (ssDraft !== null) {
          issueReporterDraft.sessionStoragePresent = true;
          issueReporterDraft.sessionStorageLength = ssDraft.length;
          issueReporterDraft.sessionStoragePrefix = ssDraft.slice(0, 50) + (ssDraft.length > 50 ? '…' : '');
        }
      } catch (e) {
        issueReporterDraft.sessionStorageError = e?.message || String(e);
      }

      // Apply the AI-issued filter code: selects which log lines and payload
      // sections to include. This keeps reports focused and short.
      // Validate before taking the event snapshot. The warning must be part of
      // THIS report (not merely visible in the next one), so it is recorded
      // before rawLogs/filteredLogs are captured below.
      const requestedFilter = applyBugReportCode(EventLogger.getLogs(), {}, filterCode);

      const unknownFilterWarning = requestedFilter.unknownCodes?.length > 0
        ? `ERROR: Bug report filter: unknown code(s): ${requestedFilter.unknownCodes.join(', ')}`
        : null;
      if (unknownFilterWarning) {
        EventLogger.error(`Bug report filter: unknown code(s): ${requestedFilter.unknownCodes.join(', ')}`);
      }
      const rawLogs = EventLogger.getLogs();
      const { filteredLogs: selectedLogs, sectionExclusions, label: filterLabel } =
        applyBugReportCode(rawLogs, {}, filterCode);
      // A narrow code such as UI+NOPE would otherwise omit the unknown-code
      // warning it just created. Attach the exact last event explicitly so the
      // malformed filter is self-evident in every report mode, even QUICK.
      const filteredLogs = unknownFilterWarning && !selectedLogs.some(line => line.includes(unknownFilterWarning))
        ? [...selectedLogs, rawLogs[rawLogs.length - 1]]
        : selectedLogs;

      // Strip heavy per-node payloads before the report crosses IPC. A done Job
      // Search Module stores its full scored-jobs array in data.scoredJobs (each
      // job carries a description + résumé) — 150+ of those would blow the report
      // size budget and crowd out the logs. Replace the array with a count; the
      // Node Diagnostics section surfaces `scoredJobs: N` from it.
      const reportNodes = nodes.map(redactNodeForIssueReport);
      const nodeComponentStates = EventLogger.getNodeStates();

      // Local AI job state lives on job cards, and the fallback manager drives
      // cards the active React Flow arrays cannot see (collapsed groups,
      // parent navigation levels). Collect it from the GLOBAL node graph as
      // its own payload field so it (a) covers every card the manager acts on
      // and (b) survives filter codes that drop the `nodes` section — the
      // HANDOFF lens excludes `nodes` yet exists precisely for this state.
      const allNodesDeep = typeof enumerateAllNodes === 'function' ? enumerateAllNodes() : nodes;
      // Filtered reports omit the heavyweight node payload, but recovery
      // sidecars identify their source hub by id. Carry only this compact deep
      // id index across that boundary so a valid grouped hub is not reported as
      // deleted after RECOVERY drops `nodes`.
      const currentNodeIds = [...new Set((allNodesDeep || [])
        .map(node => typeof node?.id === 'string' ? node.id : null)
        .filter(Boolean))];
      // Job Board staleness is a consumer-stage completion fact, not a heavy
      // node-dump detail. Preserve a bounded, non-job-content summary so JOBS
      // and RECOVERY reports can still say that collection finished while a
      // connected board is intentionally hiding an obsolete cascade.
      const nodeTypeById = new Map((allNodesDeep || []).map(node => [node?.id, node?.type]));
      const connectedSourceHubIdsByBoard = new Map();
      // Edges are scoped to the currently visible canvas.  That is still useful
      // corroboration for a board on this level; the board's persisted combine
      // signature remains the durable source provenance when a nested canvas
      // is being reported from another level.
      for (const edge of edges || []) {
        const boardId = nodeTypeById.get(edge?.source) === 'jobboard'
          ? edge.source
          : nodeTypeById.get(edge?.target) === 'jobboard'
            ? edge.target
            : null;
        const otherId = boardId === edge?.source ? edge?.target : edge?.source;
        if (!boardId || nodeTypeById.get(otherId) !== 'jobhub') continue;
        if (!connectedSourceHubIdsByBoard.has(boardId)) connectedSourceHubIdsByBoard.set(boardId, new Set());
        connectedSourceHubIdsByBoard.get(boardId).add(otherId);
      }
      // Independent of anything the board recorded about itself: how many job
      // cards for it are ACTUALLY on the canvas. `resultCount` and
      // `mergeStats.unique` are both written from the same merge output, so
      // comparing them can never fail; this is the only number the report can
      // check the board's claim against. Board filters and collapsed groups set
      // `hidden` rather than removing nodes, so this is stable across view state.
      const renderedCardsByBoard = new Map();
      for (const node of allNodesDeep || []) {
        if (node?.type !== 'jobcard') continue;
        const owner = node?.data?.hubId;
        if (typeof owner !== 'string' || !owner) continue;
        renderedCardsByBoard.set(owner, (renderedCardsByBoard.get(owner) || 0) + 1);
      }
      const allJobBoardStates = (allNodesDeep || [])
        .filter(node => node?.type === 'jobboard')
        .map(node => ({
          renderedCardCount: renderedCardsByBoard.get(node.id) ?? 0,
          id: typeof node.id === 'string' ? node.id : '',
          hubState: typeof node.data?.hubState === 'string' ? node.data.hubState : 'empty',
          resultCount: Number.isFinite(Number(node.data?.resultCount)) ? Math.max(0, Math.floor(Number(node.data.resultCount))) : null,
          stale: node.data?.stale === true,
          staleReason: typeof node.data?.staleReason === 'string' ? node.data.staleReason.slice(0, 120) : null,
          combineSignature: typeof node.data?.combineSignature === 'string' ? node.data.combineSignature.slice(0, 4_000) : null,
          mergeUnique: Number.isFinite(Number(node.data?.mergeStats?.unique)) ? Math.max(0, Math.floor(Number(node.data.mergeStats.unique))) : null,
          connectedSourceHubIds: [...(connectedSourceHubIdsByBoard.get(node.id) || [])].slice(0, 25),
        }));
      const localApplications = (allNodesDeep || []).flatMap((n) => {
        const localApplication = n?.type === 'jobcard' ? n?.data?.localApplication : null;
        return localApplication?.id ? [{
          nodeId: n.id,
          title: n?.data?.title || '',
          company: n?.data?.company || '',
          localApplication,
        }] : [];
      });

      // Build the full payload, then drop sections excluded by the filter code.
      const fullPayload = {
        description,
        filterCode: filterCode || null,
        filterLabel: filterCode ? filterLabel : null,
        filterStats: filterCode ? {
          eventsShown: filteredLogs.length,
          eventsTotal: rawLogs.length,
          omittedSections: Array.from(sectionExclusions),
          // Stamp node-presence NOW (from the intact deep graph) so module sections
          // survive a filter code that drops the `nodes` section — otherwise a
          // JOBS/MARKET report loses the very diagnostics it was meant to surface.
          hasJobNodes: (allNodesDeep || []).some(n => isJobNodeType(n?.type)),
          hasSellNodes: (allNodesDeep || []).some(n => isSellNodeType(n?.type)),
          currentNodeIds,
          jobBoardStates: allJobBoardStates.slice(0, 25),
          jobBoardStateCount: allJobBoardStates.length,
        } : null,
        nodes: reportNodes,
        edges,
        drawings,
        localApplications,
        mediaState,
        imageState,
        issueReporterDraft,
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
        nodeComponentStates,
        sellHubResolveStates: buildSellHubResolveSnapshot(reportNodes, nodeComponentStates),
        eventLogs: filteredLogs,
        lastSaveError: EventLogger.getLastSaveError(),
        activeEditableText,
      };

      // Drop sections the filter code says to omit (e.g. LEAN removes node dumps).
      const payload = { ...fullPayload };
      for (const section of sectionExclusions) {
        delete payload[section];
      }

      if (mode === 'clipboard') {
        const res = await window.electronAPI.generateBugReportMarkdown(payload);
        if (!isMountedRef.current) return;

        if (res.success) {
          // 'file-pointer' is the normal path: the full uncapped report was
          // written to disk and the clipboard gets a short pointer, not the
          // report body. 'inline-fallback' means the file write itself failed,
          // so clipboardText is the old size-capped report text instead.
          const isFilePointer = res.delivery === 'file-pointer';
          try {
            await navigator.clipboard.writeText(res.clipboardText);
            if (isFilePointer) {
              addToast({
                title: 'Bug Report Saved',
                description: `Saved to ${res.savedPath} — its path (not the report itself) is on your clipboard.`,
                type: "success",
              });
            } else {
              // `reduced` is measured against the uncapped render, not inferred
              // from the cap being applied — a small report that failed to save
              // is copied WHOLE, and telling the user it was size-capped would
              // send them hunting for data that never went missing.
              addToast({
                title: 'Bug Report Copied',
                description: res.reduced
                  ? `Could not save the report file (${res.saveError}), so a size-capped report was copied to the clipboard instead.`
                  : `Could not save the report file (${res.saveError}), so the full report was copied to the clipboard instead.`,
                type: "warning",
              });
            }
          } catch (clipErr) {
            EventLogger.error('Clipboard failed:', clipErr);
            if (isFilePointer) {
              // Better news than the legacy failure: the full report already
              // exists on disk, so the clipboard miss is fully recoverable.
              addToast({
                title: 'Clipboard Error',
                description: `The report is saved at ${res.savedPath} — clipboard copy failed, but you can open the file directly.`,
                type: "warning",
              });
            } else {
              addToast({ title: 'Clipboard Error', description: 'Generated report but could not copy it automatically. Use Save to File to keep the report.', type: "warning" });
            }
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
    hasUnsavedChanges, navigationDepth, snapToGrid, addToast, getViewport, isMountedRef,
    enumerateAllNodes
  ]);

  return { handleIssueSubmit };
}
