import { describe, it, expect } from "vitest";

import {
  formatTimestamp,
  alarmMentionPrefix,
  roleMentionPrefix,
  auditInteraction,
  auditDenied,
  auditSwitchToggle,
  auditSlash,
  auditModal,
  auditAlarm,
  auditAuthRenewal,
  auditDeath,
  auditTeamChat,
  auditEntityChange,
  auditServerStatus,
  auditServerPaired,
  auditEntityPaired,
} from "./audit-log.js";

// A fixed local-time instant so timestamp assertions are deterministic.
const t = new Date(2026, 5, 16, 14, 3, 5);

describe("auditAuthRenewal", () => {
  const FIX = "right-click its tray icon and choose **Sign in with Steam again…**";

  it("an expiring sign-in names the expiry as a Discord relative timestamp", () => {
    const line = auditAuthRenewal({
      time: t,
      reason: "expiring",
      expiresAt: "2026-11-18T00:00:00.000Z",
    });
    expect(line).toContain("[14:03:05] 🔑");
    expect(line).toContain(`<t:${Date.parse("2026-11-18T00:00:00.000Z") / 1000}:R>`);
    expect(line).toContain(FIX);
    expect(line).toContain("keeps working");
  });

  it.each([
    ["expired", "has expired"],
    ["rejected", "no longer accepts"],
  ] as const)("a %s sign-in says Conduit can't reach the servers", (reason, what) => {
    const line = auditAuthRenewal({ time: t, reason });
    expect(line).toContain(what);
    expect(line).toContain("can't reach your Rust servers");
    expect(line).toContain(FIX);
  });
});

describe("audit-log formatters", () => {
  it("formatTimestamp zero-pads to [HH:MM:SS]", () => {
    expect(formatTimestamp(t)).toBe("[14:03:05]");
    expect(formatTimestamp(new Date(2026, 0, 1, 0, 0, 0))).toBe("[00:00:00]");
  });

  it("renders a user mention when a userId is present", () => {
    expect(auditInteraction({ time: t, userId: "123", summary: "did a thing" })).toBe(
      "[14:03:05] 🎛 <@123> did a thing",
    );
  });

  it("falls back to @name then 'someone' without a userId", () => {
    expect(auditInteraction({ time: t, userName: "Rich", summary: "x" })).toBe(
      "[14:03:05] 🎛 @Rich x",
    );
    expect(auditInteraction({ time: t, summary: "x" })).toBe("[14:03:05] 🎛 someone x");
  });

  it("formats a switch toggle with label and ON/OFF", () => {
    expect(auditSwitchToggle({ time: t, userId: "1", label: "Front Door", on: true })).toBe(
      '[14:03:05] 🔘 <@1> toggled "Front Door" → ON',
    );
    expect(auditSwitchToggle({ time: t, userId: "1", label: "Front Door", on: false })).toBe(
      '[14:03:05] 🔘 <@1> toggled "Front Door" → OFF',
    );
  });

  it("formats a permission denial", () => {
    expect(auditDenied({ time: t, userId: "9", domain: "switch", action: "on" })).toBe(
      "[14:03:05] ⛔ <@9> denied: switch:on",
    );
  });

  it("formats slash + modal lines", () => {
    expect(auditSlash({ time: t, userId: "1", command: "conduit setup" })).toBe(
      "[14:03:05] ⌨ <@1> ran /conduit setup",
    );
    expect(auditModal({ time: t, userId: "1", summary: "sent to team chat: hi" })).toBe(
      "[14:03:05] 📝 <@1> sent to team chat: hi",
    );
  });

  it("formats in-game events", () => {
    expect(auditAlarm({ time: t, title: "Base", message: "Raid!" })).toBe(
      '[14:03:05] 🚨 Alarm "Base": Raid!',
    );
    expect(auditDeath({ time: t, name: "ShadowCat" })).toBe("[14:03:05] 💀 ShadowCat died");
    expect(auditDeath({ time: t, name: "ShadowCat", message: "by Bob" })).toBe(
      "[14:03:05] 💀 ShadowCat died: by Bob",
    );
    expect(auditTeamChat({ time: t, name: "Bob", message: "incoming C4" })).toBe(
      "[14:03:05] 💬 [TEAM] Bob: incoming C4",
    );
  });

  it("formats entity changes by type", () => {
    expect(auditEntityChange({ time: t, label: "Light", entityType: "switch", value: true })).toBe(
      '[14:03:05] 🔀 "Light" → ON',
    );
    expect(auditEntityChange({ time: t, label: "Box", entityType: "storageMonitor" })).toBe(
      '[14:03:05] 📦 "Box" contents changed',
    );
  });

  it("prefixes a role mention per role", () => {
    expect(roleMentionPrefix(["1", "2"])).toBe("<@&1> <@&2> ");
    expect(roleMentionPrefix([])).toBe("");
  });

  it("maps alarm notification levels to a mention prefix + delivery", () => {
    expect(alarmMentionPrefix("silent")).toEqual({ text: "", delivery: {} });
    expect(alarmMentionPrefix(undefined)).toEqual({ text: "", delivery: { notify: true } });
    expect(alarmMentionPrefix("active")).toEqual({
      text: "@here ",
      delivery: { notify: true, mentions: { everyone: true } },
    });
    expect(alarmMentionPrefix("everyone")).toEqual({
      text: "@everyone ",
      delivery: { notify: true, mentions: { everyone: true } },
    });
  });

  it("formats server/device status + pairings", () => {
    expect(auditServerStatus({ time: t, name: "Rusty", status: "online" })).toBe(
      "[14:03:05] 🟢 Rusty online",
    );
    expect(auditServerStatus({ time: t, name: "Rusty", status: "offline" })).toBe(
      "[14:03:05] 🔴 Rusty offline",
    );
    expect(auditServerPaired({ time: t, name: "Rusty" })).toBe("[14:03:05] 🛰 Server paired: Rusty");
    expect(auditEntityPaired({ time: t, label: "Front Door", entityType: "switch" })).toBe(
      "[14:03:05] ➕ Device paired: Front Door (switch)",
    );
  });
});
