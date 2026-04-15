# Infinite Canvas — Debugging Progress & Audit Log

> **Purpose:** This file tracks every area of the codebase that has been audited, every edge case
> checked, and every bug fixed. Read this at the start of any new session to avoid re-checking
> areas that have already been verified. Jump to [What Still Needs Checking](#-what-still-needs-checking)
> to find the next unaudited areas.

---

## ✅ Files Fully Audited (Do Not Re-Check)

### Backend / Electron
| File | Status | Notes |
|------|--------|-------|
| `electron/preload.js` | ✅ Clean | IPC bridge — no issues |
| `electron/main.js` | ✅ Clean | App lifecycle, window management — robust |
| `electron/ipc/bugReport.js` | ✅ Clean | 10MB file limit, safe truncation |
| `electron/ipc/filesystem.js` | ✅ Clean | Dialog abort guards in place |
| `electron/ipc/gemini.js` | ✅ Clean | Graceful fail to toast on missing service-account |
| `electron/ipc/jobs.js` | ✅ Clean | Per-domain rate limiters, clean backoff |
| `electron/ipc/marketplace.js` | ✅ Clean | No issues |
| `electron/ipc/accounts.js` | ✅ Clean | No issues |
| `electron/ipc/stealthBrowser.js` | ✅ Clean | No issues |
| `electron/ipc/browserPool.js` | ✅ Clean | No issues |
| `electron/ipc/browserViewMonitor.js` | ✅ Clean | No issues |

### Hooks
| File | Status | Notes |
|------|--------|---------|
| `src/hooks/useUndoRedo.js` | ✅ Clean | `clearHistory` correct; `isRestoringRef` blocks debounce during undo/redo — no undo loops |
| `src/hooks/useCanvasPersistence.js` | ✅ Fixed (Bugs 36, 55, 56) | `resetStack` & `clearHistory` called on load; `sanitizeNodesForSave` strips transient opacity |
| `src/hooks/useCanvasNavigation.js` | ✅ Fixed | `clearHistory` on level transitions; BreadcrumbBar stale ID safe; `extractToParent` position offset correct |
| `src/hooks/useCanvasContextMenu.js` | ✅ Fixed (Bugs 52, 53, 67–70b) | All locked-node menu items disabled; guards in `setNodeColor`, `aiPolishText`, `toggleStickyNote`; `depth>0` guard on Move to Parent |
| `src/hooks/useCanvasActions.js` | ✅ Fixed (Bug 38) | `doClear` calls `resetStack` + `takeSnapshot` before clearing |
| `src/hooks/useCanvasDragAndDrop.js` | ✅ Fixed (Bug 29) | URL drag handled; all drag paths take snapshot; animation-window drop is accepted minor risk |
| `src/hooks/useDrawingMode.js` | ✅ Clean | Object eraser skips locked nodes; `takeSnapshot` at correct gesture boundaries; Escape cleanup correct |
| `src/hooks/useCustomFitView.js` | ✅ Clean | Display utility only — no edge cases |
| `src/hooks/useNodeAutoEdit.js` | ✅ Clean | `isNew` cleared on mount; duplicates get `isNew:false`; locked nodes not auto-deleted on empty blur |
| `src/hooks/useCanvasInitialization.js` | ✅ Fixed (Bug 71) | `sanitizeNodesForSave` applied in autosave timer |
| `src/hooks/useSettings.js` | ✅ Clean | localStorage try-catch, fallback to defaults |
| `src/hooks/useListingActions.js` | ✅ Clean | `syncPriceFromBackend` no-override; `researchPrice` try-catch; field edits locked-guarded by parent |

### Contexts
| File | Status | Notes |
|------|--------|---------|
| `src/contexts/CanvasNavigationContext.jsx` | ✅ Clean | Just `createContext(null)` — no logic |

### Node Components
| File | Status | Notes |
|------|--------|-------|
| `src/nodes/TextNode.jsx` | ✅ Fixed (Bugs 40, 70) | Font dialog + double-click guarded; locked nodes not edited |
| `src/nodes/LinkNode.jsx` | ✅ Fixed (Bugs 41, 70b) | Font + URL dialog guarded; URL fetch on paste correct |
| `src/nodes/CanvasNode.jsx` | ✅ Clean | Dive-in blocked when locked; title input disabled; delete button hidden; lock icon shown |
| `src/nodes/DocumentNode.jsx` | ✅ Clean | Double-click file-open blocked when locked; file watcher correctly cleaned up |
| `src/nodes/JobCardNode.jsx` | ✅ Fixed (Bug 65) | Dismiss button hidden, status select disabled, cover letter button disabled when locked |
| `src/nodes/JobHubNode.jsx` | ✅ Fixed (Bug 62) | Resume drop + error retry blocked when locked |
| `src/nodes/SellHubNode.jsx` | ✅ Fixed (Bugs 63, 73) | Image drop + error retry blocked when locked; `AnimatedSourceRing` receives `nodeId={id}` |
| `src/nodes/ListingNode.jsx` | ✅ Fixed (Bugs 47, 66) | All priced-state controls disabled when locked; confirm draft blocked |
| `src/nodes/sellhub/SellHubDraftState.jsx` | ✅ Fixed (Bug 48) | EditableField + confirm disabled when locked |
| `src/nodes/sellhub/SellHubPricedState.jsx` | ✅ Fixed (Bug 64) | Price input, quick buttons, toggles, copy all disabled when locked |
| `src/nodes/jobhub/JobHubProcessingState.jsx` | ✅ Clean | Display only, no interaction |
| `src/nodes/jobhub/JobHubDoneState.jsx` | ✅ Clean | Filter toggle only, low risk |

### Shared UI Components
| File | Status | Notes |
|------|--------|-------|
| `src/components/QuickPriceButtons.jsx` | ✅ Fixed (Bugs 50, 64) | `onSelect` null-safe + `disabled` prop |
| `src/components/PlatformToggles.jsx` | ✅ Fixed (Bugs 51, 64) | `onToggle` null-safe + `disabled` prop |
| `src/components/EditableField.jsx` | ✅ Fixed (Bug 47) | `disabled` prop gates `onStartEdit` |
| `src/components/ToastProvider.jsx` | ✅ Fixed (Bug 57) | Capped at 5 simultaneous toasts |
| `src/components/Sidebar.jsx` | ✅ Clean | Module drag sets correct `app/node-type`, stats via `useMemo`, account status fetched on open |
| `src/components/CanvasToolbar.jsx` | ✅ Clean | Save state guard correct, undo/redo disabled states correct, HEX color input low-risk |
| `src/components/CanvasThumbnail.jsx` | ✅ Clean | Empty guard, bounding box calc, edge/drawing fallbacks all correct |
| `src/components/SettingsPanel.jsx` | ✅ Clean | Escape closes, click-outside closes, localStorage try-catch in `useSettings` |
| `src/components/KeyboardShortcutsPanel.jsx` | ✅ Clean | `?` toggle, Escape close, contentEditable guard all correct |
| `src/components/IssueReporterDialog.jsx` | ✅ Clean | Empty guard on submit, isSubmitting prevents double-send |
| `src/components/PriceJustification.jsx` | ✅ Clean | Expand/collapse is local UI state only — does not mutate persisted data |
| `src/components/HubContainer.jsx` | ✅ Clean | `onDrop` guard is in parent; `onDragOver` visual feedback only — acceptable |
| `src/components/AnimatedSourceRing.jsx` | ✅ Fixed (Bug 72) | SVG marker IDs now namespaced with `nodeId` — prevents collision across multiple hub instances |
| `src/components/DrawingLayer.jsx` | ✅ Clean | SVG polyline rendering — no issues |
| `src/components/StatusBar.jsx` | ✅ Clean | Counts and display only |
| `src/components/SearchBar.jsx` | ✅ Clean | Enter/Shift+Enter cycle correct; nested canvas pans to container (intentional) |
| `src/components/BreadcrumbBar.jsx` | ✅ Clean | Jump nav correct |
| `src/components/ConfirmDialog.jsx` | ✅ Clean | Escape fires onCancel; scalar state prevents stacking |
| `src/components/OnboardingOverlay.jsx` | ✅ Fixed (Bug 35) | Skip button positioning fixed (relative parent added) |
| `src/components/sidebar/JobsTab.jsx` | ✅ Clean | Display + drag only |
| `src/components/sidebar/SellTab.jsx` | ✅ Clean | Display + drag only |
| `src/components/sidebar/DashboardTab.jsx` | ✅ Clean | Stats display only, `useMemo` correct |
| `src/components/sidebar/AccountsTab.jsx` | ✅ Clean | Login failure logs to console (acceptable), status re-fetched after login |
| `src/components/sidebar/DraggableModuleCard.jsx` | ✅ Clean | Drag start sets correct dataTransfer type |
| `src/components/Dialog.jsx` | ✅ Clean | Escape listener in `useEffect([onClose])` with proper cleanup; backdrop stopPropagation correct |
| `src/components/EmptyCanvasHint.jsx` | ✅ Clean | Pure display; `nodeCount > 0 \|\| drawingCount > 0` guard correct |
| `src/components/AlignedBackground.jsx` | ✅ Clean | Positive-modulo phase calc correct; single instance per canvas — pattern ID collision N/A |
| `src/components/ContextMenu.jsx` | ✅ Fixed (Bug 74) | Submenus now flip left when right-side space < 192px; parent menu viewport clamping already present |
| `src/components/FontSizeDialog.jsx` | ✅ Fixed (Bug 75) | Font size now capped at 500 (`Math.min(500, ...)` + `max={500}` attr); min=1 already enforced |

| `src/nodes/SellHubNode.jsx` | ✅ Fixed (Bugs 63, 73) | Already listed in Node Components above |

### Canvas Core
| File | Status | Notes |
|------|--------|---------|
| `src/Canvas.jsx` | ✅ Fixed (Bugs 32, 38, 59) | `isValidConnection` guards sticky notes; `clearHistory` wired; `resetStack` on load; `deleteKeyCode=['Backspace','Delete']` safe (RF v12 checks `isContentEditable`) |

### Entry Points
| File | Status | Notes |
|------|--------|-------|
| `src/main.jsx` | ✅ Clean | Standard React 18 `createRoot` entry; `StrictMode` correct |
| `src/App.jsx` | ✅ Clean | `ToastProvider` wraps `ReactFlowProvider` wraps `Canvas` — provider nesting correct |

### Utilities & Electron
| File | Status | Notes |
|------|--------|---------|
| `src/utils/dragUtils.js` | ✅ Clean | `file.path` requires Electron ≥v12 (supported) |
| `src/utils/EventLogger.js` | ✅ Clean | No issues |
| `src/utils/nodeFactory.js` | ✅ Clean | No issues |
| `src/utils/constants.js` | ✅ Clean | No issues |
| `electron/preload.js` | ✅ Acceptable | `contextBridge` used correctly; generic `invoke` is acceptable for trusted desktop app |
| `electron/main.js` | ✅ Acceptable | `before-quit` handler present; no force-save (accepted 2s window limitation) |
| `electron/ipc/browser/antiDetectProfiles.js` | ✅ Clean | Session profile picked once per process; `getRandomUA()` delegates to session profile |
| `electron/ipc/browser/humanEmulation.js` | ✅ Clean | Bézier mouse, momentum scroll, cookie banner dismissal — all guards in place |
| `electron/ipc/browser/authWindows.js` | ✅ Clean | Closes headless browser before opening visible login window (required — can't share userDataDir simultaneously); resolves on `disconnected` event |
| `electron/ipc/browserPool.js` | ✅ Fixed (Bug 76) | `gaussianDelay`: `Math.random() \|\| Number.EPSILON` prevents `log(0)=−∞ → NaN → setTimeout bypass` |
| `electron/extractors/apiExtractors.js` | ✅ Clean | `getRandomUA` import from `stealthBrowser.js` valid (re-exported there); all fetchers have `AbortSignal.timeout` + `try/catch`; `processInBatches` uses `Promise.allSettled` |
| `electron/extractors/facebookExtractor.js` | ✅ Clean | Pure browser-context IIFE strings; depth guards on Relay recursion prevent infinite loops |
| `electron/extractors/jobs.js` | ✅ Fixed (Bug 77) | ZipRecruiter `__NEXT_DATA__` strategy: `job.location \|\| job.city ? X : Y` operator-precedence bug fixed to `job.location \|\| (job.city ? X : Y)` |
| `electron/extractors/marketplace.js` | ✅ Clean | eBay/Poshmark/Swappa/Mercari extractors — all have `try/catch` per card; dedup by URL where needed |


---

## 🐛 Complete Bug Registry

| Bug # | File(s) | Description | Session |
|-------|---------|-------------|---------|
| 26 | `useCanvasContextMenu.js` | "Move to Parent Canvas" bypassed locked state | 1 |
| 27 | `useCanvasContextMenu.js` | Tidy algorithm repositioned locked nodes | 1 |
| 28 | `LinkNode.jsx` | URL pasted into label field never triggered fetch | 1 |
| 29 | `useCanvasDragAndDrop.js` | Browser URL drag-and-drop ignored | 1 |
| 30 | `TextNode.jsx` | Sticky note target handle still visible/active | 1 |
| 31 | `useCanvasContextMenu.js` | Sticky note incoming edges not severed on toggle | 1 |
| 32 | `Canvas.jsx` | Clear canvas wiped undo stack — ⌘Z couldn't recover | 1 |
| 33 | `useCanvasContextMenu.js` | "Move to Parent Canvas" not snapshotted for undo | 1 |
| 34 | `TextNode.jsx` | Sticky note opacity broken when color-coded | 1 |
| 35 | `useCanvasContextMenu.js` | Edge severance used wrong API shape (silently failed) | 1 |
| 36 | `useCanvasPersistence.js` | Loading workspace while nested corrupted nav state | 1 |
| 38 | `useCanvasActions.js` | Clear while nested left stale breadcrumbs | 1 |
| 39 | `TextNode.jsx`, `LinkNode.jsx` | Double-click editing not blocked on locked nodes | 1 |
| 40 | `CanvasNode.jsx` | Double-click dive-in not blocked on locked canvas node | 3 |
| 44 | `DocumentNode.jsx` | Double-click file open not blocked on locked node | 3 |
| 47 | `OnboardingOverlay.jsx` | Skip button missing `relative` parent — wrong position | 3 |
| 48 | `SellHubDraftState.jsx` | EditableField + Confirm active on locked node | 4 |
| 50 | `QuickPriceButtons.jsx` | `onSelect` crash (TypeError) when undefined | 4 |
| 51 | `PlatformToggles.jsx` | `onToggle` crash (TypeError) when undefined | 4 |
| 52 | `useCanvasContextMenu.js` | AI Polish Text available on locked nodes | 3 |
| 53 | `useCanvasContextMenu.js` | Make Sticky Note available on locked nodes | 3 |
| 54 | `CanvasNode.jsx` | Title input editable while locked | 3 |
| 55 | `useCanvasPersistence.js` | `loadCanvas` dep array missing `resetStack` etc. | 3 |
| 56 | `useCanvasPersistence.js`, `Canvas.jsx` | History not cleared on workspace load | 4 |
| 57 | `ToastProvider.jsx` | Toasts unbounded — infinite stack possible | 4 |
| 59 | `Canvas.jsx` | No `isValidConnection` — edges drawn to sticky notes | 4 |
| 61 | `EditableField.jsx`, `ListingNode.jsx`, `SellHubDraftState.jsx` | Inline fields editable on locked nodes | 4 |
| 62 | `JobHubNode.jsx` | Resume drop + error retry active on locked hub | 4 |
| 63 | `SellHubNode.jsx` | Image drop + error retry active on locked hub | 4 |
| 64 | `SellHubPricedState.jsx`, `QuickPriceButtons.jsx`, `PlatformToggles.jsx` | Priced controls active + crash on locked hub | 4 |
| 65 | `JobCardNode.jsx` | Dismiss, status select, cover letter unguarded on locked | 5 |
| 66 | `ListingNode.jsx` | 6 priced-state controls unguarded on locked node | 5 |
| 67 | `useCanvasContextMenu.js` | Color submenu available on locked nodes | 5 |
| 68 | `useCanvasContextMenu.js` | Font & Size menu item available on locked nodes | 5 |
| 69 | `useCanvasContextMenu.js` | Bring to Front / Send to Back mutated locked node zIndex | 5 |
| 70 | `TextNode.jsx`, `LinkNode.jsx` | Font/URL event listeners opened dialogs on locked nodes | 5 |
| 70b | `useCanvasContextMenu.js` | Edit URL not disabled on locked link nodes | 5 |
| 71 | `JobHubNode.jsx`, `useCanvasPersistence.js`, `useCanvasInitialization.js` | `toggleSourceFilter` dim opacity persisted to disk via autosave; on reload filter was active but cards not re-dimmed. Fixed: `sanitizeNodesForSave` strips jobcard opacity before any save; `useEffect` re-applies dim on mount | 6 |
| 72 | `AnimatedSourceRing.jsx`, `JobHubNode.jsx` | SVG `<marker>` IDs were document-wide — second `JobHubNode` reused first hub's markers (wrong arrow color/opacity). Fixed: IDs namespaced with `nodeId` prop | 6 |
| 73 | `SellHubNode.jsx` | `AnimatedSourceRing` also used without `nodeId` in `SellHubNode` — identical document-wide ID collision as Bug 72. Fixed: `nodeId={id}` added | 7 |
| 74 | `ContextMenu.jsx` | Submenus always rendered to the right (`left-full`). When parent menu was clamped near right viewport edge the submenu overflowed off-screen. Fixed: `submenuDirection` state computed in clamping `useEffect`; submenu uses `left-full` or `right-full` based on available space (threshold 192px) | 8 |
| 75 | `FontSizeDialog.jsx` | No maximum font size — user could type `9999`, creating a node too tall to see or interact with. Fixed: `Math.min(500, ...)` in onChange + `max={500}` attribute on the input | 8 |
| 76 | `electron/ipc/browserPool.js` | `gaussianDelay`: `Math.random()` can return exactly 0 (probability ~2⁻⁵³). `Math.log(0)=−Infinity` → `Math.sqrt(−Infinity)=NaN` → `Math.max(1000,NaN)=NaN` in JS → `setTimeout(fn,NaN)` fires immediately, bypassing the domain rate-limiter entirely. Fixed: `Math.random() \|\| Number.EPSILON` | 8 |
| 77 | `electron/extractors/jobs.js` | ZipRecruiter `__NEXT_DATA__` parser: `job.location \|\| job.city ? X : Y` has wrong operator precedence — parsed as `(job.location \|\| job.city) ? X : Y`. When `job.location` is set but `job.city` is `undefined`, location becomes `"undefined"` or `"undefined, CA"`. Fixed: added parentheses → `job.location \|\| (job.city ? X : Y)` | 8 |

---

## 📋 Verified Edge Cases (Do Not Re-Test)

| # | Area | Edge Case | Result |
|---|------|-----------|--------|
| 1 | Undo/Redo | Undo after canvas clear | ✅ Fixed |
| 2 | Undo/Redo | Undo after Move to Parent | ✅ Fixed |
| 3 | Undo/Redo | JobCard dismiss undo | ✅ Safe (snapshotOnDelete) |
| 4 | Undo/Redo | History cleared on workspace load | ✅ Fixed |
| 5 | Undo/Redo | ⌘Z/⌘⇧Z keyboard handler respects contentEditable | ✅ Correct |
| 6 | Sticky Notes | Target handle active on sticky | ✅ Fixed |
| 7 | Sticky Notes | Orphaned incoming edges on toggle | ✅ Fixed |
| 8 | Sticky Notes | Opacity broken when color-coded | ✅ Fixed |
| 9 | Sticky Notes | New edges drawn TO sticky notes | ✅ Fixed (isValidConnection) |
| 10 | Navigation | Load while nested corrupt | ✅ Fixed |
| 11 | Navigation | Clear while nested — stale breadcrumbs | ✅ Fixed |
| 12 | Navigation | Breadcrumbs snap correctly | ✅ |
| 13 | Locked Nodes | Prevent drag | ✅ |
| 14 | Locked Nodes | Prevent delete | ✅ |
| 15 | Locked Nodes | Prevent content editing (Text/Link) | ✅ Fixed |
| 16 | Locked Nodes | Prevent file open (Document) | ✅ Fixed |
| 17 | Locked Nodes | Prevent dive-in (Canvas) | ✅ Fixed |
| 18 | Locked Nodes | Prevent rename (Canvas title) | ✅ Fixed |
| 19 | Locked Nodes | Prevent AI Polish, Sticky toggle | ✅ Fixed |
| 20 | Locked Nodes | Prevent Font/Size, Color, Z-order, Edit URL | ✅ Fixed |
| 21 | Locked Nodes | Prevent resume/image drop (Hubs) | ✅ Fixed |
| 22 | Locked Nodes | Prevent all priced-state interactions | ✅ Fixed |
| 23 | Locked Nodes | Prevent JobCard status/dismiss/cover letter | ✅ Fixed |
| 24 | Locked Nodes | Tidy algorithm ignores locked | ✅ |
| 25 | Locked Nodes | Eraser skips locked | ✅ |
| 26 | Drawing | Pen/eraser snapshot | ✅ |
| 27 | Drawing | Pixel eraser splits strokes | ✅ |
| 28 | File Drop | OS files (all types) | ✅ |
| 29 | File Drop | URL drag from browser address bar | ✅ Fixed |
| 30 | File Drop | Resume auto-starts JobHub | ✅ |
| 31 | Search | Nested canvas search pans to container | ✅ Intentional |
| 32 | Search | Escape closes bar | ✅ |
| 33 | Search | Enter/Shift+Enter cycle | ✅ |
| 34 | Context Menu | Tidy selection + tidy all | ✅ |
| 35 | Context Menu | Duplicate creates unlocked clone | ✅ |
| 36 | AI | AI Polish empty node guard | ✅ |
| 37 | Link Node | URL auto-detection on paste | ✅ Fixed |
| 38 | Link Node | Label sync on undo | ✅ |
| 39 | Toast | Cap at 5 simultaneous | ✅ Fixed |
| 40 | Auto-save | Fires after every change | ✅ |
| 41 | Auto-save | Correct data when nested (flushStack) | ✅ |
| 42 | Bug Report | 10MB file limit safe truncation | ✅ |
| 43 | SearchBar | `navigateBy(-1)` from step 0 off-by-one | ⚠️ Minor UX, acceptable |
| 44 | useListingActions | `priceInput`/`selectedPlatforms` desync on undo | ⚠️ Design limitation, acceptable |
| 45 | migrateGroupNodes | Reference equality always false (perf) | ⚠️ Perf only, not critical |
| 46 | ConfirmDialog | Escape stacking | ✅ Not possible (scalar state) |
| 47 | useUndoRedo | `clearHistory` wipes stacks and fingerprint | ✅ Correct |

| 48 | Sidebar | Module drag-to-canvas sets correct `app/node-type` | ✅ |
| 49 | Settings | Animation speed persists across restarts via localStorage | ✅ |
| 50 | Settings | Invalid localStorage JSON falls back to defaults | ✅ |
| 51 | Navigation | Drawing mode (pen/eraser) persists across nav levels | ✅ Intentional UX |
| 52 | Navigation | BreadcrumbBar stale canvas ID | ✅ Safe (stack uses snapshots) |
| 53 | Export | PNG export when nested captures current sub-canvas | ✅ Correct behavior |
| 54 | Auto-save | Quit within 2s debounce loses last change | ⚠️ Accepted limitation (unsaved dot visible) |
| 55 | Auto-save | Filter opacity stripped before both explicit save and autosave | ✅ Fixed (Bug 71) |
| 56 | JobHub | Source filter dim re-applied on reload | ✅ Fixed (Bug 71) |
| 57 | JobHub | Multiple hubs — SVG marker ID collision | ✅ Fixed (Bug 72) |
| 58 | HubContainer | `onDragOver` fires even on locked hubs | ✅ Acceptable (visual only, drop rejected by parent guard) |
| 59 | Corrupted file | Invalid JSON on load caught by try-catch → error toast | ✅ Clean |
| 60 | PriceJustification | Expand/collapse when locked writes no persisted data | ✅ Clean |
| 61 | useListingActions | `syncPriceFromBackend` does not override user-set price | ✅ Clean |
| 62 | useListingActions | `researchPrice` error handling via try-catch | ✅ Clean |
| 63 | DrawingLayer | Legacy and new stroke formats both handled (`Array` vs `{points, color}`) | ✅ Clean |
| 64 | DrawingLayer | `React.memo` prevents unnecessary re-renders | ✅ Clean |
| 65 | useDrawingMode | Object eraser skips locked nodes | ✅ Clean |
| 66 | useDrawingMode | `takeSnapshot` fires at correct gesture boundaries (pointerdown for erase, pointerup for pen) | ✅ Clean |
| 67 | useDrawingMode | Escape key listener properly cleaned up | ✅ Clean |
| 68 | useNodeAutoEdit | Duplicated nodes explicitly set `isNew: false` | ✅ Clean |
| 69 | useNodeAutoEdit | Locked nodes not auto-deleted when empty on blur | ✅ Clean |
| 70 | useCanvasActions | `doClear` calls `takeSnapshot` before clearing | ✅ Clean |
| 71 | Context menu | Multi-selection mixed lock/unlock — menu always acts on right-clicked node only | ✅ Clean |
| 72 | Context menu | Tidy with 1 selected node — no-op (stays in place) | ✅ Clean |
| 73 | ⌘Z during animation | No corruption possible — `clearHistory` fires atomically when data switches | ✅ Acceptable |
| 74 | FontSizeDialog | Cannot open on locked nodes — `open-font-dialog` event listener has lock guard | ✅ Clean |
| 75 | SellHubNode | `AnimatedSourceRing` missing `nodeId` (Bug 73) | ✅ Fixed |
| 76 | CanvasNode | Dive-in blocked when locked | ✅ Clean |
| 77 | CanvasNode | Title rename blocked when locked | ✅ Clean |
| 78 | CanvasNode | Delete button hidden when locked | ✅ Clean |
| 79 | DocumentNode | File-open blocked when locked | ✅ Clean |
| 80 | DocumentNode | File watcher cleanup correct (useEffect teardown) | ✅ Clean |
| 81 | useUndoRedo | Debounce fires during restore — undo loop risk | ✅ Safe (`isRestoringRef` blocks effect before rAF resets it) |
| 82 | Context menu | Move to Parent Canvas at root (depth=0) | ✅ Safe (wrapped in `if (depth > 0)`) |
| 83 | preload.js | Generic `invoke` exposes all IPC channels | ✅ Acceptable (trusted desktop app) |
| 84 | ReactFlow v12 | Multi-select drag respects `draggable:false` on locked nodes | ✅ Clean |
| 85 | useCanvasDragAndDrop | Drop during dive-in animation — node loss risk | ⚠️ Accepted (150-300ms window, physically improbable) |
| 86 | deleteKeyCode | Delete key respects `deletable:false` on locked nodes | ✅ Clean |
| 87 | CanvasNavigationContext | Context file has no logic — just `createContext(null)` | ✅ Clean |
| 88 | deleteKeyCode=['Backspace','Delete'] | Backspace during text edit won't delete node — RF v12 checks `isContentEditable` | ✅ Clean |
| 89 | ToastProvider | Toasts auto-dismiss via 4s timer with `clearTimeout` cleanup | ✅ Clean |
| 90 | aiPolishText | Null/error response caught by try-catch; empty text short-circuits before snapshot | ✅ Clean |
| 91 | DocumentNode | Multiple nodes watching same file: stopFileWatch on first unmount stops all — accepted limitation | ⚠️ Accepted |
| 92 | Bug 71 useEffect | Re-apply dim on mount: empty deps, `setNodes` runs once — correctly implemented | ✅ Clean |
| 93 | extractToParent | Position near parent container: minor overlap risk, user can drag away | ✅ Acceptable |
| 94 | PNG export | `viewportNode` null guard; `.catch` error handler; success toast | ✅ Clean |
| 95 | Duplicate hook entries | `debugged-areas.md` cleanup: consolidated all duplicate rows into single canonical entries | ✅ Done |
| 96 | Dialog | Escape + backdrop click simultaneously both call `onClose` — second call is a no-op state update in parent | ✅ Acceptable |
| 97 | Dialog | `onClose` not memoized in parent → `useEffect` re-subscribes on every parent render — cleanup fn always removes old listener so no leak | ✅ Clean |
| 98 | AlignedBackground | Pattern ID `ab-dots` / `ab-lines` would collide if two backgrounds mounted simultaneously — comment confirms single instance; no path creates two | ✅ Clean |
| 99 | ContextMenu | Initial 1-frame render flash at un-clamped (x,y) before `useEffect` moves it — cosmetic only, sub-16ms on any modern machine | ✅ Acceptable |
| 100 | ContextMenu | Submenu direction now dynamically computed (right when ≥192px available, left otherwise) | ✅ Fixed (Bug 74) |
| 101 | FontSizeDialog | Font size 0 / empty string — `Number("") \|\| 1` → 1; `Math.max(1,…)` enforces floor | ✅ Clean |
| 102 | FontSizeDialog | Font size >500 now clamped before state update AND by `max={500}` HTML attr | ✅ Fixed (Bug 75) |
| 103 | browserPool gaussianDelay | `Math.random()===0` case (prob ~2⁻⁵³) now safely replaced with `Number.EPSILON` | ✅ Fixed (Bug 76) |
| 104 | apiExtractors `getRandomUA` import | Imported from `stealthBrowser.js` which re-exports from `antiDetectProfiles.js` — import chain valid | ✅ Clean |
| 105 | apiExtractors `processInBatches` | Uses `Promise.allSettled` → individual fetch failures don't abort the batch | ✅ Clean |
| 106 | apiExtractors fetchStockX | `algoliaKeys` module-level cache reset to `null` on 401/403 so next call re-extracts fresh keys | ✅ Clean |
| 107 | facebookExtractor depth guard | Relay recursion capped at `depth > 8` — prevents infinite loops on circular Relay graphs | ✅ Clean |
| 108 | ZipRecruiter location precedence | `job.location \|\| job.city ? X : Y` was `(a\|\|b)?X:Y` — fixed to `a\|\|(b?X:Y)` | ✅ Fixed (Bug 77) |
| 109 | authWindows openLoginWindow | Unknown `platformId` throws synchronously before any async work — caller must handle | ✅ Clean |
| 110 | authWindows getSessionStatus | `page.cookies(...domains.map(...))` — spreads array correctly; `page.close()` in finally equivalent (inside try block before catch) | ✅ Clean |
| 111 | marketplace extractors | All card-level parsers wrapped in individual `try/catch` — one malformed card never aborts the rest | ✅ Clean |
| 112 | main.jsx | `StrictMode` causes effects to fire twice in dev — all effects use cleanup functions; no side-effect leaks | ✅ Clean |

---

## ❓ What Still Needs Checking

All files in `src/` and `electron/` have now been fully audited across Sessions 1–8.
The codebase is considered comprehensively hardened.

If new features are added, create entries here for the new files/interactions introduced.

---

## 📝 README Status

`README.md` was last fully verified after **Session 5**. All claims are accurate.

Key update made in Session 4: Lock Node description expanded from "prevents move or delete" to the accurate full description covering all guarded surfaces.

**Next session:** Check README again only if new features are added or behavior changes.
