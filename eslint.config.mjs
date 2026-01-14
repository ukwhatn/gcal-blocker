import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        // Google Apps Script globals
        SpreadsheetApp: 'readonly',
        DocumentApp: 'readonly',
        DriveApp: 'readonly',
        Drive: 'readonly',
        FormApp: 'readonly',
        CalendarApp: 'readonly',
        GmailApp: 'readonly',
        SlidesApp: 'readonly',
        Browser: 'readonly',
        Logger: 'readonly',
        UrlFetchApp: 'readonly',
        PropertiesService: 'readonly',
        ScriptApp: 'readonly',
        Session: 'readonly',
        Utilities: 'readonly',
        console: 'readonly',
      },
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'webpack.config.js'],
  }
);
