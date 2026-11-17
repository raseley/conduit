import { describe, it, expect } from "vitest";

import { HIDDEN_FLAG, isHiddenLaunch, loginItemOptions } from "./start-on-login.js";

/**
 * Only the pure option builder and argv check are tested here; the
 * `app.setLoginItemSettings` / `getLoginItemSettings` calls are thin Electron glue.
 */
describe("loginItemOptions", () => {
  it("packaged: launches the app's own exe with only the hidden flag", () => {
    expect(
      loginItemOptions({
        isPackaged: true,
        execPath: "C:\\Users\\jane\\AppData\\Local\\Programs\\Conduit\\Conduit.exe",
        appPath: "C:\\Users\\jane\\AppData\\Local\\Programs\\Conduit\\resources\\app.asar",
      }),
    ).toEqual({ args: ["--hidden"] });
  });

  // Electron writes the Run value unquoted (seen live: `electron.exe C:\…\desktop
  // --hidden`), so a path containing a space would split into two arguments.
  it("quotes paths that contain a space", () => {
    expect(
      loginItemOptions({
        isPackaged: true,
        execPath: "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Conduit\\Conduit.exe",
        appPath: "unused",
      }),
    ).toEqual({
      path: '"C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Conduit\\Conduit.exe"',
      args: ["--hidden"],
    });
    expect(
      loginItemOptions({
        isPackaged: false,
        execPath: "C:\\My Code\\conduit\\electron.exe",
        appPath: "C:\\My Code\\conduit\\apps\\desktop",
      }),
    ).toEqual({
      path: '"C:\\My Code\\conduit\\electron.exe"',
      args: ['"C:\\My Code\\conduit\\apps\\desktop"', "--hidden"],
    });
  });

  // The portable exe unpacks the app into a temporary folder on every launch and
  // deletes it on exit, so the running exe's path is gone by the next sign-in.
  it("portable: launches the portable exe the user ran, not the temporary copy", () => {
    expect(
      loginItemOptions({
        isPackaged: true,
        execPath: "C:\\Users\\jane\\AppData\\Local\\Temp\\3MErf2KSnGkz\\Conduit.exe",
        appPath: "unused",
        portableExecutable: "D:\\Apps\\Conduit-2026.11.0-portable.exe",
      }),
    ).toEqual({ path: "D:\\Apps\\Conduit-2026.11.0-portable.exe", args: ["--hidden"] });
  });

  it("portable: quotes a portable exe path that contains a space", () => {
    expect(
      loginItemOptions({
        isPackaged: true,
        execPath: "C:\\Users\\jane\\AppData\\Local\\Temp\\3MErf2KSnGkz\\Conduit.exe",
        appPath: "unused",
        portableExecutable: "C:\\Users\\Jane Doe\\Downloads\\Conduit-2026.11.0-portable.exe",
      }),
    ).toEqual({
      path: '"C:\\Users\\Jane Doe\\Downloads\\Conduit-2026.11.0-portable.exe"',
      args: ["--hidden"],
    });
  });

  it("from source: points at electron.exe and passes the app directory first", () => {
    const opts = loginItemOptions({
      isPackaged: false,
      execPath: "C:\\src\\conduit\\node_modules\\electron\\dist\\electron.exe",
      appPath: "C:\\src\\conduit\\apps\\desktop",
    });
    expect(opts).toEqual({
      path: "C:\\src\\conduit\\node_modules\\electron\\dist\\electron.exe",
      args: ["C:\\src\\conduit\\apps\\desktop", "--hidden"],
    });
  });

  it("returns the same options on every call, so the read matches the write", () => {
    const ctx = { isPackaged: false, execPath: "electron.exe", appPath: "app" };
    expect(loginItemOptions(ctx)).toEqual(loginItemOptions(ctx));
  });
});

describe("isHiddenLaunch", () => {
  it("is true when the login item's flag is present", () => {
    expect(isHiddenLaunch(["Conduit.exe", HIDDEN_FLAG])).toBe(true);
    expect(isHiddenLaunch(["electron.exe", "C:\\src\\apps\\desktop", "--hidden"])).toBe(true);
  });

  it("is false for a normal launch", () => {
    expect(isHiddenLaunch(["Conduit.exe"])).toBe(false);
    expect(isHiddenLaunch(["electron.exe", "C:\\src\\apps\\desktop"])).toBe(false);
  });
});
