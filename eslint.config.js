import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import {includeIgnoreFile} from '@eslint/compat';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  // Include ignores from .gitignore and package-level .gitignore files
  includeIgnoreFile(path.resolve(__dirname, '.gitignore')),
  includeIgnoreFile(path.resolve(__dirname, 'packages/core/.gitignore')),
  includeIgnoreFile(path.resolve(__dirname, 'packages/supertalk/.gitignore')),
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Customize as needed
      '@typescript-eslint/no-unused-vars': [
        'error',
        {argsIgnorePattern: '^_', varsIgnorePattern: '^_'},
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      // Allow async functions in void positions (e.g., event handlers)
      '@typescript-eslint/no-misused-promises': [
        'error',
        {checksVoidReturn: false},
      ],
    },
  },
  {
    ignores: ['**/node_modules/**', '**/*.js', '**/*.mjs'],
  },
);
