// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Convention 4: only src/tenancy/ may open database connections. Everything
// else gets a handle from db(), which is always tenant-scoped.
const noRawDb = {
  paths: [
    { name: 'pg', message: 'Only src/tenancy/ may import pg. Use db() from src/tenancy.' },
    { name: 'drizzle-orm/node-postgres', message: 'Only src/tenancy/ may import drizzle-orm/node-postgres. Use db().' },
  ],
  patterns: [{ group: ['pg/*', 'pg-pool', 'drizzle-orm/node-postgres/*'], message: 'Only src/tenancy/ may open database connections.' }],
};

// Convention 8: money is integer minor units. A `number` field NAMED like an
// amount is how a float sneaks in — name it `*_minor`/`*Minor` and pair it
// with a currency, or use the Money type from src/shared/money.ts.
const AMOUNT_NAME = '/(^|_)(amount|price|total|cost|fee|balance|subtotal)$|(Amount|Price|Total|Cost|Fee|Balance|Subtotal)$/';
const noFloatMoney = [
  {
    selector: `:matches(TSPropertySignature, PropertyDefinition)[key.name=${AMOUNT_NAME}] > TSTypeAnnotation > TSNumberKeyword`,
    message: 'Money fields are integer minor units: name it *_minor / *Minor next to a currency, or use Money.',
  },
  {
    selector: "CallExpression[callee.name='parseFloat'], CallExpression[callee.property.name='toFixed']",
    message: 'parseFloat/toFixed have no place near money. Use integer minor units (src/shared/money.ts).',
  },
];

const noProcessEnv = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message: 'Read configuration through APP_CONFIG. Only src/config/ may touch process.env.',
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'keys/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Off on purpose: Nest resolves constructor injection from decorator
      // metadata, so an injected class imported as `import type` vanishes at
      // runtime and DI fails. This rule would "fix" working code into broken code.
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', noProcessEnv, ...noFloatMoney],
      'no-restricted-imports': ['error', noRawDb],
    },
  },
  {
    files: ['src/tenancy/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['src/config/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...noFloatMoney] },
  },
);
