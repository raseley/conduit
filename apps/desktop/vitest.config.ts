import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Desktop unit-test config. Aliases `electron` to an inert stub (see
 * `test/electron-stub.ts`) so modules that import `electron` can be collected by
 * vitest without the (absent) Electron binary throwing at import time. The tests
 * still only exercise electron-free logic; the stub is never functionally
 * invoked. A real Electron runtime smoke test is a later milestone.
 *
 * Tests live in src/. The build also compiles them into dist/, which vitest does not
 * skip by default, so discovery is limited to src/ to keep them from running twice.
 */
export default defineConfig({
  resolve: {
    alias: {
      electron: fileURLToPath(new URL("./test/electron-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
