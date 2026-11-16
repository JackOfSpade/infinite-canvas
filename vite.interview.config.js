// Build of the standalone Interview Helper app.
//
// It writes only to dist-interview/ and dist-electron-interview/, never to the
// Infinite Canvas output folders, so either app can be rebuilt while the other
// is open. Its renderer entry (interview.html) does not import the canvas.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import tailwindcss from '@tailwindcss/vite'
import { MAIN_PROCESS_EXTERNALS } from './vite.main-externals.js'
import { buildInputsManifest } from './vite.build-inputs.js'

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
const inputs = buildInputsManifest(`${ELECTRON_OUT_DIR}/build-inputs.json`, 'interview-build-inputs')
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
