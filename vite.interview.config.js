// Build of the standalone Interview Helper app.
//
// It writes only to dist-interview/ and dist-electron-interview/, never to the
// Infinite Canvas output folders, so either app can be rebuilt while the other
// is open. Its renderer entry (interview.html) does not import the canvas.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { MAIN_PROCESS_EXTERNALS } from './vite.main-externals.js'

const ELECTRON_OUT_DIR = 'dist-electron-interview'
const cjsEntry = (entry, extra = {}) => ({
  entry,
  vite: {
    build: {
      outDir: ELECTRON_OUT_DIR,
      rollupOptions: { ...extra, output: { format: 'cjs' } },
    },
  },
})

// Records which project files this build actually read. The launcher rebuilds
// Interview Helper only when one of them changes, not on every canvas edit.
function buildInputsManifest() {
  const root = process.cwd()
  const seen = new Set()
  const manifestPath = path.join(root, ELECTRON_OUT_DIR, 'build-inputs.json')
  const collect = function () {
    for (const id of this.getModuleIds()) {
      const file = id.split('?')[0]
      if (!path.isAbsolute(file) || file.includes(`${path.sep}node_modules${path.sep}`)) continue
      const relative = path.relative(root, file)
      if (!relative.startsWith('..') && fs.existsSync(file)) seen.add(relative.split(path.sep).join('/'))
    }
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, `${JSON.stringify([...seen].sort(), null, 1)}\n`)
  }
  return { name: 'interview-build-inputs', buildEnd: collect }
}
const inputs = buildInputsManifest()
const withInputs = entry => ({ ...entry, vite: { ...entry.vite, plugins: [inputs] } })

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist-interview',
    chunkSizeWarningLimit: 1000,
    rollupOptions: { input: 'interview.html' },
  },
  plugins: [
    tailwindcss(),
    react(),
    inputs,
    electron([
      withInputs({
        entry: 'electron/interviewApp/main.js',
        // `npm run dev:interview` starts this app's main file, not package.json's.
        onstart(options) { options.startup([`${ELECTRON_OUT_DIR}/main.cjs`, '--no-sandbox']) },
        vite: {
          // Same reasons as the Infinite Canvas main bundle (see vite.config.js):
          // CommonJS output with a .cjs name, and no import.meta in a CJS bundle.
          define: { 'import.meta': '{}' },
          build: {
            outDir: ELECTRON_OUT_DIR,
            chunkSizeWarningLimit: 6000,
            lib: false,
            rollupOptions: {
              input: { main: 'electron/interviewApp/main.js' },
              output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name].cjs' },
              external: MAIN_PROCESS_EXTERNALS,
            },
          },
        },
      }),
      withInputs(cjsEntry('electron/interviewApp/interviewAppPreload.js')),
      withInputs(cjsEntry('electron/interviewWindowPreload.js')),
      withInputs(cjsEntry('electron/practiceCallPreload.js')),
      // Practice-call model worker thread: its own entry so the worker never loads main.cjs.
      withInputs(cjsEntry('electron/practiceCall/models/inferenceWorkerThread.js', { external: ['onnxruntime-node'] })),
    ]),
  ],
})
