'use strict';
const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: 'error',
  'prefer-const': 'error',
  'no-var': 'error',
};

module.exports = [
  { ignores: ['node_modules/'] },
  { files: ['**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node }, rules },
  { files: ['public/app.js', 'public/modules/*.js'], languageOptions: { sourceType: 'module', globals: globals.browser } },
  { files: ['public/theme.js'], languageOptions: { sourceType: 'script', globals: globals.browser } },
  { files: ['public/sw.js'], languageOptions: { sourceType: 'script', globals: globals.serviceworker } },
];
