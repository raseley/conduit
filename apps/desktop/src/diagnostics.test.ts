import { describe, it, expect } from "vitest";

import { SENSITIVE_KEYS } from "@conduit/fcm";

import { assembleDiagnostics, type DiagnosticsInput } from "./diagnostics.js";

function baseInput(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    appVersion: "2026.11.0",
    platform: { electron: "33.4.11", node: "22.0.0", os: "Windows 10", arch: "x64" },
    status: {
      overall: "idle",
      rows: [
        { id: "fcm", level: "online", label: "Push listener (FCM)", caption: "listening" },
        { id: "discord", level: "idle", label: "Discord gateway", caption: "reconnecting…" },
      ],
      tokenCaption: "Steam token renews in 9 days",
    },
    counts: {
      servers: 1,
      entities: 3,
      persistentIds: 12,
      hasCredentials: true,
      hasDiscordToken: true,
    },
    steamTokenExpiresAt: "2026-06-22T00:00:00.000Z",
    recentLogLines: ['{"level":30,"msg":"started"}'],
    generatedAt: Date.parse("2026-06-13T00:00:00.000Z"),
    ...overrides,
  };
}

describe("assembleDiagnostics", () => {
  it("includes app/platform/health/state sections", () => {
    const out = assembleDiagnostics(baseInput());
    expect(out).toContain("Conduit diagnostics");
    expect(out).toContain("app:       2026.11.0");
    expect(out).toContain("electron 33.4.11");
    expect(out).toContain("overall: idle");
    expect(out).toContain("Push listener (FCM)");
    expect(out).toContain("servers:        1");
    expect(out).toContain("credentials:    present");
  });

  it("redacts secret-shaped fragments leaking into log lines", () => {
    const out = assembleDiagnostics(
      baseInput({
        recentLogLines: [
          '{"steamAuthToken":"LEAKED_SECRET","playerToken":"ALSO_LEAKED"}',
          '{"token":"BOT_TOKEN_LEAK"}',
        ],
      }),
    );
    expect(out).not.toContain("LEAKED_SECRET");
    expect(out).not.toContain("ALSO_LEAKED");
    expect(out).not.toContain("BOT_TOKEN_LEAK");
    expect(out).toContain("[REDACTED]");
  });

  it("scrubs every string-valued key in the shared SENSITIVE_KEYS list", () => {
    const out = assembleDiagnostics(
      baseInput({
        recentLogLines: SENSITIVE_KEYS.map((key, i) => `{"${key}":"LEAK_${i}","msg":"kept"}`),
      }),
    );
    expect(out).not.toMatch(/LEAK_\d+/);
    expect(out).toContain('"msg":"kept"');
  });

  it("never prints raw credential material (only counts/flags)", () => {
    const out = assembleDiagnostics(baseInput());
    // No credential values are part of the input; assert flags are used instead.
    expect(out).toContain("discord token:  present");
    expect(out).toContain("steam token expires: 2026-06-22T00:00:00.000Z");
  });
});
