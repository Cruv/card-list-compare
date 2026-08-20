import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        varsIgnorePattern: '^[A-Z_]',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Co-locating a provider with its consumer hook (AuthProvider + useAuth) and
      // a component with its imperative helper (Toast + toast) is the idiomatic
      // React pattern, and this rule only guards HMR ergonomics — not correctness.
      // Allow the specific names we do this for rather than splitting every file.
      'react-refresh/only-export-components': ['error', {
        allowExportNames: [
          'useAuth', 'useTheme', 'useAppSettings', 'useConfirm',
          'toast', 'symbolToSvgUrl', 'preloadManaSymbols',
        ],
      }],
      // Warn, don't block. Every current hit is the same shape: an effect calling
      // a `refresh()` callback that flips a loading flag before fetching — the
      // standard fetch-on-mount/on-param-change pattern, not a bug. Silencing it
      // per-site would add ~8 disable comments, and restructuring data fetching
      // across the admin panels is a real project, not lint cleanup. Kept visible
      // so new occurrences are still noticed.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    // Server code and tests run under Node, not the browser
    files: ['server/**/*.js', '**/*.test.{js,jsx}', 'vite.config.js', 'vitest.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
])
