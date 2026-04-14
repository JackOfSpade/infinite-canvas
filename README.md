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
Infinite Canvas uses AI to power its advanced modules. Create a `.env` file in the project root folder and securely add your API key:
```env
GEMINI_API_KEY=your_gemini_api_key_here
```

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
- **Arranging**: Group nodes together inside nested canvases, or Right-click any node to control its Z-order (Send to Back / Bring to Front) or duplicate it.

### Connecting Your Ideas
Want to show how two things are related? Hover over any node to reveal small dots on its edges. **Click and drag** from one dot to another node to draw an animated connection line between them.

---

## 🛠️ Essential Tools

### ✏️ Drawing Mode
Click the **Pen Icon** on the bottom toolbar to start drawing freehand! 
- Choose your preferred color from the palette that appears.
- Draw diagrams, underline text, or scribble notes.
- Click the Pen icon again to return to normal interaction mode.

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
- The Hub will generate matching **Job Card Nodes** arranged beautifully around it, categorized by career paths you might not have considered!

### 2. Marketplace Sell Hub (Coming Soon)
Drag the Sell module to your canvas and drop product photos onto it. The AI will analyze the images, generate detailed product descriptions, and suggest the best marketplace platforms (like eBay or Marketplace) and optimal pricing out of the box.

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
| **ContextMenu** | Right-click any node or the canvas |
| **Search** | `⌘F` |
| **Save** | `⌘S` |
| **Open** | `⌘O` |

---

*Enjoy building out your Infinite Canvas! Feel free to drag in menus, structure your systems, and design the ultimate visual workspace.*
