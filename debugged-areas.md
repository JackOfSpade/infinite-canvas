# Debugged Areas - Hub Pipelines & Workflow

This document tracks functional defects, verification results, and performance improvements within the **Job Search** and **Marketplace Sell** module pipelines.

## 1. Sidebar & Canvas Interaction (Core Workflow)

### [FIXED] Hub Node Drag-Drop Failure
- **Issue**: Dragging "Job Search Module" or "Marketplace Module" from the sidebar created a generic Text Node containing the word "drag" instead of the specialized Hub Node.
- **Root Cause**: The browser was auto-populating the `text/plain` MIME type with the draggable element's text content (e.g., from tooltips or grip icons). The canvas drop handler prioritizes file/node types but fell through to the text handler when `app/node-type` wasn't exclusively recognized.
- **Solution**: 
  - Updated `Sidebar.jsx` to explicitly set `text/plain` to an empty string during drag start.
  - Added a defensive guard in `useCanvasDragAndDrop.js` to ignore payloads with `trim().length <= 3`, preventing spurious node creation from UI labels.
- **Verification**: Confirmed via live browser test that dragging either module card now correctly spawns the respective Hub Node with animated rings.

### [FIXED] Canvas Auto-Routing (Document/Image Drops)
- **Issue**: Dropped files were not consistently routing to the specialized hubs defined in the README.
- **Solution**: 
  - Refined `RESUME_EXT_RE` to strictly cover document formats (`.pdf`, `.docx`, `.doc`, `.txt`).
  - Added `IMAGE_EXT_RE` to capture product photos.
  - Updated `useCanvasDragAndDrop.js` to implement specialized auto-routing:
    - **Doc-only drop** -> Auto-creates `JobHub` (Job Search).
    - **Image-only drop** -> Auto-creates `SellHub` (Marketplace) seeded with all dropped images.
    - **Mixed/Other** -> Defaults to standard `DocumentNode` / `CanvasNode` creation.
- **Verification**: Validated that dropping a folder of images now correctly initializes a Marketplace hub.

---

## 2. Marketplace Sell Module (SellHub)

### [FIXED] State Corruption in Pricing Research
- **Issue**: The `SellHubNode` would crash or fail to render the "Price Justification" section if no comparable listings (comps) were found.
- **Root Cause**: The data contract for `comps` was inconsistently initialized as an empty array `[]` instead of the expected object shape `{ sold: [], active: [] }`.
- **Solution**:
  - Applied consistent fallbacks in `SellHubNode.jsx` and `ListingNode.jsx` to ensure `comps` always defaults to `{ sold: [], active: [] }`.
  - Fixed the `priced-empty` state path in `ListingNode.jsx` which was omitting the `comps` field entirely.
- **Verification**: Verified that the UI gracefully displays "No comparable listings found" instead of failing to render.

### [FIXED] Invalid Platform Defaults
- **Issue**: The listing action hook defaulted to `craigslist`, which was not a supported ID in the `SELL_PLATFORMS` registry, leading to broken UI toggles.
- **Solution**: Updated `useListingActions.js` to use `mercari` as a valid default alongside `ebay` and `facebook`.

---

## 3. Job Search Module (JobHub)

### [FIXED] Orphaned Node Cleanup
- **Issue**: Re-running a Job Search would leave old `JobCard` nodes on the canvas, leading to cluttered duplicates.
- **Solution**: Implemented explicit cleanup in `JobHubNode.jsx`. Before a re-run starts, it identifies all child nodes connected to the hub and deletes them from the canvas.
- **Verification**: Confirmed that clicking "Re-run Search" now clears the previous result cards before spawning new ones.

---

## 4. Performance & Core Interaction (Canvas UX)

### [FIXED] WASD/Arrow Navigation
- **Issue**: Navigation felt sluggish when zoomed out and opposite keys (W+S) did not cancel each other out.
- **Solution**:
  - Implemented **Zoom Compensation**: Speed now scales with zoom level (`speed = base / zoom`).
  - Implemented **Directional Cancellation**: Opposite vectors now correctly result in zero movement.
- **Verification**: Navigation is now snappy and predictable at all zoom levels.

### [FIXED] Pen Drawing Discarded during Animation
- **Issue**: Finished pen strokes were being discarded if any canvas animation (like a background zoom) was active when the pointer was released.
- **Solution**: Removed the animation guard from the `pointerup` handler in `useDrawingMode.js`. Committing a finished stroke is now always allowed.

### [FIXED] Undo/Redo Reliability (Drag & Field Sync)
- **Issue**: Undoing a node move or a price field edit would sometimes fail to update the UI or leave the history stack in an inconsistent state.
- **Solution**:
  - Added explicit `takeSnapshot()` calls at both the start and end of node drags in `useDragCorrections.js`.
  - Added `useEffect` listeners to `useListingActions.js` to synchronize local UI states with underlying node data updates (critical for undo/redo).

### [FIXED] Atomic Write Symlink Preservation
- **Issue**: Saving a workspace over a symlink (e.g. `canvas.json -> versions/v1.json`) would overwrite the symlink with a regular file.
- **Solution**: Updated `atomicWriteFile` in `filesystem.js` to resolve the real target path before writing, ensuring the target is updated while the symlink is preserved.

---

## 5. Production Hardening (Final Audit)

### [FIXED] Full Linting Compliance
- **Issue**: Lingering `exhaustive-deps` and `no-unused-vars` violations across multiple hooks and nodes.
- **Solution**:
  - Corrected dependency arrays in `JobHubNode.jsx`, `SellHubNode.jsx`, `useCanvasActions.js`, `useDragCorrections.js`, and `useDrawingMode.js`.
  - Hoisted `toggleSourceFilter` in `JobHubNode.jsx` to remove `eslint-disable-next-line`.
  - Resolved `no-unused-vars` in `gemini.js` IPC.
- **Verification**: `npm run lint` now passes with 0 errors/warnings.

### [VERIFIED] Asynchronous Pipeline Stability
- **Issue**: Risk of memory leaks or state updates on unmounted components during long-running IPC tasks (Pricing Research, Job Scoring).
- **Solution**:
  - Validated that all asynchronous handlers in `JobHubNode.jsx`, `SellHubNode.jsx`, and `useListingActions.js` are strictly guarded by `isMountedRef.current`.
  - Confirmed `AbortController` integration in `ipcUtils.js` via `handleSafe`, ensuring background tasks are cancelled immediately when a node is deleted.
  - Verified recursive cancellation of nested node tasks in `cancelNodeTasksRecursively`.

### [FIXED] Listing Title Filtering
- **Issue**: 2-character technical terms (e.g., "AI", "Go", "C#") were being filtered out of marketplace research results.
- **Solution**: Updated `marketplace.js` extractors to lower the title length threshold from 3 to 2 characters.

### [FIXED] State-in-Effect Anti-Patterns
- **Issue**: Syncing props to state via `useEffect` was causing cascading re-renders in `useListingActions.js`.
- **Solution**: Refactored to a **render-phase synchronization** model, comparing props to previous values in the component body to ensure instant UI updates without secondary render cycles.

---

**Status**: ✅ All target defects resolved. Codebase is fully linted, memory-safe, and production-ready.
**Last Verified**: 2026-05-06
