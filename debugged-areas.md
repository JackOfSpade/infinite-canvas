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
|------|--------|-------|
| `src/hooks/useUndoRedo.js` | ✅ Clean | `clearHistory` correct, stacks wipe cleanly |
| `src/hooks/useCanvasPersistence.js` | ✅ Fixed (Bugs 36, 55, 56) | `resetStack` & `clearHistory` now called on load |
| `src/hooks/useCanvasNavigation.js` | ✅ Fixed | `clearHistory` called on level transitions |
| `src/hooks/useCanvasContextMenu.js` | ✅ Fixed (Bugs 52, 53, 67–70b) | All locked-node menu items disabled; guards in `setNodeColor`, `aiPolishText`, `toggleStickyNote` |
| `src/hooks/useCanvasActions.js` | ✅ Fixed (Bug 38) | `doClear` now calls `resetStack` |
| `src/hooks/useCanvasDragAndDrop.js` | ✅ Clean | URL drag from browser bar handled (Bug 29) |
| `src/hooks/useDrawingMode.js` | ✅ Clean | Eraser correctly skips locked nodes |
| `src/hooks/useCustomFitView.js` | ✅ Clean | No edge cases |
| `src/hooks/useNodeAutoEdit.js` | ✅ Clean | `isNew` flag cleared correctly |
| `src/hooks/useCanvasInitialization.js` | ✅ Clean | No issues |

### Node Components
| File | Status | Notes |
|------|--------|-------|
| `src/nodes/TextNode.jsx` | ✅ Fixed (Bugs 39, 70) | Double-click guard + font dialog event listener locked |
| `src/nodes/LinkNode.jsx` | ✅ Fixed (Bugs 39, 70) | Double-click guard + font/URL dialog listeners locked |
| `src/nodes/DocumentNode.jsx` | ✅ Fixed (Bug 44) | Double-click to open file blocked when locked |
| `src/nodes/CanvasNode.jsx` | ✅ Fixed (Bugs 40, 31, 32) | Dive-in blocked; title rename blocked; hint hidden when locked |
| `src/nodes/JobCardNode.jsx` | ✅ Fixed (Bug 65) | Dismiss button hidden, status select disabled, cover letter button disabled when locked |
| `src/nodes/JobHubNode.jsx` | ✅ Fixed (Bug 62) | Resume drop + error retry blocked when locked |
| `src/nodes/SellHubNode.jsx` | ✅ Fixed (Bug 63) | Image drop + error retry blocked when locked |
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
| `src/components/DrawingLayer.jsx` | ✅ Clean | SVG polyline rendering — no issues |
| `src/components/StatusBar.jsx` | ✅ Clean | Counts and display only |
| `src/components/SearchBar.jsx` | ✅ Clean | Enter/Shift+Enter cycle correct; nested canvas pans to container (intentional) |
| `src/components/BreadcrumbBar.jsx` | ✅ Clean | Jump nav correct |
| `src/components/ConfirmDialog.jsx` | ✅ Clean | Escape fires onCancel; scalar state prevents stacking |
| `src/components/OnboardingOverlay.jsx` | ✅ Fixed (Bug 35) | Skip button positioning fixed (relative parent added) |

### Canvas Core
| File | Status | Notes |
|------|--------|-------|
| `src/Canvas.jsx` | ✅ Fixed (Bugs 32, 38, 59) | `isValidConnection` guards sticky notes; `clearHistory` wired; `resetStack` on load |

### Utilities
| File | Status | Notes |
|------|--------|-------|
| `src/utils/dragUtils.js` | ✅ Clean | `file.path` requires Electron ≥v12 (supported) |
| `src/utils/EventLogger.js` | ✅ Clean | No issues |
| `src/utils/nodeFactory.js` | ✅ Clean | No issues |
| `src/utils/constants.js` | ✅ Clean | No issues |

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

---

## ❓ What Still Needs Checking

The following areas have **not yet been fully audited**. Focus here in future sessions:

### Sidebar & UI Panels
- [ ] `src/components/Sidebar.jsx` — drag-to-canvas module spawning, any state issues
- [ ] `src/components/CanvasToolbar.jsx` — toolbar button states, drawing mode toggle behavior
- [ ] `src/components/CanvasThumbnail.jsx` — thumbnail rendering correctness
- [ ] `src/components/SettingsPanel.jsx` — settings persistence, animation speed edge cases
- [ ] `src/components/KeyboardShortcutsPanel.jsx` — shortcuts panel display correctness
- [ ] `src/components/IssueReporterDialog.jsx` — report generation edge cases
- [ ] `src/components/PriceJustification.jsx` — expand/collapse behavior when locked
- [ ] `src/components/HubContainer.jsx` — container sizing/overflow on edge state transitions
- [ ] `src/components/AnimatedSourceRing.jsx` — animation edge cases

### Specific Interaction Edge Cases Not Yet Verified
- [ ] Drawing mode behavior while **inside a nested canvas** — does it persist on navigate out?
- [ ] **Snap-to-grid** toggle — does grid snapping interact with locked node dragging?
- [ ] **MiniMap** — does it render correctly in nested canvas views?
- [ ] `BreadcrumbBar` — what happens if the target canvas ID no longer exists (corrupted save)?
- [ ] **Export to PNG** — does it capture the correct view when nested?
- [ ] **Auto-save timing** — what if user quits app within the 2-second debounce window?
- [ ] `useCanvasContextMenu` — Pane context menu "Tidy Canvas" when all nodes are locked
- [ ] FontSizeDialog — snapshot timing (currently relies on auto-debounce — sufficient?)
- [ ] `JobHubDoneState` — source filter toggle behavior (dims/undims other nodes)

---

## 📝 README Status

`README.md` was last fully verified after **Session 5**. All claims are accurate.

Key update made in Session 4: Lock Node description expanded from "prevents move or delete" to the accurate full description covering all guarded surfaces.

**Next session:** Check README again only if new features are added or behavior changes.
