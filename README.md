# Infinite Canvas

A powerful desktop application built with Electron, React, and Vite. It provides an organically recursive hierarchical canvas space for mapping ideas, monitoring online data streams, and organizing desktop assets directly onto infinite boards.

## Implemented Features

- **Infinite Nested Canvases**
  - Create completely isolated, fully functional Canvas instances recursively nested inside of one another.
  - Collapse group nodes into clean minimal icons featuring dynamic item-count badges.
  - Drag items visually onto Group Nodes, where custom spatial boundary math automatically calculates intersections and swallows elements directly into their nested scope coordinate system.

- **Canvas Navigation & Alignment**
  - Interactive Dark-Mode Minimap provides a global bird's-eye view, keeping you oriented even across thousands of coordinates.
  - Toggle-able **Snap-To-Grid** magnet tool guarantees pixel-perfect layout and geometric precision across massive boards.
  - **Frictionless Insertion**: Double-click anywhere on the empty canvas to instantly materialize an active Text Node, skipping toolbar interactions altogether.

- **Desktop Drag-and-Drop Ingestion (Filesystem scanning)**
  - Fully mapped Electron bindings scan dragged-and-dropped system directories, generating matching `GroupNode` structures on the fly.
  - Direct desktop files are mapped seamlessly onto the viewport as `DocumentNodes`.

- **Freehand Geometric Drawing Tools & Color Palette**
  - Native SVG path stroke rendering dynamically registers mouse layouts and interpolates paths into physical `drawings` data attached seamlessly to main and nested canvas objects.
  - Interactive toolbar palette allows hot-swapping between distinct drawing colors (white, red, blue, green, amber), saving isolated stroke formats uniquely per layer.

- **Context Ecosystem & Toolbars**
  - Smart right-click context menus (`ContextMenu.jsx`) utilizing boundary detection to prevent screen clipping.
  - Dedicated popups for fine-tuning text node formatting (`FontSizeDialog.jsx`).
  - Active platform monitoring tools accessible from a hideable Sidebar UI.

- **Robust State Persistence (Undo/Redo Engine)**
  - A robust history stack evaluates and logs delta differences across physical coordinate shifts, text rewrites, generated links, and custom nested dimensions.
  - Shortcuts support (`Ctrl+Z`, `Ctrl+Y`, `Backspace`).
  - Advanced screen panning via Custom Fit View constraints.

- **Persistent Native Saves**
  - Leverages secure IPC handshakes to invoke native OS Save/Open windows, serializing whole infinitely nested states as local `.canvas` files.

- **Gemini AI Marketplace Monitoring (On-Demand)**
  - Create listing nodes for eBay, Amazon, Craigslist, or custom platforms from the Sidebar.
  - Right-click → "Check Listing" triggers a live **Gemini 2.5 Flash** analysis of the page HTML via **Google Cloud Vertex AI**.
  - Gemini extracts actionable signals: price info, stock status, bid activity, seller info, buyer interest, shipping details, warnings, and more.
  - Signals are displayed as a numbered badge on the node. Click the badge to view the full signal breakdown with severity indicators (info / warning / alert).
  - No data is stored — every check is a fresh, live interpretation. No background polling.
  - **Auth**: Uses a local `service-account.json` (GCP Service Account with Vertex AI User role) for secure OAuth 2.0 token minting. Bills through GCP promotional credits.

- **Rich Text Markdown Binding**
  - Updated simple `TextNodes` into formatted Markdown processors via `marked` + `DOMPurify`.
- **Active Directory Watching**
  - Bound `DocumentNode` implementations with macOS system watch triggers (`fs.watch`) so canvas files visually identify if they were modified manually outside of the app.
- **Export to Image / PNG Flattening**
  - Added native `html-to-image` integration permitting users to instantly download high-res snapshots directly onto their disk matrices.
- **Dependency Pipeline Trimming**
  - Refactored `package.json` arrays, clearing unused `electron-builder` `.node` footprints resulting in a blazing-fast, silent deployment structure.

---

## 100% Feature Complete
The Infinite Canvas desktop architecture is fully built, tested, and shipped. No further "TBD" components remain in the pipeline.
