import { defineConfig } from "vitest/config";

/**
 * Runs every package's tests from the repository root in one vitest process (also what
 * editor integrations read). Each project is a package directory and uses that package's
 * own vitest.config.ts. `pnpm test` runs vitest inside each package instead, where only
 * that package's config applies: vitest does not look in parent directories for one.
 */
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
