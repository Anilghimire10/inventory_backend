// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The `lint` script has existed since the project started but never ran:
 * there was no config file here, and neither eslint nor prettier was
 * installed. This is that config.
 *
 * Type-aware rules are on, since the bugs worth catching in this codebase are
 * the type-shaped ones -- a Prisma Decimal compared with `>=` reads fine and
 * silently does a string comparison.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The build tsconfig excludes test/ and prisma/, so point the
        // type-aware rules at the wider lint-only project instead.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Nest's DI and Prisma's generated types lean on decorators and broad
      // generics; these fire constantly on idiomatic code without pointing
      // at anything real.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',

      // Warnings, not errors. Express hands back `any` for req/params/ip and
      // class-transformer's @Transform callbacks are untyped, so almost every
      // hit is that rather than a defect -- but the family is still worth
      // seeing, because a genuine one reads exactly like the rest.
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Prisma Decimals render fine via toString in a template literal; the
      // dangerous case is comparing them, which tsc and review catch.
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',

      // A leading underscore is the established way to mark a deliberately
      // unused binding in this codebase (see upload.config.ts), and
      // ignoreRestSiblings covers the `const { passwordHash, ...safe } = user`
      // idiom used to strip fields from a response.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // `void somePromise()` is used deliberately for fire-and-forget audit
      // writes, which this rule otherwise flags.
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreVoid: true },
      ],
    },
  },
  {
    // The hand-rolled check harness stubs Prisma with deliberately partial
    // objects and casts them into place, so this whole family is noise there
    // by construction: `async () => value` is how a stubbed repository method
    // is written, and the assertions are what make a partial object stand in
    // for a full client.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
