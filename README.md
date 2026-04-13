# Infinite Canvas

A powerful desktop application built with Electron, React, and Vite. It provides an organically recursive hierarchical canvas space for mapping ideas, monitoring online data streams, and organizing desktop assets directly onto infinite boards.

## Implemented Features

- **Infinite Nested Canvases**
  - Create completely isolated, fully functional Canvas instances recursively nested inside of one another.
  - Collapse group nodes into clean minimal icons featuring dynamic item-count badges.
  - Drag items visually onto Group Nodes, where custom spatial boundary math automatically calculates intersections and swallows elements directly into their nested scope coordinate system.

- **Desktop Drag-and-Drop Ingestion (Filesystem scanning)**
  - Fully mapped Electron bindings scan dragged-and-dropped system directories, generating matching `GroupNode` structures on the fly.
  - Direct desktop files are mapped seamlessly onto the viewport as `DocumentNodes`.

- **Freehand Geometric Drawing Tools**
  - Native SVG path stroke rendering dynamically registers mouse layouts and interpolates paths into physical `drawings` data attached seamlessly to main and nested canvas objects.

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

---

## TBD (To Be Developed) Features

- **Rich Text Markdown Binding (TBD)**
  - Updating simple `TextNodes` into formatted Markdown processors. 
- **Active Directory Watching (TBD)**
  - Expanding the `DocumentNode` implementations with macOS system watch triggers so canvas files automatically identify if they were modified outside of the app.
- **Export to Image / PNG Flattening (TBD)**
  - Consolidating geometric shapes, recursive nestings, and paths to create flat screenshots directly out of the interface.
- **Dependency Pipeline Trimming (TBD)**
  - Removing non-utilized `electron-builder` native hooks (`@emnapi`, `fsevents`) surfacing during full-pack builds.
