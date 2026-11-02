import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";

// TypeScript, like every other source file here (see AGENTS.md). ESLint loads
// it through the `jiti` devDependency at lint time; there is no compile step,
// and tsconfig.json includes only src, so it is never emitted into dist/.

export default defineConfig([
  globalIgnores(["dist", "node_modules"]),

  {
    // A strict TypeScript project has no hand-written JavaScript: flag any
    // that turns up, so CI fails on it rather than leaving it unchecked.
    files: ["**/*.{js,mjs,cjs,jsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Program",
          message:
            "This is a strict TypeScript project: write .ts, not JavaScript (see AGENTS.md).",
        },
      ],
    },
  },

  {
    // The root tooling configs (this file, vitest.config.ts) are type-checked
    // through tsconfig.test.json's include and linted at the same tier.
    files: ["src/**/*.{ts,tsx}", "test/**/*.{ts,tsx}", "*.ts"],
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
      // tsconfig.test.json extends tsconfig.json and includes src, test and
      // the root configs, so it alone covers every linted file. tsconfig.json
      // is src-only and would leave the rest unparseable under type-aware
      // rules.
      parserOptions: {
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      // Strict TypeScript: reach for `unknown` and narrow instead.
      "@typescript-eslint/no-explicit-any": "error",
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
