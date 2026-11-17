import { describe, expect, it } from "vitest";

import {
  BotCoreError,
  CameraUnavailableError,
  StateError,
  ValidationError,
  type CameraUnavailableReason,
} from "@conduit/bot-core";

import {
  CAMERA_NOT_FOUND_MESSAGE,
  CAMERA_NO_FRAMES_MESSAGE,
  CAMERA_PLAYER_ONLINE_MESSAGE,
  ENTITY_NOT_FOUND_MESSAGE,
  GENERIC_FAILURE_MESSAGE,
  STALE_STATE_MESSAGE,
  friendlyError,
  shortFailureReason,
} from "./index.js";

/** An error carrying only a `name`, as thrown by a lower tier discord never imports. */
function named(name: string, message = "internal detail"): Error {
  return Object.assign(new Error(message), { name });
}

describe("friendlyError", () => {
  it("gives bot-core's StateError the stale-state copy", () => {
    expect(friendlyError(new StateError("Unknown entity 7 on server srv-1"))).toBe(
      STALE_STATE_MESSAGE,
    );
    expect(friendlyError(new StateError("Server srv-1 is not connected"))).toBe(
      STALE_STATE_MESSAGE,
    );
  });

  it("maps each known category to its own distinct line", () => {
    const names = [
      "AuthError",
      "RateLimitError",
      "ConnectionError",
      "EntityNotFoundError",
      "StateError",
    ];
    const lines = names.map((name) => friendlyError(named(name)));

    expect(new Set(lines).size).toBe(names.length);
    expect(lines).not.toContain(GENERIC_FAILURE_MESSAGE);
    expect(friendlyError(named("EntityNotFoundError"))).toBe(ENTITY_NOT_FOUND_MESSAGE);
  });

  it("names both causes of a device not found: gone, or no tool-cupboard access", () => {
    const line = friendlyError(named("EntityNotFoundError"));
    expect(line).toMatch(/tool cupboard/);
    expect(line).toMatch(/re-authorise/);
    expect(line).toMatch(/removed or the map was wiped/);
    expect(line).toMatch(/\*\*Settings\*\*/);
  });

  it("falls back to the generic copy for anything it doesn't recognise", () => {
    const unknowns: unknown[] = [
      new Error("boom"),
      new BotCoreError("base"),
      new ValidationError("Auto-revert delay must be a whole number"),
      named("ProtocolError"),
      "a string",
      42,
      null,
      undefined,
      {},
    ];
    for (const value of unknowns) {
      expect(friendlyError(value)).toBe(GENERIC_FAILURE_MESSAGE);
    }
  });

  it("never echoes the underlying error's message or stack", () => {
    for (const name of ["AuthError", "StateError", "SomethingElse"]) {
      const err = named(name, "SECRET-INTERNAL-DETAIL playerToken=abc");
      const line = friendlyError(err);
      expect(line).not.toContain("SECRET-INTERNAL-DETAIL");
      // No stack frames ("    at fn (file:line:col)") and no file paths.
      expect(line).not.toMatch(/\n\s*at\s/);
      expect(line).not.toMatch(/\.[cm]?[jt]s:\d+/);
    }
  });
});

/** The camera failure rustplus-client raises, as bot-core re-exports it. */
function cameraError(reason: CameraUnavailableReason): CameraUnavailableError {
  return new CameraUnavailableError("internal detail", { reason });
}

/** A ProtocolError as rustplus-client raises it for an unmapped server answer. */
function protocolError(serverError?: string): Error {
  return Object.assign(named("ProtocolError", `server error: ${serverError}`), { serverError });
}

describe("camera capture failures", () => {
  it.each<[CameraUnavailableReason, string, string]>([
    ["playerOnline", CAMERA_PLAYER_ONLINE_MESSAGE, "player is in-game"],
    ["notFound", CAMERA_NOT_FOUND_MESSAGE, "camera not found"],
    ["noFrames", CAMERA_NO_FRAMES_MESSAGE, "camera sent no image"],
  ])("explains %s to the member and the audit log", (reason, member, audit) => {
    expect(friendlyError(cameraError(reason))).toBe(member);
    expect(shortFailureReason(cameraError(reason))).toBe(audit);
  });

  it("tells an in-game member to disconnect and try again", () => {
    expect(friendlyError(cameraError("playerOnline"))).toBe(
      "📷 Rust+ can't show cameras while you're connected to the server in-game. Disconnect from the server, then try Capture again.",
    );
  });

  it("falls back safely for a camera error with no known reason", () => {
    const odd = named("CameraUnavailableError");
    expect(friendlyError(odd)).toBe(GENERIC_FAILURE_MESSAGE);
    expect(shortFailureReason(odd)).toBe("camera unavailable");
  });
});

describe("shortFailureReason", () => {
  it("names the server's raw code for an unmapped ProtocolError", () => {
    expect(shortFailureReason(protocolError("no_permission"))).toBe(
      "server refused: `no_permission`",
    );
  });

  it("does not post a code that is not a plain token", () => {
    for (const code of [undefined, "", "<@&123> ping", "a".repeat(41), "x`y"]) {
      expect(shortFailureReason(protocolError(code))).toBe("unexpected server response");
    }
  });

  it("keeps the generic reason for anything unrecognised", () => {
    for (const value of [new Error("boom"), "a string", null, undefined, {}]) {
      expect(shortFailureReason(value)).toBe("unexpected error");
    }
  });
});
