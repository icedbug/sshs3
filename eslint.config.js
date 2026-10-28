import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import security from 'eslint-plugin-security';

export default tseslint.config(
  {
    ignores: ['dist', 'dist-electron', 'build-resources/**', 'release/**', '.npm-cache/**', 'node_modules', 'coverage', '*.config.js', '*.config.ts', '.claude/**', '.superpowers/**', 'pieces/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Only the long-standing hook rules; eslint-plugin-react-hooks v7 bundles
      // React Compiler-oriented rules (static-components, set-state-in-effect, ...)
      // under "recommended" which don't apply since this project doesn't use the compiler.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['src/main/**/*.{ts,cjs}', 'src/preload/**/*.ts', 'src/shared/**/*.ts', 'scripts/**/*.{mjs,js}', 'integrations/**/*.cjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['integrations/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Security lint for the privileged (main/preload) processes. Non-literal fs paths
    // and object-injection are noisy by design in a file manager, so they stay off;
    // everything else (eval, child_process, unsafe regex, buffer asserts, ...) is an error.
    files: ['src/main/**/*.{ts,cjs}', 'src/preload/**/*.ts'],
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-object-injection': 'off',
    },
  },
  {
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    // Everything in the main process goes through src/main/log so it is levelled, masked and persisted.
    files: ['src/main/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-console': 'error' },
  }
);
