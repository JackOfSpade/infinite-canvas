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

---

## TBD (To Be Developed) Features

- **Live Marketplace API Subscriptions (TBD)** 
  - The UI (e.g. `ListingNode.jsx` and `useMarketplaceListings.js`) currently simulates status polling. A physical Node.js backend needs to be connected to the `monitoring.js` IPC bridge to scrape eBay, Amazon, and Craigslist APIs properly.
- **Rich Text Markdown Binding (TBD)**
  - Updating simple `TextNodes` into formatted Markdown processors. 
- **Active Directory Watching (TBD)**
  - Expanding the `DocumentNode` implementations with macOS system watch triggers so canvas files automatically identify if they were modified outside of the app.
- **Export to Image / PNG Flattening (TBD)**
  - Consolidating geometric shapes, recursive nestings, and paths to create flat screenshots directly out of the interface.
- **Dependency Pipeline Trimming (TBD)**
  - Removing non-utilized `electron-builder` native hooks (`@emnapi`, `fsevents`) surfacing during full-pack builds.
