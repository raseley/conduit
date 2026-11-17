import { describe, it, expect } from "vitest";

import { DesktopApp, runApp } from "./main.js";

/**
 * `main.ts` is Electron glue and cannot be exercised without an Electron binary
 * (a runtime smoke/E2E test of the wizard is a later milestone).
 * This test only asserts that the composition root *imports* cleanly and exposes
 * the expected surface — importing it must NOT boot the app (the module footer is
 * guarded on `process.versions.electron`, which is absent in plain Node/vitest).
 * The real logic is covered by the electron-free unit tests in this package.
 */
describe("@conduit/desktop main (composition root)", () => {
  it("exports DesktopApp + runApp without auto-booting under vitest", () => {
    expect(typeof DesktopApp).toBe("function");
    expect(typeof runApp).toBe("function");
    // No Electron runtime here → the module-footer guard did not call runApp.
    expect(process.versions.electron).toBeUndefined();
  });
});
