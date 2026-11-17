import { describe, it, expect } from "vitest";

import {
  SteamSignInError,
  classifySteamConnectError,
  steamFailureCopy,
  steamFailureEvent,
  steamRenewalResult,
  type SteamSignInFailure,
} from "./steam-sign-in.js";

describe("steamRenewalResult (sign in again from the tray)", () => {
  it("success says it is reconnecting", () => {
    expect(steamRenewalResult(undefined)).toEqual({
      ok: true,
      message: "Signed in again. Conduit is reconnecting to your servers.",
    });
  });

  it("cancelling changes nothing and says so", () => {
    expect(steamRenewalResult({ kind: "cancelled" })).toEqual({
      ok: false,
      message: "Sign-in was cancelled. Nothing was changed.",
    });
  });

  it("other failures reuse the wizard's copy", () => {
    const failure: SteamSignInFailure = { kind: "registration-failed" };
    expect(steamRenewalResult(failure)).toEqual({
      ok: false,
      message: steamFailureCopy(failure).message,
    });
  });
});

/** fcm wraps whatever `onSteamLogin` rejects with in an AuthError, as `cause`. */
class FakeAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthError";
  }
}

const ALL_FAILURES: SteamSignInFailure[] = [
  { kind: "cancelled" },
  { kind: "refused", reason: "cancelled" },
  { kind: "flow-changed", reason: "/app answered HTTP 200 instead of the sign-in redirect" },
  { kind: "registration-failed" },
  { kind: "unreachable" },
];

describe("classifySteamConnectError", () => {
  it("finds the window's failure through fcm's AuthError wrapper", () => {
    const failure: SteamSignInFailure = { kind: "refused", reason: "cancelled" };
    const err = new FakeAuthError("Steam login was cancelled or failed", {
      cause: new SteamSignInError(failure),
    });
    expect(classifySteamConnectError(err, { tokenCaptured: false })).toEqual(failure);
  });

  it("reads a SteamSignInError thrown directly", () => {
    expect(
      classifySteamConnectError(new SteamSignInError({ kind: "cancelled" }), {
        tokenCaptured: false,
      }),
    ).toEqual({ kind: "cancelled" });
  });

  it("after the token was captured, any other failure is the registration", () => {
    const err = new FakeAuthError("Companion API rejected the Steam auth token (HTTP 401)");
    expect(classifySteamConnectError(err, { tokenCaptured: true })).toEqual({
      kind: "registration-failed",
    });
  });

  it("before the window reported anything, it is the setup (network)", () => {
    expect(classifySteamConnectError(new Error("ECONNRESET"), { tokenCaptured: false })).toEqual({
      kind: "unreachable",
    });
    expect(classifySteamConnectError("not an error", { tokenCaptured: false })).toEqual({
      kind: "unreachable",
    });
  });

  it("survives a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(classifySteamConnectError(a, { tokenCaptured: false })).toEqual({ kind: "unreachable" });
  });
});

describe("steamFailureCopy", () => {
  it("gives every outcome its own message", () => {
    const messages = ALL_FAILURES.map((f) => steamFailureCopy(f).message);
    expect(new Set(messages).size).toBe(ALL_FAILURES.length);
  });

  it("cancelled reads as a choice, not an error", () => {
    const copy = steamFailureCopy({ kind: "cancelled" });
    expect(copy.message).toMatch(/^Sign-in was cancelled/);
    expect(copy.offerDiagnostics).toBe(false);
  });

  it("Facepunch refusing says to retry and names a plain reason", () => {
    const copy = steamFailureCopy({ kind: "refused", reason: "cancelled" });
    expect(copy.message).toMatch(/try again/i);
    expect(copy.message).toContain("cancelled");
    expect(copy.offerDiagnostics).toBe(false);
  });

  it("never shows an odd-looking refusal reason", () => {
    const copy = steamFailureCopy({ kind: "refused", reason: "x?token=SECRET&a=b" });
    expect(copy.message).not.toContain("SECRET");
    expect(copy.message).not.toContain("?");
  });

  it("a changed flow says retrying won't help and points to Copy diagnostics", () => {
    const copy = steamFailureCopy({
      kind: "flow-changed",
      reason: "window closed after /app redirected to https://companion-rust.facepunch.com/x",
    });
    expect(copy.message).toMatch(/won't help/);
    expect(copy.message).toMatch(/Copy diagnostics/);
    expect(copy.message).not.toContain("https://");
    expect(copy.offerDiagnostics).toBe(true);
  });

  it("a failed registration points to Copy diagnostics", () => {
    const copy = steamFailureCopy({ kind: "registration-failed" });
    expect(copy.message).toMatch(/Copy diagnostics/);
    expect(copy.offerDiagnostics).toBe(true);
  });

  it("an unreachable service says to check the connection", () => {
    expect(steamFailureCopy({ kind: "unreachable" }).message).toMatch(/internet connection/);
  });
});

describe("steamFailureEvent", () => {
  it("cancelled → steam.cancelled (not an error)", () => {
    expect(steamFailureEvent({ kind: "cancelled" })).toEqual({
      type: "steam.cancelled",
      message: steamFailureCopy({ kind: "cancelled" }).message,
    });
  });

  it("everything else → steam.error with the diagnostics hint", () => {
    expect(steamFailureEvent({ kind: "registration-failed" })).toEqual({
      type: "steam.error",
      message: steamFailureCopy({ kind: "registration-failed" }).message,
      offerDiagnostics: true,
    });
    expect(steamFailureEvent({ kind: "refused", reason: "x" })).toMatchObject({
      type: "steam.error",
      offerDiagnostics: false,
    });
  });
});
