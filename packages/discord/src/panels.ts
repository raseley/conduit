/**
 * Components V2 panel builders.
 *
 * Each server's persistent **Conduit Panel** is laid out by {@link layoutServer}:
 * a Server message plus one message per device type, posted once and
 * then only edited. The other builders here make the ephemeral panels (Setup
 * hub, each device's settings, a monitor's contents, a camera frame).
 * Every builder is a **pure function**: given domain state (from bot-core) and
 * the handles that mint customIds, it returns a {@link ContainerBuilder} (the
 * V2 `IS_COMPONENTS_V2` container of text/section/separator/media + action
 * rows), which {@link toPanelPayload} wraps as a message payload.
 *
 * Classic `content`/`embeds` are never mixed into a V2 panel.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ComponentType,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  SectionBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  escapeMarkdown,
  type APIMessageTopLevelComponent,
} from "discord.js";

import { SWITCH_AUTO_DELAY_DEFAULT } from "@conduit/bot-core";
import type {
  AlarmNotificationLevel,
  EntityInfo,
  PushoverSeverity,
  ServerConnectionStatus,
  ServerInfo,
  SwitchAutoAction,
  TeamInfo,
} from "@conduit/bot-core";

import { buildCustomId } from "./customId.js";
import { itemName } from "./items.js";
import type { LockSnapshot } from "./state-lock.js";

/** Discord Blurple — the `brand` accent for every panel. */
const ACCENT = 0x5865f2;
const ACCENT_DOWN = 0xf23f43;
const ACCENT_IDLE = 0xf0b232;

/**
 * The message payload shape for a V2 panel: a single container, flagged
 * `IsComponentsV2`. Attachments (camera/map media) are added by the adapter.
 */
export interface PanelPayload {
  components: APIMessageTopLevelComponent[];
  flags: number;
}

/** Wrap a built container into a sendable/editable V2 message payload. */
export function toPanelPayload(container: ContainerBuilder): PanelPayload {
  return {
    components: [container.toJSON()],
    flags: MessageFlags.IsComponentsV2,
  };
}

function statusDot(online: boolean): string {
  return online ? "🟢" : "🔴";
}

/** Per-member presence dot: a hollow circle for offline (distinct from the server's 🔴). */
function memberDot(online: boolean): string {
  return online ? "🟢" : "⚪";
}

// ── Server status panel ───────────────────────────────────────────────────────

/** A Discord timestamp that each client shows relative ("2 minutes ago") and keeps current. */
function relativeTime(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

// ── Smart switch panel — state-lock buttons ───────────────────────────────────

/** Auto-revert mode options for the per-switch select (incl. "none" = off). */
const SWITCH_AUTO_OPTIONS: {
  label: string;
  value: SwitchAutoAction | "none";
  emoji: string;
}[] = [
  { label: "Disabled", value: "none", emoji: "🚫" },
  { label: "Auto-off — turn OFF after delay", value: "off", emoji: "🔴" },
  { label: "Auto-on — turn ON after delay", value: "on", emoji: "🟢" },
];

/** One-line summary of a switch's current auto-revert configuration. */
function autoRevertSummary(autoAction: SwitchAutoAction | undefined, delay: number): string {
  if (autoAction === "off") return `Auto-revert: 🔴 turns OFF ${delay}s after switching ON`;
  if (autoAction === "on") return `Auto-revert: 🟢 turns ON ${delay}s after switching OFF`;
  return "Auto-revert: 🚫 Disabled";
}

/**
 * The per-switch **Settings** menu, opened ephemerally from the Switches
 * message's "Manage a switch…" select. Carries the admin controls (Rename, the
 * timed auto-revert mode and delay, Remove), keeping the always-visible row
 * down to its state and one button.
 */
export function buildSwitchSettingsPanel(args: {
  serverHandle: string;
  entityHandle: string;
  label: string;
  /** This switch's timed auto-revert mode, if enabled. */
  autoAction?: SwitchAutoAction;
  /** This switch's auto-revert delay in seconds (defaults to the global default). */
  autoDelaySeconds?: number;
}): ContainerBuilder {
  const { serverHandle, entityHandle, label, autoAction } = args;
  const delay = args.autoDelaySeconds ?? SWITCH_AUTO_DELAY_DEFAULT;
  const selected = autoAction ?? "none";
  return new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 🔌 ${label}`),
      new TextDisplayBuilder().setContent("⚙ Settings"),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildCustomId({
              domain: "switch",
              action: "name",
              server: serverHandle,
              entity: entityHandle,
            }),
          )
          .setLabel("Rename")
          .setEmoji("✏")
          .setStyle(ButtonStyle.Secondary),
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(autoRevertSummary(autoAction, delay)),
    )
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(
            buildCustomId({
              domain: "switch",
              action: "auto",
              server: serverHandle,
              entity: entityHandle,
            }),
          )
          .setPlaceholder("Timed auto-revert")
          .addOptions(
            SWITCH_AUTO_OPTIONS.map((o) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(o.label)
                .setValue(o.value)
                .setEmoji(o.emoji)
                .setDefault(o.value === selected),
            ),
          ),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildCustomId({
              domain: "switch",
              action: "delay",
              server: serverHandle,
              entity: entityHandle,
            }),
          )
          .setLabel(`Delay: ${delay}s`)
          .setEmoji("⏱")
          .setStyle(ButtonStyle.Secondary),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildCustomId({
              domain: "switch",
              action: "remove",
              server: serverHandle,
              entity: entityHandle,
            }),
          )
          .setLabel("Remove device")
          .setEmoji("🗑")
          .setStyle(ButtonStyle.Danger),
      ),
    );
}

/** The device domains whose settings offer Remove. */
export type RemovableDomain = "switch" | "alarm" | "monitor" | "camera";

const DOMAIN_EMOJI: Record<RemovableDomain, string> = {
  switch: "🔌",
  alarm: "🔔",
  monitor: "📦",
  camera: "📷",
};

/**
 * A two-button confirmation shown (via in-place `update`) when an admin clicks
 * **Remove device** in a device's settings. Removing a device is destructive
 * (it leaves the panel and its pairing is forgotten), so it takes a deliberate
 * second click. Cancel returns to the settings.
 */
export function buildRemoveConfirmPanel(args: {
  domain: RemovableDomain;
  serverHandle: string;
  entityHandle: string;
  label: string;
}): ContainerBuilder {
  const { domain, serverHandle, entityHandle, label } = args;
  return new ContainerBuilder()
    .setAccentColor(ACCENT_DOWN)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${DOMAIN_EMOJI[domain]} ${escapeMarkdown(trimText(label, 100))}`,
      ),
      new TextDisplayBuilder().setContent(
        "🗑 **Remove this device?** It leaves the panel and its pairing is forgotten. You can add it again later.",
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildCustomId({
              domain,
              action: "remove-confirm",
              server: serverHandle,
              entity: entityHandle,
            }),
          )
          .setLabel("Remove")
          .setEmoji("🗑")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(
            buildCustomId({
              domain,
              action: "remove-cancel",
              server: serverHandle,
              entity: entityHandle,
            }),
          )
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
}

/** The note shown in place of a settings menu once its device has been removed. */
export function buildRemovedNoticePanel(label: string): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(ACCENT_IDLE)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🗑 Removed **${escapeMarkdown(trimText(label, 100))}**. Add it again from Setup to control it again.`,
      ),
    );
}

// ── Switch group panels (ephemeral) ───────────────────────────────────────────

/**
 * A switch group's own panel, opened ephemerally by choosing the group in the
 * Switches message's "Manage a switch…" select. Shows each member's confirmed
 * state with its own Turn on / Turn off (the same buttons as a switch row), and
 * the group's Rename / Edit members / Delete, plus a "Member settings…" select
 * that reaches every member's own settings.
 *
 * Fits one message for up to `SWITCH_GROUP_MAX_MEMBERS` (10) members: 10
 * components besides the members' Sections, 3 per member.
 */
export function buildSwitchGroupPanel(args: {
  serverHandle: string;
  groupHandle: string;
  name: string;
  status: ServerConnectionStatus;
  members: readonly SwitchGroupMember[];
}): ContainerBuilder {
  const { serverHandle, groupHandle, name, status, members } = args;
  const id = (action: string) =>
    buildCustomId({ domain: "group", action, server: serverHandle, entity: groupHandle });
  const state = switchGroupStateText(switchGroupState(members.map((m) => m.lock)), status);
  const n = members.length;
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🔌 ${escapeMarkdown(trimText(name, 100))}\n${n} switch${n === 1 ? "" : "es"} · ${state}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  for (const member of members) {
    container.addSectionComponents(
      switchRow({ kind: "switch", ...member }, serverHandle, status, FIT_LEVELS[0].name),
    );
  }
  return container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(id("rename"))
          .setLabel("Rename")
          .setEmoji("✏")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(id("members"))
          .setLabel("Edit members")
          .setEmoji("👥")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(id("delete"))
          .setLabel("Delete group")
          .setEmoji("🗑")
          .setStyle(ButtonStyle.Danger),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(id("member"))
          .setPlaceholder("Member settings…")
          .addOptions(
            members.map((m) =>
              selectOption({ value: m.entityHandle, label: m.label, emoji: "🔌" }),
            ),
          ),
      ),
    );
}

/**
 * Pick a switch group's members: a native multi-select of the server's
 * switches that are in no other group, for a new group (after its name) or to
 * edit one. `cancelId`, when set, adds a Cancel button back to the group.
 */
export function buildSwitchGroupPickerPanel(args: {
  heading: string;
  /** The multi-select's custom ID. */
  selectId: string;
  /** Switches that may join, in display order; `selected` are the current members. */
  options: readonly { entityHandle: string; label: string; selected?: boolean }[];
  /** Most members a group may have. */
  maxMembers: number;
  cancelId?: string;
}): ContainerBuilder {
  const options = args.options.slice(0, SELECT_MAX_OPTIONS);
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🔌 ${escapeMarkdown(trimText(args.heading, 100))}\n` +
          `Pick up to ${args.maxMembers} switches. Switches in another group aren't listed.`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(args.selectId)
          .setPlaceholder("Choose the switches")
          .setMinValues(1)
          .setMaxValues(Math.max(1, Math.min(args.maxMembers, options.length)))
          .addOptions(
            options.map((o) =>
              selectOption({ value: o.entityHandle, label: o.label, emoji: "🔌" }).setDefault(
                Boolean(o.selected),
              ),
            ),
          ),
      ),
    );
  if (args.cancelId) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(args.cancelId)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return container;
}

/** Delete a switch group? A deliberate second click; Cancel returns to the group. */
export function buildGroupDeleteConfirmPanel(args: {
  serverHandle: string;
  groupHandle: string;
  name: string;
}): ContainerBuilder {
  const id = (action: string) =>
    buildCustomId({ domain: "group", action, server: args.serverHandle, entity: args.groupHandle });
  return new ContainerBuilder()
    .setAccentColor(ACCENT_DOWN)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 🔌 ${escapeMarkdown(trimText(args.name, 100))}`),
      new TextDisplayBuilder().setContent(
        "🗑 **Delete this group?** Its switches stay paired and get their own rows again.",
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(id("delete-confirm"))
          .setLabel("Delete")
          .setEmoji("🗑")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(id("delete-cancel"))
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
}

/** A one-line ephemeral notice in place of a group panel (deleted, gone). */
export function buildGroupNoticePanel(text: string): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(ACCENT_IDLE)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
}

// ── Smart alarm panel ─────────────────────────────────────────────────────────

/** Pushover severity options for the per-alarm select (incl. "off"). */
const PUSHOVER_SEVERITY_OPTIONS: {
  label: string;
  value: PushoverSeverity | "off";
  emoji: string;
}[] = [
  { label: "Off", value: "off", emoji: "🚫" },
  { label: "Low", value: "low", emoji: "🟢" },
  { label: "Medium", value: "medium", emoji: "🟡" },
  { label: "High", value: "high", emoji: "🔴" },
];

/**
 * Notification-level options for the per-alarm select, quietest first.
 * `"default"` is Normal: it stands for an unset level (and clears it).
 */
const NOTIFICATION_LEVEL_OPTIONS: readonly {
  label: string;
  value: AlarmNotificationLevel | "default";
  emoji: string;
}[] = [
  { label: "Silent", value: "silent", emoji: "🔕" },
  { label: "Normal (default)", value: "default", emoji: "🔔" },
  { label: "Active", value: "active", emoji: "📣" },
  { label: "Everyone", value: "everyone", emoji: "📢" },
];

/**
 * The per-alarm **Settings** menu, opened ephemerally from the Alarms
 * message's "Manage an alarm…" select: Rename, the notification level, the
 * Pushover priority and Remove, so the always-visible alarm line stays compact.
 */
export function buildAlarmSettingsPanel(args: {
  serverHandle: string;
  entityHandle: string;
  label: string;
  /** This alarm's notification level (how its line notifies on fire), if set. */
  notificationLevel?: AlarmNotificationLevel;
  /** This alarm's opted-in Pushover severity, if any. */
  pushoverSeverity?: PushoverSeverity;
  /** Whether global Pushover credentials are configured. */
  pushoverConfigured: boolean;
}): ContainerBuilder {
  const {
    serverHandle,
    entityHandle,
    label,
    notificationLevel,
    pushoverSeverity,
    pushoverConfigured,
  } = args;
  const selected = pushoverSeverity ?? "off";
  const selectedNotify = notificationLevel ?? "default";
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 🔔 ${label}`),
      new TextDisplayBuilder().setContent("⚙ Settings"),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildCustomId({
              domain: "alarm",
              action: "name",
              server: serverHandle,
              entity: entityHandle,
            }),
          )
          .setLabel("Rename")
          .setEmoji("✏")
          .setStyle(ButtonStyle.Secondary),
      ),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("Notification level"))
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(
            buildCustomId({
              domain: "alarm",
              action: "notify",
              server: serverHandle,
              entity: entityHandle,
            }),
          )
          .setPlaceholder("How the logging channel notifies when this alarm fires")
          .addOptions(
            NOTIFICATION_LEVEL_OPTIONS.map((o) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(o.label)
                .setValue(o.value)
                .setEmoji(o.emoji)
                .setDefault(o.value === selectedNotify),
            ),
          ),
      ),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("Paging priority"));
  if (!pushoverConfigured) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("_Configure Pushover in Setup to enable paging._"),
    );
  }
  return container
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(
            buildCustomId({
              domain: "alarm",
              action: "severity",
              server: serverHandle,
              entity: entityHandle,
            }),
          )
          .setPlaceholder("Pushover alert priority")
          .setDisabled(!pushoverConfigured)
          .addOptions(
            PUSHOVER_SEVERITY_OPTIONS.map((o) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(o.label)
                .setValue(o.value)
                .setEmoji(o.emoji)
                .setDefault(o.value === selected),
            ),
          ),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildCustomId({
              domain: "alarm",
              action: "remove",
              server: serverHandle,
              entity: entityHandle,
            }),
          )
          .setLabel("Remove device")
          .setEmoji("🗑")
          .setStyle(ButtonStyle.Danger),
      ),
    );
}

// ── Storage monitor and camera panels (ephemeral) ─────────────────────────────

/** How many distinct items {@link monitorContents} lists by default before "+N more". */
const MONITOR_ITEMS_SHOWN = 8;

/**
 * A storage monitor's contents, one entry per item with its stacks summed
 * (a tool cupboard holds wood in several stacks), largest first. The protocol
 * carries item ids only; {@link itemName} turns them into the game's names.
 */
export function monitorContents(info: EntityInfo, shownMax = MONITOR_ITEMS_SHOWN): string {
  const totals = new Map<number, number>();
  for (const item of info.items) {
    totals.set(item.itemId, (totals.get(item.itemId) ?? 0) + item.quantity);
  }
  if (totals.size === 0) return "Empty";
  const sorted = [...totals].sort((a, b) => b[1] - a[1]);
  const shown = sorted
    .slice(0, shownMax)
    .map(([itemId, quantity]) => `${itemName(itemId)} ×${quantity.toLocaleString("en-US")}`);
  const more = sorted.length - shownMax;
  return more > 0 ? `${shown.join(" · ")} · +${more} more` : shown.join(" · ");
}

/** The items of a storage monitor, one line each, largest first; "Empty" when none. */
function monitorItemLines(info: EntityInfo): string {
  const totals = new Map<number, number>();
  for (const item of info.items) {
    totals.set(item.itemId, (totals.get(item.itemId) ?? 0) + item.quantity);
  }
  if (totals.size === 0) return "Empty";
  return [...totals]
    .sort((a, b) => b[1] - a[1])
    .map(([itemId, quantity]) => `${itemName(itemId)} ×${quantity.toLocaleString("en-US")}`)
    .join("\n");
}

/**
 * Where a storage monitor stands on upkeep: `none` for a plain box, `protected`
 * for a tool cupboard whose upkeep runs to a reported expiry, `decaying` for a
 * tool cupboard (`hasProtection`) that reports no expiry, its upkeep spent.
 */
export type UpkeepState = "none" | "protected" | "decaying";

/**
 * How often an unwatched tool cupboard's row is redrawn as its upkeep is paid.
 * Each payment changes the cupboard's contents, a broadcast every few minutes;
 * redrawing on each would spend Discord's cap on edits to messages older than
 * an hour, which every panel shares. The first change this long after the
 * Storage message was last drawn from a monitor's contents redraws it; a change
 * of {@link UpkeepState} redraws at once.
 */
export const UPKEEP_REPAINT_INTERVAL_MS = 15 * 60_000;

/** A storage monitor's {@link UpkeepState}, from its protection fields. */
export function upkeepState(
  info: Pick<EntityInfo, "hasProtection" | "protectionExpiry">,
): UpkeepState {
  if (info.protectionExpiry && info.protectionExpiry > 0) return "protected";
  return info.hasProtection ? "decaying" : "none";
}

/** "7/29 slots", and a tool cupboard's upkeep, for the monitor's own panels. */
function monitorSummary(info: EntityInfo | undefined): string {
  if (!info) return "Contents unknown: press Refresh";
  const lines = [`${info.items.length}/${info.capacity ?? 0} slots`];
  // A plain box has no upkeep, and shows no line for it.
  switch (upkeepState(info)) {
    case "protected":
      lines.push(
        `🛡️ Upkeep: protected until <t:${info.protectionExpiry}:f> (<t:${info.protectionExpiry}:R>)`,
      );
      break;
    case "decaying":
      lines.push("⚠️ Upkeep: none left, the base is decaying");
      break;
    case "none":
      break;
  }
  return lines.join("\n");
}

/**
 * A storage monitor's full contents, the ephemeral answer to its row's 🔍
 * Contents button: slots, upkeep and every item. A box holds at most 48
 * stacks, so it always fits one message.
 */
export function buildMonitorContentsPanel(args: {
  label: string;
  info?: EntityInfo;
}): ContainerBuilder {
  const { label, info } = args;
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 📦 ${escapeMarkdown(trimText(label, 100))}`),
    );
  if (!info) {
    return container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "Contents unknown: open **Manage a monitor…** and press Refresh.",
      ),
    );
  }
  return container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(monitorSummary(info)))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(monitorItemLines(info)));
}

/**
 * A storage monitor's **Settings**, opened ephemerally from the Storage
 * message's "Manage a monitor…" select: Watch, Refresh, Rename and Remove.
 */
export function buildMonitorSettingsPanel(args: {
  serverHandle: string;
  entityHandle: string;
  label: string;
  info?: EntityInfo;
  watch: boolean;
}): ContainerBuilder {
  const { serverHandle, entityHandle, label, info, watch } = args;
  const id = (action: string) =>
    buildCustomId({ domain: "monitor", action, server: serverHandle, entity: entityHandle });
  return new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 📦 ${escapeMarkdown(trimText(label, 100))}`),
      new TextDisplayBuilder().setContent("⚙ Settings"),
      new TextDisplayBuilder().setContent(monitorSummary(info)),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(id("watch"))
          .setLabel(`Watch: ${watch ? "ON" : "OFF"}`)
          .setEmoji("👁")
          .setStyle(watch ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(id("refresh"))
          .setLabel("Refresh")
          .setEmoji("🔄")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(id("name"))
          .setLabel("Rename")
          .setEmoji("✏")
          .setStyle(ButtonStyle.Secondary),
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        info && upkeepState(info) !== "none"
          ? "-# Watch: each change updates the panel and is written to the logging channel, " +
              "for a tool cupboard every upkeep payment. Off, its upkeep still updates the " +
              `panel (at most every ${UPKEEP_REPAINT_INTERVAL_MS / 60_000} minutes, at once ` +
              "when protection starts or ends) without a line."
          : "-# Watch: each change updates the panel and is written to the logging channel.",
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(id("remove"))
          .setLabel("Remove device")
          .setEmoji("🗑")
          .setStyle(ButtonStyle.Danger),
      ),
    );
}

/**
 * A camera's **Settings**, opened ephemerally from the Cameras message's
 * "Manage a camera…" select: Rename and Remove.
 */
export function buildCameraSettingsPanel(args: {
  serverHandle: string;
  entityHandle: string;
  label: string;
}): ContainerBuilder {
  const { serverHandle, entityHandle, label } = args;
  const id = (action: string) =>
    buildCustomId({ domain: "camera", action, server: serverHandle, entity: entityHandle });
  return new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 📷 ${escapeMarkdown(trimText(label, 100))}`),
      new TextDisplayBuilder().setContent("⚙ Settings"),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(id("name"))
          .setLabel("Rename")
          .setEmoji("✏")
          .setStyle(ButtonStyle.Secondary),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(id("remove"))
          .setLabel("Remove device")
          .setEmoji("🗑")
          .setStyle(ButtonStyle.Danger),
      ),
    );
}

/**
 * A captured camera still: posted to the logging channel, or shown ephemerally
 * to the member who pressed 📷 Capture when there is no logging channel.
 */
export function buildCameraFramePanel(args: {
  label: string;
  /** Attachment filename to reference as media. */
  frameAttachment: string;
  capturedLabel: string;
  /**
   * Who pressed Capture, as it should appear after "captured … by" (a
   * `<@id>` mention, for the logging channel). Omitted, no credit line.
   */
  capturedBy?: string;
}): ContainerBuilder {
  const { label, frameAttachment, capturedLabel, capturedBy } = args;
  const credit = capturedBy ? ` by ${capturedBy}` : "";
  return new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 📷 ${escapeMarkdown(trimText(label, 100))}`),
    )
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${frameAttachment}`),
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# captured ${capturedLabel}${credit}`),
    );
}

/**
 * Ephemeral server picker shown when "Add camera" is clicked and more than one
 * server is paired. Each option's value is the server's handle; selecting it opens
 * the add-camera modal bound to that server (submitted under `setup:cameraAdd`).
 */
export function buildCameraServerSelectPanel(
  servers: readonly { handle: string; name: string }[],
): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("## 📷 Add a camera"),
      new TextDisplayBuilder().setContent("Which server is this camera on?"),
    )
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildCustomId({ domain: "setup", action: "cameraServer" }))
          .setPlaceholder("Pick a server")
          .addOptions(
            servers.map((s) =>
              new StringSelectMenuOptionBuilder().setLabel(s.name).setValue(s.handle),
            ),
          ),
      ),
    );
}

// ── Setup hub panel (native selects) ──────────────────────────────────────────

/** The most roles each of the Setup hub's role selects takes. */
const ROLE_SELECT_MAX = 10;

export function buildSetupPanel(args: {
  controlChannelId?: string;
  loggingChannelId?: string;
  /** The chosen admin and user roles, shown selected in their role selects. */
  adminRoleIds?: readonly string[];
  userRoleIds?: readonly string[];
  startOnLogin: boolean;
  /** Whether global Pushover credentials are configured. */
  pushoverConfigured: boolean;
}): ContainerBuilder {
  const { controlChannelId, loggingChannelId, startOnLogin, pushoverConfigured } = args;
  const roleSelect = (action: string, placeholder: string, ids: readonly string[] = []) => {
    const select = new RoleSelectMenuBuilder()
      .setCustomId(buildCustomId({ domain: "setup", action }))
      .setPlaceholder(placeholder)
      .setMinValues(0)
      .setMaxValues(ROLE_SELECT_MAX);
    // Discord rejects more defaults than the select can hold.
    const defaults = [...new Set(ids)].slice(0, ROLE_SELECT_MAX);
    return defaults.length > 0 ? select.setDefaultRoles(defaults) : select;
  };
  return new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("## ⚙ Conduit Setup"),
      new TextDisplayBuilder().setContent(
        controlChannelId ? `Control channel: <#${controlChannelId}>` : "Control channel: _not set_",
      ),
      new TextDisplayBuilder().setContent(
        loggingChannelId ? `Logging channel: <#${loggingChannelId}>` : "Logging channel: _not set_",
      ),
      new TextDisplayBuilder().setContent(
        `Pushover: ${pushoverConfigured ? "configured ✓" : "_not set_"}`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(buildCustomId({ domain: "setup", action: "channel" }))
          .setChannelTypes(ChannelType.GuildText)
          .setPlaceholder("Pick the control channel"),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(buildCustomId({ domain: "setup", action: "logChannel" }))
          .setChannelTypes(ChannelType.GuildText)
          .setPlaceholder("Pick the logging channel (optional)"),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        roleSelect("adminRoles", "Admin roles", args.adminRoleIds),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        roleSelect("userRoles", "User roles", args.userRoleIds),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildCustomId({ domain: "setup", action: "addCamera" }))
          .setLabel("Add camera")
          .setEmoji("📷")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(buildCustomId({ domain: "setup", action: "repost" }))
          .setLabel("Rebuild panels")
          .setEmoji("📋")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildCustomId({ domain: "setup", action: "pushover" }))
          .setLabel("Pushover…")
          .setEmoji("📲")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildCustomId({ domain: "setup", action: "startOnLogin" }))
          .setLabel(`Start on login: ${startOnLogin ? "ON" : "OFF"}`)
          .setStyle(ButtonStyle.Secondary),
      ),
    );
}

// ── Conduit Panel: one message per device type, per server ────────────────────

/** Discord's cap on the components of one message, nested ones included. */
export const MESSAGE_MAX_COMPONENTS = 40;
/** Discord's cap on the text of all Text Display components of one message. */
export const MESSAGE_MAX_TEXT = 4000;
/** Discord's cap on the options of one select menu. */
export const SELECT_MAX_OPTIONS = 25;

/**
 * The banner strip at the top of each panel message: an image URL, or
 * `undefined` for none. Off until a layout check on a real server shows one is
 * needed; turning it on is this one line (or `layoutServer`'s `bannerUrl`).
 * Its components are budgeted for: row capacity is computed with it.
 */
export const PANEL_BANNER_URL: string | undefined = undefined;
/** What a banner costs: a Media Gallery and its one item. */
const BANNER_COMPONENTS = 2;

/**
 * The components every device-type message has besides its rows: the
 * container, the heading, two separators, and the action row holding the
 * "Manage…" select plus the select itself.
 */
const TYPE_MESSAGE_FIXED_COMPONENTS = 6;

/**
 * What one row of the Switches message costs: a Section, its Text Display and
 * its button. A switch group row has the same shape, so it costs the same.
 */
export const SWITCH_ROW_COMPONENTS = 3;

/** What a storage monitor's or a camera's row costs: a Section, its text, its button. */
const SECTION_ROW_COMPONENTS = 3;

/** What an alarm's line costs: one Text Display. */
const ALARM_ROW_COMPONENTS = 1;

/** The messages of a server's Conduit Panel, in the order they are posted. */
export type PanelKind = "server" | "switches" | "alarms" | "storage" | "cameras";

/** Every {@link PanelKind}, in posting order. */
export const PANEL_KINDS: readonly PanelKind[] = [
  "server",
  "switches",
  "alarms",
  "storage",
  "cameras",
];

/**
 * One row of the Switches message: a single switch, or a switch group.
 * Every row kind is one Section of {@link SWITCH_ROW_COMPONENTS} components,
 * built by {@link switchesRow}, so groups leave pagination unchanged.
 */
export type SwitchesRow = SwitchRowState | SwitchGroupRowState;

/** One member of a switch group, as its group row and its group panel show it. */
export interface SwitchGroupMember {
  entityHandle: string;
  label: string;
  /** What the state lock holds for this member. */
  lock: LockSnapshot;
  /** The member's own timed auto-revert, if enabled (it applies per member). */
  autoAction?: SwitchAutoAction;
  /** The member's auto-revert delay in seconds. */
  autoDelaySeconds?: number;
}

/** A switch group's row: "🔌 **Turrets** (3) · 🟢 On", one button for every member. */
export interface SwitchGroupRowState {
  kind: "group";
  groupHandle: string;
  label: string;
  /** The members, in the group's order. Never empty. */
  members: readonly SwitchGroupMember[];
}

/**
 * A switch group's state, from its members' locks. Only confirmed values
 * count: `on`/`off` when every member is confirmed so, `mixed` when every
 * member is confirmed but they differ, `unknown` when any member's state is
 * unknown, and `pending` while any member's click is in flight.
 */
export type SwitchGroupState =
  | { kind: "pending"; requested?: boolean }
  | { kind: "unknown" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "mixed"; on: number; total: number };

/** Aggregate a switch group's members' locks into {@link SwitchGroupState}. Pure. */
export function switchGroupState(members: readonly LockSnapshot[]): SwitchGroupState {
  const pending = members.filter((m) => m.phase === "pending");
  if (pending.length > 0) {
    const asked = new Set(pending.map((m) => m.requested));
    const [requested] = [...asked];
    return asked.size === 1 && requested !== undefined
      ? { kind: "pending", requested }
      : { kind: "pending" };
  }
  if (members.length === 0 || members.some((m) => m.value === undefined)) {
    return { kind: "unknown" };
  }
  const on = members.filter((m) => m.value === true).length;
  if (on === members.length) return { kind: "on" };
  if (on === 0) return { kind: "off" };
  return { kind: "mixed", on, total: members.length };
}

/**
 * A group state as text: "🟢 On", "🔴 Off", "🟡 2/3 on", "⚪ Unknown", or
 * "⏳ Switching on…". Offline, a confirmed state is "last reported".
 */
function switchGroupStateText(state: SwitchGroupState, status: ServerConnectionStatus): string {
  let shown: string;
  switch (state.kind) {
    case "pending":
      return state.requested === undefined
        ? "⏳ Switching…"
        : `⏳ Switching ${state.requested ? "on" : "off"}…`;
    case "unknown":
      return "⚪ Unknown";
    case "on":
      shown = "🟢 On";
      break;
    case "off":
      shown = "🔴 Off";
      break;
    case "mixed":
      shown = `🟡 ${state.on}/${state.total} on`;
      break;
  }
  return status === "offline" ? `last reported ${shown}` : shown;
}

/**
 * The value of the "Manage a switch…" option that starts a new switch group.
 * A handle is base-36, so it can never be this.
 */
export const NEW_GROUP_OPTION = "+new";

/** A single smart switch's row. */
export interface SwitchRowState {
  kind: "switch";
  entityHandle: string;
  label: string;
  /** What the state lock holds: the confirmed value, or a pending click. */
  lock: LockSnapshot;
  /** Timed auto-revert, if enabled. */
  autoAction?: SwitchAutoAction;
  /** Auto-revert delay in seconds (defaults to the global default). */
  autoDelaySeconds?: number;
}

/** A smart alarm's line. */
export interface AlarmRowState {
  entityHandle: string;
  label: string;
  /** The alarm last reported itself on (sounding). */
  firing: boolean;
  /** Pushover paging is live for it: credentials configured and a priority chosen. */
  paging: boolean;
}

/** A storage monitor's row. */
export interface MonitorRowState {
  entityHandle: string;
  label: string;
  /** Its latest contents, when read. */
  info?: EntityInfo;
  /** Whether its changes are announced (Watch). */
  watch: boolean;
}

/** A camera's row. */
export interface CameraRowState {
  entityHandle: string;
  label: string;
  /**
   * While set, a capture was just taken: Capture is disabled until this time
   * (ms epoch), which the row shows as a countdown, so a camera can't be spammed.
   */
  cooldownUntil?: number;
}

/** Everything one server's Conduit Panel shows. Rows are in display order. */
export interface ServerLayoutState {
  serverHandle: string;
  name: string;
  /** The connection, as bot-core reports it. */
  status: ServerConnectionStatus;
  /** When the connection was last live (ms epoch); shown while offline. */
  lastSeenAt?: number;
  /** Players/queue: live when connected, the last known while reconnecting. */
  info?: ServerInfo;
  /** Team roster: live when connected, the last known while reconnecting. */
  team?: TeamInfo;
  /** SteamID of the account Rust+ is connected through (📶 in the team line). */
  connectedSteamId?: string;
  /** The in-game clock; only a manual Refresh shows it, to spend fewer edits. */
  timeLabel?: string;
  /** A manual Refresh is in flight: "⏳ Refreshing…", disabled. */
  refreshing?: boolean;
  /** Shown instead of players/queue when the status request failed. */
  statusNote?: string;
  switches: readonly SwitchesRow[];
  alarms: readonly AlarmRowState[];
  monitors: readonly MonitorRowState[];
  cameras: readonly CameraRowState[];
}

/** Options for {@link layoutServer}. */
export interface LayoutOptions {
  /** Banner image for the top of each message; defaults to {@link PANEL_BANNER_URL}. */
  bannerUrl?: string;
}

/** A message's size, as Discord counts it. */
export interface PayloadBudget {
  /** Components, nested ones included (Media Gallery items counted too). */
  components: number;
  /** Characters across all Text Display components (UTF-16 units, an upper bound). */
  text: number;
}

/** One message of a server's Conduit Panel. */
export interface PanelMessage {
  kind: PanelKind;
  /** 0-based page of its kind; a kind has more than one only when its rows overflow. */
  page: number;
  /** How many pages its kind has. */
  pages: number;
  payload: PanelPayload;
  budget: PayloadBudget;
}

/**
 * How much detail a message keeps; {@link layoutServer} steps down these until
 * a message fits. Name lengths in characters; item and member counts.
 */
interface FitLevel {
  name: number;
  items: number;
  team: number;
}
const FIT_LEVELS: readonly FitLevel[] = [
  { name: 48, items: 3, team: 24 },
  { name: 32, items: 2, team: 12 },
  { name: 20, items: 1, team: 6 },
  { name: 12, items: 0, team: 3 },
];

/** The longest server name the Server message shows. */
const SERVER_NAME_MAX = 100;
/** The longest team member name the team line shows. */
const MEMBER_NAME_MAX = 32;
/** Discord's cap on a select option's label. */
const OPTION_LABEL_MAX = 100;

/**
 * Lay out one server's Conduit Panel: the Server message, then one message per
 * device type the server has (Switches, Alarms, Storage, Cameras; a type with
 * no devices has none), each paginated ("Switches 1/2") when its rows do not
 * fit one message. Pure: the adapter posts the result once and then only edits
 * it.
 *
 * Every message is measured exactly and kept within Discord's limits
 * ({@link MESSAGE_MAX_COMPONENTS} components, {@link MESSAGE_MAX_TEXT}
 * characters): rows per page come from the component budget, and long names,
 * item lists and team rosters are trimmed until the text fits.
 */
export function layoutServer(
  state: ServerLayoutState,
  options: LayoutOptions = {},
): PanelMessage[] {
  const banner = "bannerUrl" in options ? options.bannerUrl : PANEL_BANNER_URL;
  const messages: PanelMessage[] = [
    { kind: "server", page: 0, pages: 1, ...fit((level) => serverMessage(state, level, banner)) },
  ];
  const live = state.status === "connected";
  const accent = groupAccent(state.status);
  const { serverHandle } = state;

  const addPages = <Row extends object>(
    kind: Exclude<PanelKind, "server">,
    rows: readonly Row[],
    rowComponents: number,
    build: (rows: Row[], pageLabel: string, level: FitLevel) => ContainerBuilder,
  ): void => {
    const pages = paginate(rows, rowsPerPage(rowComponents, banner));
    pages.forEach((pageRows, page) => {
      const pageLabel = pages.length > 1 ? ` ${page + 1}/${pages.length}` : "";
      messages.push({
        kind,
        page,
        pages: pages.length,
        ...fit((level) => build(pageRows, pageLabel, level)),
      });
    });
  };

  addPages("switches", state.switches, SWITCH_ROW_COMPONENTS, (rows, pageLabel, level) =>
    typeMessage({
      heading: `### 🔌 Switches${pageLabel}`,
      accent,
      banner,
      rows: rows.map((row) => switchesRow(row, serverHandle, state.status, level)),
      select: manageSelect("switch", serverHandle, "Manage a switch…", switchManageOptions(rows)),
    }),
  );
  addPages("alarms", state.alarms, ALARM_ROW_COMPONENTS, (rows, pageLabel, level) =>
    typeMessage({
      heading: `### 🔔 Alarms${pageLabel}`,
      // A sounding alarm turns its message red.
      accent: rows.some((r) => r.firing) ? ACCENT_DOWN : accent,
      banner,
      rows: rows.map((row) => new TextDisplayBuilder().setContent(alarmLine(row, level))),
      select: manageSelect("alarm", serverHandle, "Manage an alarm…", deviceOptions(rows, "🔔")),
    }),
  );
  addPages("storage", state.monitors, SECTION_ROW_COMPONENTS, (rows, pageLabel, level) =>
    typeMessage({
      heading: `### 📦 Storage${pageLabel}`,
      accent,
      banner,
      rows: rows.map((row) =>
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(monitorRowText(row, level)))
          .setButtonAccessory(
            rowButton({
              id: buildCustomId({
                domain: "monitor",
                action: "contents",
                server: serverHandle,
                entity: row.entityHandle,
              }),
              label: "Contents",
              emoji: "🔍",
              disabled: !live,
            }),
          ),
      ),
      select: manageSelect("monitor", serverHandle, "Manage a monitor…", deviceOptions(rows, "📦")),
    }),
  );
  addPages("cameras", state.cameras, SECTION_ROW_COMPONENTS, (rows, pageLabel, level) =>
    typeMessage({
      heading: `### 📷 Cameras${pageLabel}`,
      accent,
      banner,
      rows: rows.map((row) =>
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(cameraRowText(row, level)))
          .setButtonAccessory(
            rowButton({
              id: buildCustomId({
                domain: "camera",
                action: "capture",
                server: serverHandle,
                entity: row.entityHandle,
              }),
              label: "Capture",
              emoji: "📷",
              disabled: !live || row.cooldownUntil !== undefined,
            }),
          ),
      ),
      select: manageSelect("camera", serverHandle, "Manage a camera…", deviceOptions(rows, "📷")),
    }),
  );
  return messages;
}

/**
 * Count a payload as Discord does: every component, nested ones included, and
 * the characters of every Text Display. Media Gallery items are counted as
 * components too, to stay on the safe side.
 */
export function measurePayload(payload: PanelPayload): PayloadBudget {
  const budget: PayloadBudget = { components: 0, text: 0 };
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const c = node as {
      type?: unknown;
      content?: unknown;
      components?: unknown;
      accessory?: unknown;
      items?: unknown;
    };
    if (typeof c.type === "number") budget.components += 1;
    if (c.type === ComponentType.TextDisplay && typeof c.content === "string") {
      budget.text += c.content.length;
    }
    if (Array.isArray(c.components)) c.components.forEach(visit);
    if (c.accessory) visit(c.accessory);
    if (Array.isArray(c.items)) budget.components += c.items.length;
  };
  payload.components.forEach(visit);
  return budget;
}

/** Whether a measured payload is within Discord's limits for one message. */
export function withinBudget(budget: PayloadBudget): boolean {
  return budget.components <= MESSAGE_MAX_COMPONENTS && budget.text <= MESSAGE_MAX_TEXT;
}

/** Build a message at the most detailed level that fits. */
function fit(build: (level: FitLevel) => ContainerBuilder): {
  payload: PanelPayload;
  budget: PayloadBudget;
} {
  let payload = toPanelPayload(build(FIT_LEVELS[0]));
  let budget = measurePayload(payload);
  for (const level of FIT_LEVELS.slice(1)) {
    if (withinBudget(budget)) break;
    payload = toPanelPayload(build(level));
    budget = measurePayload(payload);
  }
  return { payload, budget };
}

/** How many rows of a given cost fit one message (and its select). */
function rowsPerPage(rowComponents: number, banner: string | undefined): number {
  const fixed = TYPE_MESSAGE_FIXED_COMPONENTS + (banner ? BANNER_COMPONENTS : 0);
  return Math.min(SELECT_MAX_OPTIONS, Math.floor((MESSAGE_MAX_COMPONENTS - fixed) / rowComponents));
}

function paginate<T>(rows: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < rows.length; i += size) pages.push(rows.slice(i, i + size));
  return pages;
}

/** The accent every message of a server shares: by its connection. */
function groupAccent(status: ServerConnectionStatus): number {
  return status === "connected" ? ACCENT : status === "reconnecting" ? ACCENT_IDLE : ACCENT_DOWN;
}

/**
 * Shorten user-chosen text to `max` characters on one line, ending in "…"
 * when cut. Counts UTF-16 units, as Discord's limits do, and never splits an
 * emoji.
 */
export function trimText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  let kept = "";
  for (const char of flat) {
    if (kept.length + char.length > max - 1) break;
    kept += char;
  }
  return `${kept.trimEnd()}…`;
}

/** A device name for a row: trimmed, markdown escaped, in bold. */
function boldName(label: string, max: number): string {
  return `**${escapeMarkdown(trimText(label, max))}**`;
}

function addBanner(container: ContainerBuilder, banner: string | undefined): void {
  if (!banner) return;
  container.addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(banner)),
  );
}

/** A row's grey button: one emoji and a short label, so widths come out close. */
/**
 * A camera's row text. While Capture is cooling down it adds when it is ready
 * again, as a Discord relative timestamp ("in 25 seconds") that counts down by
 * itself, so the panel needs no edit per second.
 */
function cameraRowText(row: CameraRowState, level: FitLevel): string {
  const name = `📷 ${boldName(row.label, level.name)}`;
  if (row.cooldownUntil === undefined) return name;
  return `${name} · ⏳ ready <t:${Math.ceil(row.cooldownUntil / 1000)}:R>`;
}

function rowButton(args: {
  id: string;
  label: string;
  emoji: string;
  disabled: boolean;
}): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(args.id)
    .setLabel(args.label)
    .setEmoji(args.emoji)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(args.disabled);
}

/** The shape every device-type message shares: heading, rows, "Manage…" select. */
function typeMessage(args: {
  heading: string;
  accent: number;
  banner: string | undefined;
  rows: (SectionBuilder | TextDisplayBuilder)[];
  select: ActionRowBuilder<StringSelectMenuBuilder>;
}): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(args.accent);
  addBanner(container, args.banner);
  container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(args.heading))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  for (const row of args.rows) {
    if (row instanceof SectionBuilder) container.addSectionComponents(row);
    else container.addTextDisplayComponents(row);
  }
  return container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(args.select);
}

/** One option of a "Manage a …" select. */
interface ManageOption {
  value: string;
  label: string;
  emoji: string;
  description?: string;
}

/** One option per device row, valued by its entity handle. */
function deviceOptions(
  rows: readonly { entityHandle: string; label: string }[],
  emoji: string,
): ManageOption[] {
  return rows.map((row) => ({ value: row.entityHandle, label: row.label, emoji }));
}

/**
 * The "Manage a switch…" options for one page: each row (a switch, or a
 * group by its group handle); after a group, its members as "↳ Name", while
 * the select's 25 options allow (a group's members are listed all or not at
 * all, and the group's own panel always reaches each of them); and last,
 * "➕ New group…".
 */
function switchManageOptions(rows: readonly SwitchesRow[]): ManageOption[] {
  let room = SELECT_MAX_OPTIONS - rows.length - 1;
  const options: ManageOption[] = [];
  for (const row of rows) {
    if (row.kind === "switch") {
      options.push({ value: row.entityHandle, label: row.label, emoji: "🔌" });
      continue;
    }
    const n = row.members.length;
    options.push({
      value: row.groupHandle,
      label: row.label,
      emoji: "🗂",
      description: `Group of ${n} switch${n === 1 ? "" : "es"}`,
    });
    if (n > room) continue;
    room -= n;
    for (const member of row.members) {
      options.push({
        value: member.entityHandle,
        label: `↳ ${trimText(member.label, OPTION_LABEL_MAX - 2)}`,
        emoji: "🔌",
        description: trimText(`In ${row.label}`, OPTION_LABEL_MAX),
      });
    }
  }
  options.push({ value: NEW_GROUP_OPTION, label: "New group…", emoji: "➕" });
  return options;
}

/**
 * The "Manage a …" select ending each device-type message. Choosing an option
 * opens that device's (or group's) settings ephemerally.
 */
function manageSelect(
  domain: "switch" | "alarm" | "monitor" | "camera",
  serverHandle: string,
  placeholder: string,
  options: readonly ManageOption[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildCustomId({ domain, action: "manage", server: serverHandle }))
      .setPlaceholder(placeholder)
      .addOptions(options.map(selectOption)),
  );
}

/** A select option from a {@link ManageOption}, its label and description trimmed. */
function selectOption(o: ManageOption): StringSelectMenuOptionBuilder {
  const option = new StringSelectMenuOptionBuilder()
    .setLabel(trimText(o.label, OPTION_LABEL_MAX) || "Unnamed")
    .setValue(o.value)
    .setEmoji(o.emoji);
  if (o.description) option.setDescription(trimText(o.description, OPTION_LABEL_MAX));
  return option;
}

/** The Server message: name, connection, players/queue, team, 🔄 Refresh. */
function serverMessage(
  state: ServerLayoutState,
  level: FitLevel,
  banner: string | undefined,
): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(groupAccent(state.status));
  addBanner(container, banner);
  const refreshing = Boolean(state.refreshing);
  container.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### ${escapeMarkdown(trimText(state.name, SERVER_NAME_MAX))}\n${serverStatusLine(state)}`,
        ),
      )
      .setButtonAccessory(
        rowButton({
          id: buildCustomId({ domain: "server", action: "refresh", server: state.serverHandle }),
          label: refreshing ? "Refreshing…" : "Refresh",
          emoji: refreshing ? "⏳" : "🔄",
          // Nothing to fetch unless connected; while reconnecting the client is on it.
          disabled: refreshing || state.status !== "connected",
        }),
      ),
  );
  // Offline: the last known roster is stale, so the message stays clean.
  const team = state.status === "offline" ? undefined : state.team;
  if (team && team.members.length > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(teamLine(team, state.connectedSteamId, level.team)),
    );
  }
  return container;
}

/** The Server message's status line, by connection. */
function serverStatusLine(state: ServerLayoutState): string {
  const { status, statusNote, timeLabel } = state;
  // Offline: the last known numbers are stale, so only when it was last seen.
  const info = status === "offline" ? undefined : state.info;
  const stats = info
    ? `${info.players}/${info.maxPlayers} players · queue ${info.queuedPlayers}`
    : undefined;
  switch (status) {
    case "connected":
      return [
        "🟢 Online",
        stats ?? statusNote ?? "fetching status…",
        ...(stats && timeLabel ? [`🕑 ${timeLabel}`] : []),
      ].join(" · ");
    case "reconnecting":
      return ["🟡 Reconnecting…", ...(stats ? [stats] : [])].join(" · ");
    case "offline":
      return state.lastSeenAt !== undefined
        ? `🔴 Offline · last seen ${relativeTime(state.lastSeenAt)}`
        : "🔴 Offline";
  }
}

/** "-# Team: 🟢 dfx 👑 · ⚪ bob": at most `max` members, then "+N more". */
function teamLine(team: TeamInfo, connectedSteamId: string | undefined, max: number): string {
  const shown = team.members.slice(0, max).map((m) => {
    const marks = [
      m.steamId === team.leaderSteamId ? "👑" : "",
      m.steamId === connectedSteamId ? "📶" : "",
    ].filter(Boolean);
    const name = escapeMarkdown(trimText(m.name, MEMBER_NAME_MAX));
    return `${memberDot(m.isOnline)} ${name}${marks.length ? ` ${marks.join(" ")}` : ""}`;
  });
  const more = team.members.length - shown.length;
  return `-# Team: ${shown.join(" · ")}${more > 0 ? ` · +${more} more` : ""}`;
}

/**
 * One row of the Switches message, by its kind: a switch or a switch group.
 * Each kind is one Section of {@link SWITCH_ROW_COMPONENTS}.
 */
function switchesRow(
  row: SwitchesRow,
  serverHandle: string,
  status: ServerConnectionStatus,
  level: FitLevel,
): SectionBuilder {
  switch (row.kind) {
    case "switch":
      return switchRow(row, serverHandle, status, level.name);
    case "group":
      return groupRow(row, serverHandle, status, level.name);
  }
}

/**
 * A switch group's row: "🔌 **Turrets** (3) · 🟢 On" and one grey button
 * acting on every member, with an explicit target. Confirmed On offers ❌ Turn
 * off; confirmed Off or mixed offers ✅ Turn on; unknown offers 🔄 Refresh
 * (re-reads the members); a pending click shows a disabled ⏳ Waiting…; and no
 * button works while the server is not connected.
 */
function groupRow(
  row: SwitchGroupRowState,
  serverHandle: string,
  status: ServerConnectionStatus,
  nameMax: number,
): SectionBuilder {
  const live = status === "connected";
  const id = (action: string) =>
    buildCustomId({ domain: "group", action, server: serverHandle, entity: row.groupHandle });
  const state = switchGroupState(row.members.map((m) => m.lock));
  let button: ButtonBuilder;
  switch (state.kind) {
    case "pending":
      button = rowButton({
        id: id(state.requested === undefined ? "refresh" : state.requested ? "on" : "off"),
        label: "Waiting…",
        emoji: "⏳",
        disabled: true,
      });
      break;
    case "unknown":
      button = rowButton({ id: id("refresh"), label: "Refresh", emoji: "🔄", disabled: !live });
      break;
    case "on":
      button = rowButton({ id: id("off"), label: "Turn off", emoji: "❌", disabled: !live });
      break;
    case "off":
    case "mixed":
      button = rowButton({ id: id("on"), label: "Turn on", emoji: "✅", disabled: !live });
      break;
  }
  const text = `🔌 ${boldName(row.label, nameMax)} (${row.members.length}) · ${switchGroupStateText(state, status)}`;
  return new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
    .setButtonAccessory(button);
}

/**
 * A switch's row: "🔌 **Name** · 🟢 On" (its auto-revert under it) and one grey
 * button with an explicit target. Never guesses: an unknown switch offers 🔄
 * Refresh, a pending click shows a disabled "⏳ Waiting…", and no button works
 * while the server is not connected.
 */
function switchRow(
  row: SwitchRowState,
  serverHandle: string,
  status: ServerConnectionStatus,
  nameMax: number,
): SectionBuilder {
  const { lock } = row;
  const on = lock.value;
  const live = status === "connected";
  const id = (action: string) =>
    buildCustomId({ domain: "switch", action, server: serverHandle, entity: row.entityHandle });

  let state: string;
  let button: ButtonBuilder;
  if (lock.phase === "pending") {
    state =
      lock.requested === undefined
        ? "⏳ Switching…"
        : `⏳ Switching ${lock.requested ? "on" : "off"}…`;
    button = rowButton({
      id: id(lock.requested === undefined ? "refresh" : lock.requested ? "on" : "off"),
      label: "Waiting…",
      emoji: "⏳",
      disabled: true,
    });
  } else if (on === undefined) {
    state = "⚪ Unknown";
    button = rowButton({ id: id("refresh"), label: "Refresh", emoji: "🔄", disabled: !live });
  } else {
    const shown = `${statusDot(on)} ${on ? "On" : "Off"}`;
    state = status === "offline" ? `last reported ${shown}` : shown;
    button = on
      ? rowButton({ id: id("off"), label: "Turn off", emoji: "❌", disabled: !live })
      : rowButton({ id: id("on"), label: "Turn on", emoji: "✅", disabled: !live });
  }

  let text = `🔌 ${boldName(row.label, nameMax)} · ${state}`;
  if (row.autoAction) {
    const delay = row.autoDelaySeconds ?? SWITCH_AUTO_DELAY_DEFAULT;
    text += `\n-# auto-${row.autoAction} after ${delay}s`;
  }
  return new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
    .setButtonAccessory(button);
}

/** "🔔 **Front door** · quiet · paging on", or 🚨 and **firing** while it sounds. */
function alarmLine(row: AlarmRowState, level: FitLevel): string {
  return [
    `${row.firing ? "🚨" : "🔔"} ${boldName(row.label, level.name)}`,
    row.firing ? "**firing**" : "quiet",
    `paging ${row.paging ? "on" : "off"}`,
  ].join(" · ");
}

/**
 * "📦 **TC** · 7/29 slots · 🛡️ upkeep ends <t:…:R> · 👁 watching" (or "⚠️ no
 * upkeep: decaying" for a tool cupboard whose upkeep is spent), and under it a
 * short summary of the items.
 */
function monitorRowText(row: MonitorRowState, level: FitLevel): string {
  const { info } = row;
  const parts = [`📦 ${boldName(row.label, level.name)}`];
  if (!info) {
    // Nothing read yet (server offline, or the read failed): don't claim "Empty".
    parts.push("contents unknown");
  } else {
    parts.push(`${info.items.length}/${info.capacity ?? 0} slots`);
    const upkeep = upkeepState(info);
    if (upkeep === "protected") {
      parts.push(`🛡️ upkeep ends ${relativeTime((info.protectionExpiry ?? 0) * 1000)}`);
    } else if (upkeep === "decaying") {
      parts.push("⚠️ **no upkeep: decaying**");
    }
  }
  if (row.watch) parts.push("👁 watching");
  const line = parts.join(" · ");
  return info && level.items > 0 ? `${line}\n-# ${monitorContents(info, level.items)}` : line;
}
