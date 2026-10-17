import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import tailwindcss from '@tailwindcss/vite'
import { execFileSync } from 'node:child_process'

// package.json stays at 0.0.0, so stamp the main bundle with the commit it was
// built from; generation logs use it to tell builds apart.
function appBuild() {
  try {
    const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = git(['status', '--porcelain']) ? '+dirty' : ''
    return `${git(['rev-parse', '--short', 'HEAD'])}${dirty} built ${new Date().toISOString()}`
  } catch {
    return `unknown commit built ${new Date().toISOString()}`
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('@xyflow') || id.includes('lucide')) return 'vendor';
            return 'modules';
          }
        }
      }
    }
  },
  plugins: [
    tailwindcss(),
    react(),
    electron([
      {
        entry: 'electron/main.js',
        vite: {
          // The CommonJS main bundle does not have a native import.meta. Vite's
          // dynamic-import preload helper contains an optional import.meta
          // branch even though that branch is disabled for CJS output; define
          // it away in this build only so Rollup does not emit EMPTY_IMPORT_META
          // diagnostics. Renderer/preload builds keep their normal semantics.
          define: {
            'import.meta': '{}',
            __APP_BUILD__: JSON.stringify(appBuild()),
          },
          build: {
            // Main-process dependencies are intentionally bundled into a few
            // desktop-only chunks; they are not downloaded by the renderer.
            chunkSizeWarningLimit: 3000,
            // Electron v41 + Node.js v24: ESM `import electronPkg from 'electron'` gives
            // an empty object — Electron only intercepts CJS `require('electron')`.
            // vite-plugin-electron auto-sets formats: ['es'] when package.json has
            // "type":"module". Disable lib mode (lib: false) so rollupOptions.output can
            // fully control the format without array concatenation from mergeConfig.
            // The dist-electron/package.json with "type":"commonjs" makes Node/Electron
            // treat main.js as CJS so require() is valid at runtime.
            lib: false,
            rollupOptions: {
              input: { main: 'electron/main.js' },
              output: {
                format: 'cjs',
                // Use .cjs extension so Node.js always treats the bundle as
                // CommonJS, regardless of package.json "type":"module". Inside
                // Electron's ASAR archives, the nested dist-electron/package.json
                // ("type":"commonjs") isn't reliably found by Node.js 24's ESM
                // loader — it falls back to the root package.json ("type":"module")
                // and refuses to run require(). .cjs bypasses that entirely.
                entryFileNames: '[name].cjs',
                chunkFileNames: '[name].cjs',
                // Keep heavyweight, independently-used IPC surfaces out of
                // the startup entry. CJS chunks are loaded with relative
                // require() calls by Rollup, and electron-builder ships every
                // file in dist-electron, so this preserves the runtime
                // contract while making the entry auditable.
                manualChunks(id) {
                  const normalized = id.replaceAll('\\', '/');
                  if (normalized.endsWith('/electron/ipc/jobs.js')) return 'jobs';
                  if (normalized.endsWith('/electron/ipc/localAiApplication.js')) return 'local-application';
                  if (normalized.endsWith('/electron/ipc/bugReport/jobsSnapshot.js')) return 'bug-report-jobs';
                  if (normalized.endsWith('/electron/ipc/browser/manualScraper.js')) return 'manual-scraper';
                  return undefined;
                },
              },
              external: [
                'puppeteer-core',
                'puppeteer-extra',
                'puppeteer-extra-plugin-stealth',
                // jsdom uses __dirname-relative readFileSync for browser/default-stylesheet.css;
                // bundling it corrupts that path to dist-electron/ instead of node_modules/jsdom/.
                'jsdom',
                // pdf-lib's tslib helpers break under CJS bundling ("Cannot
                // destructure '__extends'" at main.cjs load) — resolve it from
                // node_modules at runtime like the other externals.
                'pdf-lib',
              ],
            }
          },
        }
      },
      {
        entry: 'electron/preload.js',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            rollupOptions: {
              output: {
                format: 'cjs',
              },
            },
          },
        },
      },
      // Interview child gets a deliberately separate, narrow bridge. It must
      // never inherit the canvas preload's filesystem/job capabilities.
      {
        entry: 'electron/interviewWindowPreload.js',
        vite: {
          build: {
            rollupOptions: {
              output: {
                format: 'cjs',
              },
            },
          },
        },
      },
    ]),
  ],
})
