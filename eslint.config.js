import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";

export default defineConfig([
  globalIgnores(["dist", "node_modules"]),

  // Root-level tooling config is outside tsconfig.test.json's include, so it
  // cannot be type-checked; lint it with the untyped tier instead.
  {
    files: ["*.js", "*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    languageOptions: {
      parser: tseslint.parser,
      globals: globals.node,
    },
  },

  {
    files: ["src/**/*.{ts,tsx}", "test/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      // Type-checked tier, not plain `recommended`. This library is async-heavy
      // (ensureRunning, waitForHttpReady, probeHttpHealth, startSafely) and an
      // unawaited promise is the exact failure mode startSafely exists to guard
      // against -- no-floating-promises and no-misused-promises need type
      // information to see one at all.
      tseslint.configs.recommendedTypeChecked,
      prettier,
    ],
    languageOptions: {
      parser: tseslint.parser,
      // tsconfig.test.json extends tsconfig.json and includes both src and
      // test, so it alone covers every linted source file. tsconfig.json is
      // src-only and would leave tests unparseable under type-aware rules.
      parserOptions: {
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },

  {
    // The /ui entry runs in the Admin UI page, not Node.
    files: ["src/ui/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },

  {
    // Test ergonomics. These three fire constantly on idiomatic vitest without
    // indicating a defect: `async () => {}` callbacks that only assert, and
    // assertions/unbound references against mocks whose types are deliberately
    // loose. The rules that actually matter in tests -- no-floating-promises,
    // no-misused-promises, await-thenable -- stay on.
    files: ["test/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
]);
