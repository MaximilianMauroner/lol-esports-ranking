import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['scripts/**/*.mjs'],
    extends: [
      js.configs.recommended,
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Design-system guard: class strings must use the token scales from
    // src/styles/base.css through their Tailwind names.
    files: ['src/**/*.tsx', 'scripts/seo-prerender.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...designSystemClassRules()],
    },
  },
  {
    // Data order guard: published artifacts, state, and hashes must not depend
    // on ICU collation (localeCompare, Intl.Collator) or the process locale.
    // Views may sort for display.
    files: ['src/lib/**/*.{ts,mjs,js}', 'scripts/**/*.{ts,mjs,js}'],
    rules: {
      'no-restricted-properties': ['error', {
        property: 'localeCompare',
        message: 'Use compareCodeUnits from src/lib/codeUnitOrder.mjs for locale-independent order.',
      }, {
        object: 'Intl',
        property: 'Collator',
        message: 'Use compareCodeUnits from src/lib/codeUnitOrder.mjs for locale-independent order.',
      }],
    },
  },
  {
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
    },
  },
])

function designSystemClassRules() {
  const patterns = [
    [String.raw`\btext-\[[0-9.]+(px|rem|em)\]`, 'Use a type-scale class (text-2xs to text-2xl), not an arbitrary font size.'],
    [String.raw`\b(rounded(-[a-z]{1,2})?-\[var\(--r-[0-9]\)\]|text-\[length:var\(--t-[0-9]\)\]|(bg|text|border(-[a-z])?|fill|stroke|divide|ring|outline)-\[var\(--(bg|background|line|border|text|foreground|muted|surface)\)\])`, 'Use the mapped Tailwind name (rounded-md, text-sm, *-background for --bg, *-border for --line, *-foreground for --text, *-muted-foreground for --muted, *-card for --surface).'],
    [String.raw`\b(p[xytrbl]?|m[xytrbl]?|gap(-[xy])?)-\[[0-9.]+(px|rem|em)(_[0-9.]+(px|rem|em))*\]`, 'Use a spacing step on the 4px grid, not an arbitrary px, rem, or em value.'],
    [String.raw`\btracking-\[[0-9.]+em\]`, 'Use tracking-label for uppercase labels.'],
    [String.raw`oklch\(`, 'Use a colour token from base.css, not a raw oklch() value.'],
  ]
  return patterns.flatMap(([pattern, message]) => [
    { selector: `Literal[value=/${pattern}/]`, message },
    { selector: `TemplateElement[value.raw=/${pattern}/]`, message },
  ])
}
