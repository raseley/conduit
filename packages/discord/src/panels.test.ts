import type { EntityInfo, TeamInfo } from "@conduit/bot-core";
import { describe, expect, it } from "vitest";

import { buildCustomId } from "./customId.js";
import { ITEM_NAMES } from "./item-names.js";
import {
  MESSAGE_MAX_COMPONENTS,
  MESSAGE_MAX_TEXT,
  NEW_GROUP_OPTION,
  buildAlarmSettingsPanel,
  buildMonitorContentsPanel,
  buildSwitchGroupPanel,
  layoutServer,
  measurePayload,
  monitorContents,
  switchGroupState,
  toPanelPayload,
  trimText,
  upkeepState,
  type AlarmRowState,
  type CameraRowState,
  type MonitorRowState,
  type PanelMessage,
  type ServerLayoutState,
  type SwitchGroupRowState,
  type SwitchRowState,
} from "./panels.js";

function monitor(items: Array<[itemId: number, quantity: number]>): EntityInfo {
  return {
    entityId: 1,
    type: "storageMonitor",
    capacity: 24,
    items: items.map(([itemId, quantity]) => ({ itemId, quantity, itemIsBlueprint: false })),
  };
}

describe("upkeepState", () => {
  it("tells a protected tool cupboard, a spent one and a plain box apart", () => {
    expect(upkeepState({ hasProtection: true, protectionExpiry: 1_700_000_000 })).toBe("protected");
    expect(upkeepState({ hasProtection: true, protectionExpiry: 0 })).toBe("decaying");
    expect(upkeepState({ hasProtection: true })).toBe("decaying");
    expect(upkeepState({ hasProtection: false, protectionExpiry: 0 })).toBe("none");
    expect(upkeepState({})).toBe("none");
  });
});

describe("monitorContents", () => {
  it("reads a tool cupboard like the in-game upkeep list", () => {
    const tc = monitor([
      [-151838493, 451],
      [69511070, 100],
      [-151838493, 49],
    ]);

    expect(monitorContents(tc)).toBe("Wood ×500 · Metal Fragments ×100");
  });

  it("shows an item the table does not know by its id", () => {
    expect(monitorContents(monitor([[123, 2]]))).toBe("#123 ×2");
  });

  it("lists only as many items as asked, then how many more", () => {
    const tc = monitor([
      [-151838493, 3],
      [69511070, 2],
      [123, 1],
    ]);
    expect(monitorContents(tc, 1)).toBe("Wood ×3 · +2 more");
  });
});

describe("alarm notification-level select", () => {
  type Option = { label: string; value: string; default?: boolean; emoji?: { name?: string } };
  function notifyOptions(notificationLevel?: "silent" | "active" | "everyone"): Option[] {
    const panel = buildAlarmSettingsPanel({
      serverHandle: "s",
      entityHandle: "e",
      label: "Gate",
      notificationLevel,
      pushoverConfigured: true,
    });
    const notifyId = buildCustomId({ domain: "alarm", action: "notify", server: "s", entity: "e" });
    const components = panel.toJSON().components as Array<{
      components?: Array<{ custom_id?: string; options?: Option[] }>;
    }>;
    const select = components
      .flatMap((c) => c.components ?? [])
      .find((c) => c.custom_id === notifyId);
    return select?.options ?? [];
  }

  it("lists the four levels, quietest first, and marks Normal selected for an unset alarm", () => {
    const options = notifyOptions(undefined);
    expect(options.map((o) => [o.label, o.value, o.emoji?.name])).toEqual([
      ["Silent", "silent", "🔕"],
      ["Normal (default)", "default", "🔔"],
      ["Active", "active", "📣"],
      ["Everyone", "everyone", "📢"],
    ]);
    expect(options.filter((o) => o.default).map((o) => o.value)).toEqual(["default"]);
  });

  it("marks a stored level selected", () => {
    expect(notifyOptions("silent").find((o) => o.default)?.value).toBe("silent");
  });
});

// ── layoutServer ─────────────────────────────────────────────────────────────

/** A name far longer than any panel shows, with markdown and emoji in it. */
const LONG_NAME = `**Very* _long_ name 🔌 ${"with lots of words ".repeat(20)}`.trim();

/** Every item the game knows, longest names first: the heaviest possible box. */
const HEAVY_ITEMS = [...ITEM_NAMES]
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 48)
  .map(([itemId], i) => ({ itemId, quantity: 1_000_000 + i, itemIsBlueprint: false }));

function switchRow(i: number, overrides: Partial<SwitchRowState> = {}): SwitchRowState {
  return {
    kind: "switch",
    entityHandle: `sw${i}`,
    label: `Switch ${i}`,
    lock: { phase: "synced", value: i % 2 === 0, buttonsDisabled: false },
    ...overrides,
  };
}

function alarmRow(i: number, overrides: Partial<AlarmRowState> = {}): AlarmRowState {
  return {
    entityHandle: `al${i}`,
    label: `Alarm ${i}`,
    firing: false,
    paging: false,
    ...overrides,
  };
}

function monitorRow(i: number, overrides: Partial<MonitorRowState> = {}): MonitorRowState {
  return { entityHandle: `mo${i}`, label: `Box ${i}`, watch: false, ...overrides };
}

function cameraRow(i: number, overrides: Partial<CameraRowState> = {}): CameraRowState {
  return { entityHandle: `ca${i}`, label: `Cam ${i}`, ...overrides };
}

function bigTeam(size: number, name: string): TeamInfo {
  return {
    leaderSteamId: "1",
    members: Array.from({ length: size }, (_, i) => ({
      steamId: String(i + 1),
      name: `${name} ${i}`,
      x: 0,
      y: 0,
      isOnline: i % 2 === 0,
      spawnTime: 0,
      isAlive: true,
      deathTime: 0,
    })),
  };
}

function baseState(overrides: Partial<ServerLayoutState> = {}): ServerLayoutState {
  return {
    serverHandle: "srv",
    name: "Rusty Fat Cat",
    status: "connected",
    info: { players: 1, maxPlayers: 10, queuedPlayers: 0 } as ServerLayoutState["info"],
    switches: [],
    alarms: [],
    monitors: [],
    cameras: [],
    ...overrides,
  };
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** A component tree as plain JSON, for walking. */
interface Node {
  type?: number;
  content?: string;
  custom_id?: string;
  label?: string;
  disabled?: boolean;
  accent_color?: number;
  emoji?: { name?: string };
  options?: { label: string; value: string }[];
  components?: Node[];
  accessory?: Node;
}

function nodes(message: PanelMessage): Node[] {
  const out: Node[] = [];
  const visit = (node: Node | undefined): void => {
    if (!node) return;
    out.push(node);
    node.components?.forEach(visit);
    visit(node.accessory);
  };
  (message.payload.components as Node[]).forEach(visit);
  return out;
}

const texts = (m: PanelMessage): string[] =>
  nodes(m)
    .filter((n) => n.type === 10)
    .map((n) => n.content ?? "");
const buttons = (m: PanelMessage): Node[] => nodes(m).filter((n) => n.type === 2);
const selects = (m: PanelMessage): Node[] => nodes(m).filter((n) => n.type === 3);
const container = (m: PanelMessage): Node => m.payload.components[0] as Node;

/** Every message within Discord's limits, measured independently of the layout's own count. */
function expectWithinBudget(messages: PanelMessage[]): void {
  for (const m of messages) {
    const measured = measurePayload(m.payload);
    expect(measured).toEqual(m.budget);
    const galleryItems = nodes(m).reduce(
      (sum, n) => sum + ((n as { items?: unknown[] }).items?.length ?? 0),
      0,
    );
    expect(nodes(m).filter((n) => typeof n.type === "number").length + galleryItems).toBe(
      measured.components,
    );
    expect(texts(m).join("").length).toBe(measured.text);
    expect(measured.components, `${m.kind} ${m.page}`).toBeLessThanOrEqual(MESSAGE_MAX_COMPONENTS);
    expect(measured.text, `${m.kind} ${m.page}`).toBeLessThanOrEqual(MESSAGE_MAX_TEXT);
    // Custom IDs must be unique within a message.
    const ids = nodes(m)
      .map((n) => n.custom_id)
      .filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    for (const select of selects(m)) {
      expect(select.options!.length).toBeGreaterThan(0);
      expect(select.options!.length).toBeLessThanOrEqual(25);
      for (const o of select.options!) expect(o.label.length).toBeLessThanOrEqual(100);
    }
  }
}

describe("layoutServer: messages and order", () => {
  it("lays out only the Server message for a server without devices", () => {
    const messages = layoutServer(baseState());
    expect(messages.map((m) => m.kind)).toEqual(["server"]);
    expect(texts(messages[0])[0]).toBe("### Rusty Fat Cat\n🟢 Online · 1/10 players · queue 0");
    expect(buttons(messages[0]).map((b) => [b.label, b.disabled])).toEqual([["Refresh", false]]);
  });

  it("posts Server, Switches, Alarms, Storage, Cameras, each only when it has a device", () => {
    const all = layoutServer(
      baseState({
        switches: [switchRow(1)],
        alarms: [alarmRow(1)],
        monitors: [monitorRow(1)],
        cameras: [cameraRow(1)],
      }),
    );
    expect(all.map((m) => m.kind)).toEqual(["server", "switches", "alarms", "storage", "cameras"]);

    const some = layoutServer(baseState({ monitors: [monitorRow(1)], switches: [switchRow(1)] }));
    expect(some.map((m) => m.kind)).toEqual(["server", "switches", "storage"]);
  });

  it("ends every device-type message with one Manage select listing that page's devices", () => {
    const messages = layoutServer(
      baseState({ switches: [switchRow(1), switchRow(2)], alarms: [alarmRow(1)] }),
    );
    const [, switches, alarms] = messages;
    expect(selects(switches).map((s) => s.custom_id)).toEqual([
      buildCustomId({ domain: "switch", action: "manage", server: "srv" }),
    ]);
    expect(selects(switches)[0].options!.map((o) => [o.label, o.value])).toEqual([
      ["Switch 1", "sw1"],
      ["Switch 2", "sw2"],
      ["New group…", NEW_GROUP_OPTION],
    ]);
    expect(selects(alarms)[0].custom_id).toBe(
      buildCustomId({ domain: "alarm", action: "manage", server: "srv" }),
    );
  });

  it("makes every button grey with one emoji", () => {
    const messages = layoutServer(
      baseState({
        switches: [
          switchRow(1),
          switchRow(2),
          switchRow(3, { lock: { phase: "synced", buttonsDisabled: false } }),
        ],
        monitors: [monitorRow(1)],
        cameras: [cameraRow(1)],
      }),
    );
    for (const b of messages.flatMap(buttons)) {
      expect((b as { style?: number }).style).toBe(2);
      expect(b.emoji?.name).toBeTruthy();
    }
  });
});

describe("layoutServer: switch rows", () => {
  const rowOf = (row: SwitchRowState, status: ServerLayoutState["status"] = "connected") => {
    const switches = layoutServer(baseState({ status, switches: [row] }))[1];
    return { text: texts(switches)[1], button: buttons(switches)[0] };
  };
  const id = (action: string) =>
    buildCustomId({ domain: "switch", action, server: "srv", entity: "sw1" });

  it("an On switch offers ❌ Turn off with an explicit off target", () => {
    const { text, button } = rowOf(
      switchRow(1, { lock: { phase: "synced", value: true, buttonsDisabled: false } }),
    );
    expect(text).toBe("🔌 **Switch 1** · 🟢 On");
    expect([button.emoji?.name, button.label, button.custom_id, button.disabled]).toEqual([
      "❌",
      "Turn off",
      id("off"),
      false,
    ]);
  });

  it("an Off switch offers ✅ Turn on with an explicit on target", () => {
    const { text, button } = rowOf(
      switchRow(1, { lock: { phase: "synced", value: false, buttonsDisabled: false } }),
    );
    expect(text).toBe("🔌 **Switch 1** · 🔴 Off");
    expect([button.emoji?.name, button.label, button.custom_id]).toEqual([
      "✅",
      "Turn on",
      id("on"),
    ]);
  });

  it("an unknown switch is never guessed: ⚪ Unknown with 🔄 Refresh", () => {
    const { text, button } = rowOf(
      switchRow(1, { lock: { phase: "synced", buttonsDisabled: false } }),
    );
    expect(text).toBe("🔌 **Switch 1** · ⚪ Unknown");
    expect([button.emoji?.name, button.label, button.custom_id]).toEqual([
      "🔄",
      "Refresh",
      id("refresh"),
    ]);
  });

  it("a pending click shows what was asked for, and a disabled ⏳ Waiting…", () => {
    const { text, button } = rowOf(
      switchRow(1, {
        lock: { phase: "pending", value: false, requested: true, buttonsDisabled: true },
      }),
    );
    expect(text).toBe("🔌 **Switch 1** · ⏳ Switching on…");
    expect([button.label, button.disabled]).toEqual(["Waiting…", true]);
  });

  it("shows the auto-revert under the switch", () => {
    const { text } = rowOf(
      switchRow(1, {
        lock: { phase: "synced", value: true, buttonsDisabled: false },
        autoAction: "off",
        autoDelaySeconds: 30,
      }),
    );
    expect(text).toBe("🔌 **Switch 1** · 🟢 On\n-# auto-off after 30s");
  });

  it("reconnecting keeps the state and disables the button", () => {
    const { text, button } = rowOf(
      switchRow(1, { lock: { phase: "synced", value: true, buttonsDisabled: false } }),
      "reconnecting",
    );
    expect(text).toBe("🔌 **Switch 1** · 🟢 On");
    expect(button.disabled).toBe(true);
  });

  it("offline says last reported and disables the button", () => {
    const { text, button } = rowOf(
      switchRow(1, { lock: { phase: "synced", value: false, buttonsDisabled: false } }),
      "offline",
    );
    expect(text).toBe("🔌 **Switch 1** · last reported 🔴 Off");
    expect(button.disabled).toBe(true);
  });

  it("escapes markdown in a name so it cannot break the row", () => {
    const { text } = rowOf(switchRow(1, { label: "a*b_c" }));
    expect(text).toBe("🔌 **a\\*b\\_c** · 🔴 Off");
  });
});

describe("layoutServer: server, alarms, storage and cameras", () => {
  it("offline: red accent, last seen, no team, and every action disabled", () => {
    const messages = layoutServer(
      baseState({
        status: "offline",
        lastSeenAt: 1_700_000_000_000,
        team: bigTeam(2, "dfx"),
        switches: [switchRow(1)],
        monitors: [monitorRow(1)],
        cameras: [cameraRow(1)],
      }),
    );
    expect(texts(messages[0])).toEqual([
      "### Rusty Fat Cat\n🔴 Offline · last seen <t:1700000000:R>",
    ]);
    for (const m of messages) {
      expect(container(m).accent_color).toBe(0xf23f43);
      for (const b of buttons(m)) expect(b.disabled).toBe(true);
    }
  });

  it("reconnecting: yellow accent, the last known numbers and team, Refresh disabled", () => {
    const [server] = layoutServer(baseState({ status: "reconnecting", team: bigTeam(1, "dfx") }));
    expect(texts(server)).toEqual([
      "### Rusty Fat Cat\n🟡 Reconnecting… · 1/10 players · queue 0",
      "-# Team: 🟢 dfx 0 👑",
    ]);
    expect(container(server).accent_color).toBe(0xf0b232);
    expect(buttons(server)[0].disabled).toBe(true);
  });

  it("a manual refresh shows ⏳ Refreshing… and then the game clock", () => {
    const [busy] = layoutServer(baseState({ refreshing: true }));
    expect([buttons(busy)[0].label, buttons(busy)[0].disabled]).toEqual(["Refreshing…", true]);
    const [done] = layoutServer(baseState({ timeLabel: "12:30" }));
    expect(texts(done)[0]).toContain("queue 0 · 🕑 12:30");
  });

  it("a failed status read says why", () => {
    const [server] = layoutServer(baseState({ info: undefined, statusNote: "⚠️ Couldn't" }));
    expect(texts(server)[0]).toBe("### Rusty Fat Cat\n🟢 Online · ⚠️ Couldn't");
  });

  it("the team line marks the leader and the connected account", () => {
    const [server] = layoutServer(baseState({ team: bigTeam(2, "p"), connectedSteamId: "2" }));
    expect(texts(server)[1]).toBe("-# Team: 🟢 p 0 👑 · ⚪ p 1 📶");
  });

  it("a firing alarm turns its line and its message red", () => {
    const [, alarms] = layoutServer(
      baseState({ alarms: [alarmRow(1, { firing: true, paging: true }), alarmRow(2)] }),
    );
    expect(texts(alarms).slice(1)).toEqual([
      "🚨 **Alarm 1** · **firing** · paging on",
      "🔔 **Alarm 2** · quiet · paging off",
    ]);
    expect(container(alarms).accent_color).toBe(0xf23f43);
    const [, quiet] = layoutServer(baseState({ alarms: [alarmRow(1)] }));
    expect(container(quiet).accent_color).toBe(0x5865f2);
  });

  it("a storage row shows slots, upkeep, watch and a short item summary, with 🔍 Contents", () => {
    const info = {
      ...monitor([
        [-151838493, 2900],
        [69511070, 100],
      ]),
      protectionExpiry: 1_700_000_000,
    };
    const [, storage] = layoutServer(
      baseState({ monitors: [monitorRow(1, { info, watch: true })] }),
    );
    expect(texts(storage)[1]).toBe(
      "📦 **Box 1** · 2/24 slots · 🛡️ upkeep ends <t:1700000000:R> · 👁 watching\n-# Wood ×2,900 · Metal Fragments ×100",
    );
    expect(buttons(storage).map((b) => [b.label, b.custom_id])).toEqual([
      [
        "Contents",
        buildCustomId({ domain: "monitor", action: "contents", server: "srv", entity: "mo1" }),
      ],
    ]);
  });

  it("a tool cupboard whose upkeep is spent shows it is decaying", () => {
    const info = { ...monitor([]), hasProtection: true, protectionExpiry: 0 };
    const [, storage] = layoutServer(baseState({ monitors: [monitorRow(1, { info })] }));
    expect(texts(storage)[1]).toBe(
      "📦 **Box 1** · 0/24 slots · ⚠️ **no upkeep: decaying**\n-# Empty",
    );
    const contents = JSON.stringify(
      toPanelPayload(buildMonitorContentsPanel({ label: "TC", info })),
    );
    expect(contents).toContain("⚠️ Upkeep: none left, the base is decaying");
  });

  it("a monitor not read yet says so instead of claiming it is empty", () => {
    const [, storage] = layoutServer(baseState({ monitors: [monitorRow(1)] }));
    expect(texts(storage)[1]).toBe("📦 **Box 1** · contents unknown");
  });

  it("a camera row offers 📷 Capture", () => {
    const [, cameras] = layoutServer(baseState({ cameras: [cameraRow(1)] }));
    expect(texts(cameras)).toEqual(["### 📷 Cameras", "📷 **Cam 1**"]);
    expect(buttons(cameras).map((b) => b.custom_id)).toEqual([
      buildCustomId({ domain: "camera", action: "capture", server: "srv", entity: "ca1" }),
    ]);
  });
});

describe("layoutServer: budget (≤ 40 components, ≤ 4,000 characters)", () => {
  it("fits 11 switches on one page, and pages the 12th", () => {
    const eleven = layoutServer(baseState({ switches: range(11).map((i) => switchRow(i)) }));
    expect(eleven.map((m) => m.kind)).toEqual(["server", "switches"]);
    expect(texts(eleven[1])[0]).toBe("### 🔌 Switches");
    expectWithinBudget(eleven);

    const twelve = layoutServer(baseState({ switches: range(12).map((i) => switchRow(i)) }));
    expect(twelve.filter((m) => m.kind === "switches").map((m) => texts(m)[0])).toEqual([
      "### 🔌 Switches 1/2",
      "### 🔌 Switches 2/2",
    ]);
    expect(selects(twelve[2])[0].options!.map((o) => o.value)).toEqual(["sw11", NEW_GROUP_OPTION]);
    expectWithinBudget(twelve);
  });

  it("with a banner, a page holds 10 switches", () => {
    const messages = layoutServer(baseState({ switches: range(11).map((i) => switchRow(i)) }), {
      bannerUrl: "https://example.com/banner.png",
    });
    expect(messages.filter((m) => m.kind === "switches").map((m) => m.pages)).toEqual([2, 2]);
    expect(nodes(messages[1]).filter((n) => n.type === 12)).toHaveLength(1);
    expectWithinBudget(messages);
  });

  it("30 switches with very long names, auto-revert and every state fit three pages", () => {
    const states: SwitchRowState["lock"][] = [
      { phase: "synced", value: true, buttonsDisabled: false },
      { phase: "synced", value: false, buttonsDisabled: false },
      { phase: "synced", buttonsDisabled: false },
      { phase: "pending", value: true, requested: false, buttonsDisabled: true },
    ];
    for (const status of ["connected", "reconnecting", "offline"] as const) {
      const messages = layoutServer(
        baseState({
          status,
          name: LONG_NAME.repeat(4),
          team: bigTeam(40, LONG_NAME),
          switches: range(30).map((i) =>
            switchRow(i, {
              label: `${LONG_NAME} ${i}`,
              lock: states[i % states.length],
              autoAction: i % 2 ? "on" : "off",
              autoDelaySeconds: 86_400,
            }),
          ),
        }),
        { bannerUrl: "https://example.com/banner.png" },
      );
      expect(messages.filter((m) => m.kind === "switches")).toHaveLength(3);
      expectWithinBudget(messages);
    }
  });

  it("long names are trimmed with an ellipsis, never cut mid-emoji", () => {
    const [, switches] = layoutServer(
      baseState({ switches: [switchRow(1, { label: LONG_NAME })] }),
    );
    const row = texts(switches)[1];
    expect(row).toMatch(/…\*\* · /);
    expect(row).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(trimText("🔌🔌🔌", 3)).toBe("🔌…");
    expect(trimText("🔌🔌🔌", 4)).toBe("🔌…");
  });

  it("60 firing alarms with long names page by 25", () => {
    const messages = layoutServer(
      baseState({
        alarms: range(60).map((i) =>
          alarmRow(i, { label: `${LONG_NAME} ${i}`, firing: true, paging: true }),
        ),
      }),
    );
    expect(
      messages.filter((m) => m.kind === "alarms").map((m) => selects(m)[0].options!.length),
    ).toEqual([25, 25, 10]);
    expectWithinBudget(messages);
  });

  it("30 full storage monitors with long names fit, trimming the item lists", () => {
    const info: EntityInfo = {
      entityId: 1,
      type: "storageMonitor",
      capacity: 48,
      items: HEAVY_ITEMS,
      protectionExpiry: 1_700_000_000,
    };
    const messages = layoutServer(
      baseState({
        monitors: range(30).map((i) =>
          monitorRow(i, { label: `${LONG_NAME} ${i}`, info, watch: true }),
        ),
      }),
      { bannerUrl: "https://example.com/banner.png" },
    );
    expect(messages.filter((m) => m.kind === "storage")).toHaveLength(3);
    expectWithinBudget(messages);
    // Still says what is inside, as far as it fits.
    expect(texts(messages[1])[1]).toContain("+");
  });

  it("30 cameras with long names fit three pages", () => {
    const messages = layoutServer(
      baseState({ cameras: range(30).map((i) => cameraRow(i, { label: `${LONG_NAME} ${i}` })) }),
    );
    expect(messages.filter((m) => m.kind === "cameras")).toHaveLength(3);
    expectWithinBudget(messages);
  });

  it("a huge team is cut to fit, saying how many more", () => {
    const [server] = layoutServer(baseState({ team: bigTeam(500, LONG_NAME) }));
    expect(texts(server)[1]).toMatch(/\+\d+ more$/);
    expectWithinBudget([server]);
  });
});

// ── switch groups ────────────────────────────────────────────────────────────

const ON: SwitchRowState["lock"] = { phase: "synced", value: true, buttonsDisabled: false };
const OFF: SwitchRowState["lock"] = { phase: "synced", value: false, buttonsDisabled: false };
const UNKNOWN: SwitchRowState["lock"] = { phase: "synced", buttonsDisabled: false };
const pendingTo = (requested: boolean): SwitchRowState["lock"] => ({
  phase: "pending",
  value: !requested,
  requested,
  buttonsDisabled: true,
});

/** A group row whose members hold these locks (member n of group i is `g{i}m{n}`). */
function groupRow(
  i: number,
  locks: SwitchRowState["lock"][],
  overrides: Partial<SwitchGroupRowState> = {},
): SwitchGroupRowState {
  return {
    kind: "group",
    groupHandle: `gr${i}`,
    label: `Group ${i}`,
    members: locks.map((lock, n) => ({ entityHandle: `g${i}m${n}`, label: `Member ${n}`, lock })),
    ...overrides,
  };
}

/** A group of ten members in every state, with a long name. */
const fullGroup = (i: number): SwitchGroupRowState =>
  groupRow(
    i,
    range(10).map((n) => [ON, OFF, UNKNOWN, pendingTo(true)][n % 4]!),
    { label: `${LONG_NAME} ${i}` },
  );

describe("switchGroupState: only confirmed states count", () => {
  it("is On or Off only when every member is confirmed so", () => {
    expect(switchGroupState([ON, ON, ON])).toEqual({ kind: "on" });
    expect(switchGroupState([OFF, OFF])).toEqual({ kind: "off" });
  });

  it("is mixed when every member is confirmed but they differ", () => {
    expect(switchGroupState([ON, OFF, ON])).toEqual({ kind: "mixed", on: 2, total: 3 });
  });

  it("is unknown when any member is unknown, whatever the others say", () => {
    expect(switchGroupState([ON, ON, UNKNOWN])).toEqual({ kind: "unknown" });
    expect(switchGroupState([])).toEqual({ kind: "unknown" });
  });

  it("is pending while any member's click is in flight, naming one shared target", () => {
    expect(switchGroupState([pendingTo(true), ON, UNKNOWN])).toEqual({
      kind: "pending",
      requested: true,
    });
    expect(switchGroupState([pendingTo(true), pendingTo(false)])).toEqual({ kind: "pending" });
  });
});

describe("layoutServer: switch group rows", () => {
  const rowOf = (row: SwitchGroupRowState, status: ServerLayoutState["status"] = "connected") => {
    const switches = layoutServer(baseState({ status, switches: [row] }))[1];
    return { text: texts(switches)[1], button: buttons(switches)[0] };
  };
  const id = (action: string) =>
    buildCustomId({ domain: "group", action, server: "srv", entity: "gr1" });

  it("confirmed On: the name, member count and ❌ Turn off with an explicit off target", () => {
    const { text, button } = rowOf(groupRow(1, [ON, ON, ON]));
    expect(text).toBe("🔌 **Group 1** (3) · 🟢 On");
    expect([button.emoji?.name, button.label, button.custom_id, button.disabled]).toEqual([
      "❌",
      "Turn off",
      id("off"),
      false,
    ]);
  });

  it("confirmed Off offers ✅ Turn on", () => {
    const { text, button } = rowOf(groupRow(1, [OFF, OFF]));
    expect(text).toBe("🔌 **Group 1** (2) · 🔴 Off");
    expect([button.emoji?.name, button.label, button.custom_id]).toEqual([
      "✅",
      "Turn on",
      id("on"),
    ]);
  });

  it("mixed shows how many are on and offers ✅ Turn on", () => {
    const { text, button } = rowOf(groupRow(1, [ON, OFF, ON]));
    expect(text).toBe("🔌 **Group 1** (3) · 🟡 2/3 on");
    expect([button.label, button.custom_id]).toEqual(["Turn on", id("on")]);
  });

  it("any unknown member makes it ⚪ Unknown with 🔄 Refresh, never a guess", () => {
    const { text, button } = rowOf(groupRow(1, [ON, UNKNOWN]));
    expect(text).toBe("🔌 **Group 1** (2) · ⚪ Unknown");
    expect([button.emoji?.name, button.label, button.custom_id]).toEqual([
      "🔄",
      "Refresh",
      id("refresh"),
    ]);
  });

  it("a pending click shows what was asked for, and a disabled ⏳ Waiting…", () => {
    const { text, button } = rowOf(groupRow(1, [pendingTo(false), ON]));
    expect(text).toBe("🔌 **Group 1** (2) · ⏳ Switching off…");
    expect([button.label, button.custom_id, button.disabled]).toEqual([
      "Waiting…",
      id("off"),
      true,
    ]);
  });

  it("offline says last reported and disables; reconnecting disables", () => {
    const offline = rowOf(groupRow(1, [ON, OFF]), "offline");
    expect(offline.text).toBe("🔌 **Group 1** (2) · last reported 🟡 1/2 on");
    expect(offline.button.disabled).toBe(true);
    expect(rowOf(groupRow(1, [ON]), "reconnecting").button.disabled).toBe(true);
  });

  it("the Manage select lists the group, then its members, then New group…", () => {
    const [, switches] = layoutServer(
      baseState({ switches: [switchRow(1), groupRow(2, [ON, OFF])] }),
    );
    const options = selects(switches)[0].options! as {
      label: string;
      value: string;
      description?: string;
    }[];
    expect(options.map((o) => [o.label, o.value])).toEqual([
      ["Switch 1", "sw1"],
      ["Group 2", "gr2"],
      ["↳ Member 0", "g2m0"],
      ["↳ Member 1", "g2m1"],
      ["New group…", NEW_GROUP_OPTION],
    ]);
    expect(options[1].description).toBe("Group of 2 switches");
    expect(options[2].description).toBe("In Group 2");
  });
});

describe("layoutServer: budget and pagination with switch groups", () => {
  it("a group row costs what a switch row costs: 11 rows a page, the 12th pages", () => {
    const eleven = layoutServer(
      baseState({
        switches: range(11).map((i) =>
          i % 2 ? fullGroup(i) : switchRow(i, { label: `${LONG_NAME} ${i}` }),
        ),
      }),
    );
    expect(eleven.filter((m) => m.kind === "switches")).toHaveLength(1);
    expectWithinBudget(eleven);

    const twelve = layoutServer(baseState({ switches: range(12).map(fullGroup) }));
    expect(twelve.filter((m) => m.kind === "switches").map((m) => m.pages)).toEqual([2, 2]);
    expectWithinBudget(twelve);
  });

  it("lists a group's members in the select only while all 25 options fit", () => {
    // 11 groups of 10: 11 rows and New group leave room for one group's members.
    const [, page] = layoutServer(baseState({ switches: range(11).map(fullGroup) }));
    const values = selects(page)[0].options!.map((o) => o.value);
    expect(values).toHaveLength(11 + 10 + 1);
    expect(values.filter((v) => v.startsWith("g0m"))).toHaveLength(10);
    expect(values.filter((v) => v.startsWith("g1m"))).toHaveLength(0);
    expect(values.at(-1)).toBe(NEW_GROUP_OPTION);
  });

  it("30 rows of groups and switches, in every state and connection, fit three pages", () => {
    for (const status of ["connected", "reconnecting", "offline"] as const) {
      const messages = layoutServer(
        baseState({
          status,
          switches: range(30).map((i) =>
            i % 3 ? fullGroup(i) : switchRow(i, { label: `${LONG_NAME} ${i}`, autoAction: "off" }),
          ),
        }),
        { bannerUrl: "https://example.com/banner.png" },
      );
      expect(messages.filter((m) => m.kind === "switches")).toHaveLength(3);
      expectWithinBudget(messages);
    }
  });
});

describe("switch group panel (ephemeral)", () => {
  const asMessage = (container: ReturnType<typeof buildSwitchGroupPanel>): PanelMessage => {
    const payload = toPanelPayload(container);
    return { kind: "switches", page: 0, pages: 1, payload, budget: measurePayload(payload) };
  };

  it("shows each member's state with its own button, and the group's admin controls", () => {
    const message = asMessage(
      buildSwitchGroupPanel({
        serverHandle: "srv",
        groupHandle: "gr1",
        name: "Turrets",
        status: "connected",
        members: groupRow(1, [ON, UNKNOWN]).members,
      }),
    );
    expect(texts(message)).toEqual([
      "## 🔌 Turrets\n2 switches · ⚪ Unknown",
      "🔌 **Member 0** · 🟢 On",
      "🔌 **Member 1** · ⚪ Unknown",
    ]);
    const member = (action: string, entity: string) =>
      buildCustomId({ domain: "switch", action, server: "srv", entity });
    const group = (action: string) =>
      buildCustomId({ domain: "group", action, server: "srv", entity: "gr1" });
    expect(buttons(message).map((b) => b.custom_id)).toEqual([
      member("off", "g1m0"),
      member("refresh", "g1m1"),
      group("rename"),
      group("members"),
      group("delete"),
    ]);
    expect(selects(message).map((s) => [s.custom_id, s.options!.map((o) => o.value)])).toEqual([
      [group("member"), ["g1m0", "g1m1"]],
    ]);
  });

  it("fits one message with ten members with long names", () => {
    const message = asMessage(
      buildSwitchGroupPanel({
        serverHandle: "srv",
        groupHandle: "gr1",
        name: LONG_NAME,
        status: "offline",
        members: fullGroup(1).members.map((m) => ({
          ...m,
          label: LONG_NAME,
          autoAction: "off" as const,
          autoDelaySeconds: 3600,
        })),
      }),
    );
    expectWithinBudget([message]);
    expect(message.budget.components).toBe(MESSAGE_MAX_COMPONENTS);
    for (const b of buttons(message).slice(0, 10)) expect(b.disabled).toBe(true);
  });
});
