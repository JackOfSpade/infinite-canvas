import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist', 'dist-electron',
    'release',                            // electron-builder output (gitignored) — never lint built app copies
    'Job Application Design System/build/vendor',  // third-party (pdf-lib.min.js)
    'Job Application Design System/_ds_bundle.js', // generated dual-mode bundle (see its @ds-bundle header) — not app-consumed, never hand-edited
  ]),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      // Catches a temporal-dead-zone read: a `const`/`let` referenced in the
      // SAME scope above its declaration. In a React component body that is a
      // render-phase ReferenceError that stops the component mounting at all,
      // and NOTHING else in this repo's gate sees it — the renderer tests
      // assert raw source substrings or run a handler body sliced out with
      // `new Function`, so no test ever evaluates a component body;
      // `build:compile` only transpiles; and the Electron smoke test
      // deliberately avoids scraping, so it never mounts a job source card.
      // One of these shipped green through all three.
      //
      // All three sub-options are false ON PURPOSE. `functions: false` keeps
      // ordinary hoisted-helper calls legal, and `variables: false` ignores a
      // reference whose declaration is in an UPPER scope — i.e. the normal
      // "callback defined above, variable below, called later" pattern — while
      // still reporting the same-scope case, which is the only one that is a
      // guaranteed runtime throw. Verified: 0 findings across the repo.
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
    },
  },
  {
    files: ['electron/**/*.{js,mjs,cjs}', 'scripts/**/*.{js,mjs,cjs}', 'vite.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Design-system build gates and handoff checks are plain CommonJS Node
    // scripts (require/module.exports/Buffer/process), not browser ESM. Their
    // shared harness destructuring intentionally keeps `ok`/`fail` uniform
    // even in tests that only use `assert`; retain the checks and exempt only
    // those conventional aliases.
    files: [
      'Job Application Design System/build/**/*.js',
      'Job Application Design System/handoff/**/*.js',
    ],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^(?:[A-Z_]+|ok|fail)$' }],
    },
  },
])
