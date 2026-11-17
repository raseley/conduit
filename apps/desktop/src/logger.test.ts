import { describe, it, expect } from "vitest";
import pino from "pino";

import { REDACTED, SENSITIVE_KEYS } from "@conduit/fcm";

import { LogRing, REDACT_PATHS } from "./logger.js";

/** A pino instance configured like the app logger, writing lines into an array. */
function makeCapturingLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino(
    { level: "info", redact: { paths: REDACT_PATHS, censor: REDACTED }, base: undefined },
    { write: (line: string) => void lines.push(line) },
  );
  return { logger, lines };
}

describe("REDACT_PATHS", () => {
  it("is derived from the shared SENSITIVE_KEYS list (top level + one level down)", () => {
    expect(REDACT_PATHS).toHaveLength(SENSITIVE_KEYS.length * 2);
    for (const key of SENSITIVE_KEYS) {
      expect(REDACT_PATHS).toContain(key);
      expect(REDACT_PATHS).toContain(`*.${key}`);
    }
  });

  it("makes pino censor every shared sensitive key, top-level and nested", () => {
    for (const key of SENSITIVE_KEYS) {
      const { logger, lines } = makeCapturingLogger();
      logger.info({ [key]: "TOP_LEAK", payload: { [key]: "NESTED_LEAK", name: "ok" } }, "msg");

      expect(lines, key).toHaveLength(1);
      const line = lines[0]!;
      expect(line, key).not.toContain("TOP_LEAK");
      expect(line, key).not.toContain("NESTED_LEAK");
      const parsed = JSON.parse(line) as Record<string, any>;
      expect(parsed[key], key).toBe(REDACTED);
      expect(parsed.payload[key], key).toBe(REDACTED);
      // Non-sensitive siblings survive.
      expect(parsed.payload.name).toBe("ok");
    }
  });
});

describe("LogRing", () => {
  it("keeps only the most recent lines up to its cap", () => {
    const ring = new LogRing(3);
    for (const line of ["a", "b", "c", "d"]) ring.push(line);
    expect(ring.lines()).toEqual(["b", "c", "d"]);
  });

  it("returns a copy so callers can't mutate the buffer", () => {
    const ring = new LogRing();
    ring.push("a");
    ring.lines().push("tampered");
    expect(ring.lines()).toEqual(["a"]);
  });
});
