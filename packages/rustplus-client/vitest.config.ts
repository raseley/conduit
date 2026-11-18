import { defineConfig } from "vitest/config";

// Tests live in src/. The build also compiles them into dist/, which vitest does not skip
// by default, so discovery is limited to src/ to keep them from running twice.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
