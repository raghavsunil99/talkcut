// Lint catches typos and leftovers only (undefined names, unused variables); it enforces no style.
const js = require('@eslint/js');
const globals = require('globals');

// Each renderer file adds one Cutline* global; the editor scripts read them from `window`.
const cutlineGlobals = Object.fromEntries([
  'CutlineAppearance', 'CutlineCanvas', 'CutlineCaptions', 'CutlineCrop', 'CutlineEdits', 'CutlineFrame',
  'CutlineHome', 'CutlinePanels', 'CutlineProperties', 'CutlineRenderPlan', 'CutlineSpeakers', 'CutlineText',
  'CutlineTimeline', 'CutlineTracks', 'CutlineKeysDialog',
].map((name) => [name, 'readonly']));

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
};

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'android/**', 'mobile/www/**', 'vendor/**', 'test/e2e/**/fixtures/**'] },
  { ...js.configs.recommended, rules: {} }, // base parser settings only; rules are listed below
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: globals.node },
    rules,
  },
  {
    // The browser pages. Shared modules (edits.js, captions.js, ...) also run under Node in the
    // tests and the main process, so `module`, `require` and `process` are allowed here too.
    files: ['src/renderer/**/*.js', 'mobile/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser, ...cutlineGlobals,
        module: 'writable', require: 'readonly', process: 'readonly', cutline: 'readonly',
        FFmpegWASM: 'readonly', Capacitor: 'readonly',
      },
    },
    rules,
  },
];
