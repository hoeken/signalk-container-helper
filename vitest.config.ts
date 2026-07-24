import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The four reference plugin checkouts at the repo root carry their own
    // test suites — only run this library's tests.
    include: ["test/**/*.test.ts"],
  },
});
