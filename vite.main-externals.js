// Packages the main-process bundle leaves to node_modules at runtime.
export const MAIN_PROCESS_EXTERNALS = [
  'puppeteer-core',
  'puppeteer-extra',
  'puppeteer-extra-plugin-stealth',
  // Playwright resolves package metadata, browser descriptors and
  // injected scripts relative to its own installed package.
  // Bundling it relocates those reads to dist-electron and makes
  // official careers rendering fail before a browser can launch.
  'playwright',
  // The SDK loads runtime files relative to its own package and
  // launches the user's installed Claude Code executable.
  '@anthropic-ai/claude-agent-sdk',
  // jsdom uses __dirname-relative readFileSync for browser/default-stylesheet.css;
  // bundling it corrupts that path to dist-electron/ instead of node_modules/jsdom/.
  'jsdom',
  // pdf-lib's tslib helpers break under CJS bundling ("Cannot
  // destructure '__extends'" at main.cjs load) — resolve it from
  // node_modules at runtime like the other externals.
  'pdf-lib',
]
