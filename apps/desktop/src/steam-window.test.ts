import { describe, it, expect } from "vitest";

import {
  appStepUserAgent,
  isAppStep,
  judgeFacepunchResponse,
  loginFailedReason,
  parseAuthRedirect,
  redirectTargetForLog,
  withAppStepHeaders,
} from "./windows/steam-window.js";

/**
 * Only the pure helpers are unit-tested here; opening the actual isolated
 * BrowserWindow needs an Electron runtime. Importing the module is safe in Node
 * because the `electron` named imports are only referenced inside functions,
 * never at module scope.
 *
 * The login contract under test is Facepunch's since its October 2026 login change
 * (the old flow landed on the Rust+ landing page and never handed over a token):
 * `/app` answers `302 Location: rust-plus://rust-auth-session?token=…&steamId=…`,
 * or "Login Failed" when the User-Agent names Windows.
 */
const APP =
  "https://companion-rust.facepunch.com/app?returnUrl=rust-plus%3A%2F%2Frust-auth-session";

describe("parseAuthRedirect", () => {
  it("reads the token from the rust-plus redirect", () => {
    expect(
      parseAuthRedirect("rust-plus://rust-auth-session?token=TOK-42&steamId=76561198000000000"),
    ).toEqual({ kind: "token", token: "TOK-42" });
  });

  it("accepts a trailing slash and Facepunch's capitalised parameter names", () => {
    expect(parseAuthRedirect("rust-plus://rust-auth-session/?SteamId=1&Token=TOK")).toEqual({
      kind: "token",
      token: "TOK",
    });
  });

  it("decodes a URL-encoded token", () => {
    expect(parseAuthRedirect("rust-plus://rust-auth-session?token=a%2Bb%3D%3D")).toEqual({
      kind: "token",
      token: "a+b==",
    });
  });

  it("treats a redirect without a token as a failure naming the error", () => {
    expect(parseAuthRedirect("rust-plus://rust-auth-session?error=cancelled")).toEqual({
      kind: "flow-changed",
      reason: "redirect without token (cancelled)",
    });
  });

  it("treats an uppercase scheme as the auth redirect", () => {
    expect(parseAuthRedirect("Rust-Plus://rust-auth-session?token=U")).toEqual({
      kind: "token",
      token: "U",
    });
  });

  it("ignores anything that is not a rust-plus redirect", () => {
    expect(parseAuthRedirect("https://companion-rust.facepunch.com/?token=X")).toBeUndefined();
  });
});

describe("isAppStep", () => {
  it("matches Facepunch's /app endpoint with its query", () => {
    expect(isAppStep(APP)).toBe(true);
  });

  it("does not match resources that share the /app prefix", () => {
    expect(isAppStep("https://companion-rust.facepunch.com/app.js")).toBe(false);
    expect(isAppStep("https://companion-rust.facepunch.com/apple-touch-icon.png")).toBe(false);
  });

  it("does not match another host or plain http", () => {
    expect(isAppStep("https://evil.example/app")).toBe(false);
    expect(isAppStep("http://companion-rust.facepunch.com/app")).toBe(false);
    expect(isAppStep("not a url")).toBe(false);
  });
});

describe("loginFailedReason", () => {
  it("reads the reason from Facepunch's Login Failed page", () => {
    expect(
      loginFailedReason("https://companion-rust.facepunch.com/login-failed?reason=cancelled"),
    ).toBe("cancelled");
  });

  it("reports 'unknown' when the page gives no reason", () => {
    expect(loginFailedReason("https://companion-rust.facepunch.com/login-failed")).toBe("unknown");
  });

  it("returns undefined for any other page", () => {
    expect(loginFailedReason("https://companion-rust.facepunch.com/login")).toBeUndefined();
    expect(loginFailedReason("https://steamcommunity.com/login-failed")).toBeUndefined();
  });
});

describe("withAppStepHeaders", () => {
  const ua = appStepUserAgent("130.0.6723.191");

  it("presents a Chrome-on-Linux User-Agent that does not name Windows", () => {
    expect(ua).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36",
    );
    expect(ua.toLowerCase()).not.toContain("windows");
  });

  it("replaces the User-Agent whatever its casing and keeps every other header", () => {
    const out = withAppStepHeaders(
      {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/33.2.1",
        Accept: "text/html",
        Cookie: "session=abc",
      },
      ua,
    );
    expect(out).toEqual({ "User-Agent": ua, Accept: "text/html", Cookie: "session=abc" });
  });

  it("sets a Sec-CH-UA-Platform hint to Linux when the browser sent one", () => {
    const out = withAppStepHeaders({ "sec-ch-ua-platform": '"Windows"' }, ua);
    expect(out["sec-ch-ua-platform"]).toBe('"Linux"');
  });

  it("does not add a platform hint the browser did not send", () => {
    expect(Object.keys(withAppStepHeaders({}, ua))).toEqual(["User-Agent"]);
  });
});

describe("judgeFacepunchResponse", () => {
  const ROOT = "https://companion-rust.facepunch.com/";

  it("captures the token from /app's 302 to rust-plus://", () => {
    expect(
      judgeFacepunchResponse(APP, 302, {
        Location: ["rust-plus://rust-auth-session?token=TOK&steamId=7656"],
      }),
    ).toEqual({ kind: "token", token: "TOK" });
  });

  it("captures a rust-plus redirect whichever Facepunch path issues it", () => {
    expect(
      judgeFacepunchResponse(`${ROOT}login/callback`, 302, {
        location: ["RUST-PLUS://rust-auth-session?token=T"],
      }),
    ).toEqual({ kind: "token", token: "T" });
  });

  // Regression (live test 2026-11-16): /app redirected somewhere other than
  // rust-plus:// on its way to the final answer, and the window treated that
  // hop as the end of the login.
  it("follows an intermediate /app redirect instead of ending the login", () => {
    expect(judgeFacepunchResponse(APP, 302, { Location: ["/app?step=2&token=SECRET"] })).toEqual({
      kind: "continue",
      appRedirectTo: "https://companion-rust.facepunch.com/app",
    });
  });

  it("follows redirects from other Facepunch pages without noting them", () => {
    expect(
      judgeFacepunchResponse(`${ROOT}login`, 302, {
        Location: ["https://steamcommunity.com/openid/login?x=1"],
      }),
    ).toEqual({ kind: "continue" });
  });

  it("reports a page from /app instead of the redirect (Facepunch's Windows block)", () => {
    expect(judgeFacepunchResponse(APP, 200, { "Content-Type": ["text/html"] })).toEqual({
      kind: "flow-changed",
      reason: "/app answered HTTP 200 instead of the sign-in redirect",
    });
  });

  it("does not judge pages that are not /app", () => {
    expect(judgeFacepunchResponse(`${ROOT}app.js`, 200, undefined)).toEqual({ kind: "continue" });
    expect(judgeFacepunchResponse(`${ROOT}login`, 200, undefined)).toEqual({ kind: "continue" });
  });

  it("copes with a redirect that has no Location and with missing headers", () => {
    expect(judgeFacepunchResponse(APP, 302, {})).toEqual({ kind: "continue" });
    expect(judgeFacepunchResponse(APP, 500, undefined)).toEqual({
      kind: "flow-changed",
      reason: "/app answered HTTP 500 instead of the sign-in redirect",
    });
  });
});

describe("redirectTargetForLog", () => {
  it("keeps origin and path but never the query or fragment", () => {
    expect(redirectTargetForLog("https://companion-rust.facepunch.com/x/y?token=S#t=S")).toBe(
      "https://companion-rust.facepunch.com/x/y",
    );
  });

  it("resolves a relative Location against Facepunch", () => {
    expect(redirectTargetForLog("/login?returnUrl=%2Fapp")).toBe(
      "https://companion-rust.facepunch.com/login",
    );
  });

  it("names only the scheme of a non-web target", () => {
    expect(redirectTargetForLog("steam://openurl?token=S")).toBe("steam:…");
  });
});
