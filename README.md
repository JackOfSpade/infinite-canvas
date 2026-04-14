# Infinite Canvas — AI Workspace

Welcome to your new spatial workspace! Infinite Canvas is a powerful, freeform digital whiteboard designed to help you organize your projects, visualize your ideas, and supercharge your workflows using built-in AI modules. 

Instead of traditional folders and rigid documents, Infinite Canvas gives you unlimited space to lay out text, web links, files from your computer, and even specialized apps—all on the same board.

---

## 🚀 Getting Started

Currently, Infinite Canvas is distributed as source code for early access. Here is how to run it on your Mac:

### 1. Requirements
- Node.js 18+ installed on your system.
- macOS (as the app is optimized for desktop interactions).

### 2. Installation
Open your terminal and run:
```bash
git clone <repository-url>
cd infinite-canvas
npm install
```

### 3. Connect the AI
Infinite Canvas uses Vertex AI to power its advanced modules and visual polishing features. Place your Google Cloud Service Account credentials file in the project root folder:
- Save the file specifically as `service-account.json` in the root of the project.
- Ensure your Google Cloud Project has the Vertex AI API enabled.

### 4. Launch the App
```bash
npm run dev
```
The application window will open automatically, presenting you with a fresh, empty canvas!

---

## 🧠 Core Concepts

### Nodes
Everything you place on your canvas is a "Node". You can drag them around, arrange them however you like, and connect them together to map out relationships.

| Type | How to use it |
|------|-------------|
| **Text** | Double-click anywhere on the empty canvas to create a text note. It supports full Markdown for easy formatting. |
| **Link** | Click the 🔗 button in the bottom toolbar to drop a web bookmark. Click the bookmark to open it in your browser! |
| **Document** | Need to reference a file? Just drag any file or folder from Finder and drop it straight onto your canvas. |
| **Nested Canvas** | Click the ☐ button to create a folder-like node. Drop other nodes *inside* this node to keep your main canvas clean. |

### Interacting with Nodes
Once a node is on your canvas, here is how you interact with it:
- **Text Nodes**: Double-click the text to edit it.
- **Link Nodes**: Single-click the node to open the web page. Double-click the node to edit its display label. Right-click the node and select "Edit URL" to change the link.
- **Documents**: Double-click a file node to native-open it in its default app on your computer!
- **Nested Canvas**: Double-click a nested canvas card to dive into its full-screen view. Use the top breadcrumbs to return upward.
- **Arranging**: Organize nodes neatly inside nested canvases, or Right-click any node to control its Z-order (Send to Back / Bring to Front) or to duplicate it.

### Connecting Your Ideas
Want to show how two things are related? Hover over any node to reveal small dots on its edges. **Click and drag** from one dot to another node to draw an animated connection line between them.

### Making it Pop (Sticky Notes)
Tired of plain text notes? Right-click any Text Node and select **Make Sticky Note**. It will instantly transform into a beautiful, skeuomorphic post-it style note with a hand-written font, slightly rotated and shadowed to look like it's resting on your canvas. Perfect for brainstorming!

### AI Polish
Your spatial workspace is powered by an AI assistant! Right-click any text node (or Sticky Note) and select **✨ AI Polish Text**. The AI will instantly rewrite your text to make it clear, concise, and professional, maintaining markdown formatting. Make sure you're running the app within the desktop Electron window (not a normal browser) so the AI can securely use your service account credentials!

---

## 🛠️ Essential Tools

### ✏️ Drawing Mode
Click the **Pen Icon** on the bottom toolbar to start drawing freehand! 
- **Right-click** the Pen icon to choose your preferred color from the palette, or enter a custom hex code.
- Draw diagrams, underline text, or scribble notes.
- Click the Pen icon again to return to normal interaction mode.

### 🧹 Eraser
Click the **Eraser Icon** (next to the Pen) to erase drawings.
- **Right-click** the Eraser icon to choose between **Erase by Object** (removes entire strokes) or **Erase by Pixels** (freehand erasing).
- Use **Clear All Drawings** from the eraser menu to wipe all drawings at once.

### 🔍 Powerful Search
Press **⌘F** to open the search bar at the top of the canvas. Type any word to instantly jump to matching Text Nodes and Documents on your board. Press `Enter` to cycle through the matches!

### ⏳ Time Travel (Undo/Redo)
Made a mistake? Your canvas remembers every action you take.
- Press **⌘Z** to Undo.
- Press **⌘⇧Z** (or **⌘Y**) to Redo.
- Notice the undo/redo buttons in your bottom toolbar update dynamically as you work!

### 💾 Saving Your Work
- **Save (⌘S)**: Clicking the floppy disk icon will prompt you to save your canvas as a file on your computer. 
- **Auto-save**: Once you have saved your canvas once, the app will automatically save your progress 2 seconds after every change. Pay attention to the amber dot on the save icon—it indicates unsaved changes!
- **Open (⌘O)**: Load a previously saved canvas.
- **Export to PNG**: Click the download icon (📥) to take a high-res screenshot of your current canvas view.

---

## 🤖 The AI Sidebar Modules

The left sidebar gives you access to powerful AI-driven tasks that run right on your canvas. Click the sidebar to open it, and **drag a module onto your canvas** to get started.

### 1. Job Search Hub
Looking for a new role? Drag the Job module onto your canvas. 
- **Drop your Resume (PDF/DOCX)** directly onto the Hub.
- The AI will read your experience, generate creative career directions, and search across 12 different platforms (including Google, Indeed, and LinkedIn) on your behalf.
- The Hub will generate **Categorized Folders (Nested Canvases)** arranged beautifully around it. Double-click any category folder to dive into a sub-canvas containing all your matching **Job Card Nodes**.

### 2. Marketplace Sell Hub
Drag the Sell module to your canvas and drop product photos onto it. The AI will analyze the images, generate detailed product descriptions, and suggest the best marketplace platforms (like eBay or Marketplace) and optimal pricing out of the box.

---

## ✨ Pro Actions & Polish

- **Animated Flow Lines**: Drawing connections between nodes uses sleek, animated bezier curves to visualize your workflow paths.
- **Node Selections**: Selected nodes illuminate with a soft blue glassmorphic glow, keeping your active context clear.
- **Color Coding**: Right-click any node (Text, Link, Nested Canvas, or Document) and select **Color** to apply a beautiful translucent background. Use colors to categorize your thoughts and create visually striking diagrams!
- **Lock Nodes**: Accidental drags getting in the way? Right-click a node and select **Lock Node**. This displays a padlock icon and prevents it from being moved or deleted until unlocked. Perfect for setting up permanent structural frames or headers.
- **Tidy Up Nodes**: Messy canvas? Select multiple nodes (Shift+Drag), right-click, and hit **Tidy Selection** (or **Tidy Canvas**) to beautifully snap them into organized algorithmic grids.
- **Background Scenery**: Tired of the default dots? Click the Grid Pattern icon in the bottom toolbar to cycle between transparent Dots, Lines, Crosses, or a completely Clean backdrop.
- **MiniMap**: Toggle the MiniMap from the toolbar to get a bird's-eye overview of your entire canvas in the bottom-right corner.
- **Snap to Grid**: Toggle the Magnet icon in the toolbar to snap nodes to a grid for pixel-perfect alignment.
- **Clear Canvas**: Use the red Trash icon in the toolbar to reset your entire canvas.
- **Smart Link Fetching**: Creating a Link node or adding a URL no longer leaves you with an ugly web address. The app automatically fetches the real `<title>` metadata of the target site to label the bookmark elegantly.
- **Sticky Note Toggle**: Transform any Text Node into a vibrant, realistic Sticky Note with a single right-click to add character to your boards.
- **AI Text Polisher**: Select `✨ AI Polish Text` from the context menu of any text node to have the Gemini Assistant effortlessly rewrite and elevate your thoughts into clear, structured markdown.

---

## 🧭 First-Time Workflow Guide

If you're booting up Infinite Canvas for the first time, try this workflow to get the hang of your new spatial workspace:

1. **Brainstorming:** Double click anywhere on the blank canvas to spawn a bare **Text Node**. Jot down some project ideas. Spawn a few more text notes. Use the **Color** context menu option to color-code related ideas (e.g., green for backend, blue for frontend). Right-click and choose **Make Sticky Note** to give your brainstorm some character!
2. **Structuring:** To make a permanent "frame" for your ideas, create a Text Node, color it, enlarge its font, and position it as a header. Right-click and choose **Lock Node** so you don't accidentally move it.
3. **Deep Diving:** Click the ☐ button in the toolbar to create a "Sub-Canvas" (Nested Canvas). Double-click the nested canvas to enter it! You're now on a brand new infinite board where you can gather references without cluttering your main layout. Look at the breadcrumbs at the top of the window to navigate back out.
4. **Connecting the Dots:** Drag from the visual handles (the small dots on the edges of nodes) to draw connecting paths between your thoughts.
5. **AI Magic:** Drag the "Job Search Hub" or "Marketplace Sell Hub" from the left sidebar directly to the canvas. Drop a PDF resume or product images onto them, and watch the AI seamlessly build out connected node networks containing job listings or product prices based on your personal data.
6. **Refining Ideas:** If you wrote some messy thoughts on a node, right-click it and hit **✨ AI Polish Text** and watch your rough notes turn into a beautifully formatted summary!

---

## ⌨️ Quick Keyboard Shortcuts

To see this list inside the app at any time, just press **`?`** on your keyboard!

| Action | Shortcut / Mouse |
|--------|------------------|
| **Add text note** | Double-click canvas |
| **Pan around** | Drag canvas (or scroll) |
| **Zoom in/out** | Scroll wheel |
| **Select multiple** | Shift + Click & Drag |
| **Delete item** | Select → Press `Delete` or `⌫` |
| **Context menu** | Right-click any node or the canvas |
| **Search** | `⌘F` |
| **Next match** | `Enter` (in search bar) |
| **Prev match** | `Shift+Enter` (in search bar) |
| **Save** | `⌘S` |
| **Open** | `⌘O` |
| **Undo** | `⌘Z` |
| **Redo** | `⌘⇧Z` or `⌘Y` |

---

## 🐛 Bug Reporting

Notice something off? Click the **bug icon** in the bottom-left status bar to open the issue reporter. Type a brief description of the problem and click **Generate Report**. The app will automatically bundle a comprehensive debugging snapshot — including your canvas state, event log, app metadata, and reproduction steps — into a single file you can share for troubleshooting.

---

*Enjoy building out your Infinite Canvas! Feel free to drag in menus, structure your systems, and design the ultimate visual workspace.*
