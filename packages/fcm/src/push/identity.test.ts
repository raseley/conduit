import { describe, expect, it } from "vitest";

import { DEFAULT_IDENTITY, LEGACY_IDENTITY } from "./identity.js";

describe("identity profiles", () => {
  it("legacy is exactly what push-receiver sends: Chrome 63 on a Mac", () => {
    expect(LEGACY_IDENTITY).toEqual({
      name: "legacy",
      checkin: { deviceType: 3, chromePlatform: 2, chromeVersion: "63.0.3234.0", chromeChannel: 1 },
      login: { id: "chrome-63.0.3234.0", networkType: 1 },
    });
  });

  it("keeps the login id in step with the check-in's Chrome version", () => {
    expect(LEGACY_IDENTITY.login.id).toBe(`chrome-${LEGACY_IDENTITY.checkin.chromeVersion}`);
  });

  it("is frozen, so no caller can change what is sent to Google", () => {
    expect(Object.isFrozen(LEGACY_IDENTITY)).toBe(true);
    expect(Object.isFrozen(LEGACY_IDENTITY.checkin)).toBe(true);
    expect(Object.isFrozen(LEGACY_IDENTITY.login)).toBe(true);
  });

  it("ships the legacy profile until the identity experiment picks one", () => {
    expect(DEFAULT_IDENTITY).toBe(LEGACY_IDENTITY);
  });
});
