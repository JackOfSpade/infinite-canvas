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
    // The resume PDF build engine + its self-test are plain CommonJS Node scripts
    // (require/module.exports/Buffer/process), not browser ESM. Lint them as such.
    files: ['Job Application Design System/build/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },
])
