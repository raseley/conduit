/**
 * Audit-log line formatters.
 *
 * The logging channel (see `AppConfig.loggingChannelId`) receives a plain-text,
 * timestamped, append-only audit stream — every Discord interaction (with the
 * user who initiated it) and every in-game event the adapter observes. Unlike
 * the Components V2 panels in `panels.ts`, these are dumb one-line strings: no
 * buttons, no live editing.
 *
 * Each builder is a **pure function** — given a `time` plus the already-resolved
 * facts (label, user id, …), it returns a single line. All state lookups happen
 * in the adapter; nothing here touches bot-core or discord.js.
 */

/** Zero-pad to two digits. */
function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** `[HH:MM:SS]` from a Date, in local time (matches the prior event-panel labels). */
export function formatTimestamp(time: Date): string {
  return `[${pad2(time.getHours())}:${pad2(time.getMinutes())}:${pad2(time.getSeconds())}]`;
}

/** A Discord mention for the actor, falling back to a name or a literal. */
function actor(userId?: string, userName?: string): string {
  if (userId) return `<@${userId}>`;
  if (userName) return `@${userName}`;
  return "someone";
}

/** Common identity fields carried by every interaction-sourced line. */
export interface AuditActor {
  time: Date;
  userId?: string;
  userName?: string;
}

/** Generic component interaction (button/select) with no richer summary. */
export function auditInteraction(args: AuditActor & { summary: string }): string {
  return `${formatTimestamp(args.time)} 🎛 ${actor(args.userId, args.userName)} ${args.summary}`;
}

/** A permission denial (the "you need a role" path). */
export function auditDenied(args: AuditActor & { domain: string; action: string }): string {
  return `${formatTimestamp(args.time)} ⛔ ${actor(args.userId, args.userName)} denied: ${args.domain}:${args.action}`;
}

/** A switch toggle initiated from Discord. */
export function auditSwitchToggle(args: AuditActor & { label: string; on: boolean }): string {
  return `${formatTimestamp(args.time)} 🔘 ${actor(args.userId, args.userName)} toggled "${args.label}" → ${args.on ? "ON" : "OFF"}`;
}

/**
 * A switch group action from Discord: one line for the whole group, not
 * one per member.
 */
export function auditGroupToggle(
  args: AuditActor & { label: string; members: number; on: boolean },
): string {
  return `${formatTimestamp(args.time)} 🔘 ${actor(args.userId, args.userName)} toggled group "${args.label}" (${args.members}) → ${args.on ? "ON" : "OFF"}`;
}

/** A slash command invocation. */
export function auditSlash(args: AuditActor & { command: string }): string {
  return `${formatTimestamp(args.time)} ⌨ ${actor(args.userId, args.userName)} ran /${args.command}`;
}

/** A modal submission (team-chat send, device label, …). */
export function auditModal(args: AuditActor & { summary: string }): string {
  return `${formatTimestamp(args.time)} 📝 ${actor(args.userId, args.userName)} ${args.summary}`;
}

/** A smart alarm fired (in-game). */
export function auditAlarm(args: { time: Date; title: string; message: string }): string {
  return `${formatTimestamp(args.time)} 🚨 Alarm "${args.title}": ${args.message}`;
}

/**
 * How one logging-channel line notifies. A line is `@silent` and pings nobody
 * unless its caller asks otherwise, so a busy log never pushes a notification
 * and a label or chat message containing `@everyone` or `<@&role>` never pings.
 */
export interface AuditDelivery {
  /** Send as an ordinary, notifying message instead of `@silent`. */
  notify?: boolean;
  /**
   * The mentions Discord may act on in this line. `everyone` covers both
   * `@here` and `@everyone`; `roles` lists the role ids that may be pinged.
   */
  mentions?: { everyone?: boolean; roles?: readonly string[] };
}

/**
 * The prefix and delivery for a firing alarm's audit line, per its notification
 * level: Silent → `@silent`, no mention; unset (Normal) → notifies, no mention;
 * Active → `@here`; Everyone → `@everyone`. `text` is prepended to the line.
 */
export function alarmMentionPrefix(level: "silent" | "active" | "everyone" | undefined): {
  text: string;
  delivery: AuditDelivery;
} {
  switch (level) {
    case "silent":
      return { text: "", delivery: {} };
    case "active":
      return { text: "@here ", delivery: { notify: true, mentions: { everyone: true } } };
    case "everyone":
      return { text: "@everyone ", delivery: { notify: true, mentions: { everyone: true } } };
    default:
      return { text: "", delivery: { notify: true } };
  }
}

/**
 * `<@&id> ` for each role, to prefix a line that must reach those roles (the
 * send opts in to them with `AuditDelivery.mentions.roles`). Empty for none.
 */
export function roleMentionPrefix(roleIds: readonly string[]): string {
  return roleIds.map((id) => `<@&${id}> `).join("");
}

/** The operator's player died (in-game). */
export function auditDeath(args: { time: Date; name: string; message?: string }): string {
  const suffix = args.message ? `: ${args.message}` : "";
  return `${formatTimestamp(args.time)} 💀 ${args.name} died${suffix}`;
}

/** A relayed in-game team-chat message. */
export function auditTeamChat(args: { time: Date; name: string; message: string }): string {
  return `${formatTimestamp(args.time)} 💬 [TEAM] ${args.name}: ${args.message}`;
}

/** A device-state broadcast (switch flip / storage change), in-game or via Discord. */
export function auditEntityChange(args: {
  time: Date;
  label: string;
  entityType: string;
  value?: boolean;
}): string {
  const ts = formatTimestamp(args.time);
  if (args.entityType === "switch" || args.entityType === "alarm") {
    return `${ts} 🔀 "${args.label}" → ${args.value ? "ON" : "OFF"}`;
  }
  return `${ts} 📦 "${args.label}" contents changed`;
}

/** A server's connection health changed. */
export function auditServerStatus(args: {
  time: Date;
  name: string;
  /**
   * `offline`: not back within the grace period; `online`: connected after
   * being offline. A short drop writes no line.
   */
  status: "online" | "offline";
}): string {
  const dot = args.status === "online" ? "🟢" : "🔴";
  return `${formatTimestamp(args.time)} ${dot} ${args.name} ${args.status}`;
}

/** A server was paired. */
export function auditServerPaired(args: { time: Date; name: string }): string {
  return `${formatTimestamp(args.time)} 🛰 Server paired: ${args.name}`;
}

/** A device was paired. */
export function auditEntityPaired(args: { time: Date; label: string; entityType: string }): string {
  return `${formatTimestamp(args.time)} ➕ Device paired: ${args.label} (${args.entityType})`;
}

/**
 * The Steam sign-in needs renewing (bot-core `authRenewalNeeded`). Says what
 * happened and where to fix it: sign-in runs on the PC hosting Conduit, from
 * its tray menu. An expiry is shown as a Discord relative timestamp.
 */
export function auditAuthRenewal(args: {
  time: Date;
  reason: "expiring" | "expired" | "rejected";
  expiresAt?: string;
}): string {
  const fix =
    "On the PC running Conduit, right-click its tray icon and choose **Sign in with Steam again…**.";
  const expiry = args.expiresAt ? Date.parse(args.expiresAt) : NaN;
  let what: string;
  switch (args.reason) {
    case "expiring":
      what = Number.isNaN(expiry)
        ? "Conduit's Steam sign-in expires soon."
        : `Conduit's Steam sign-in expires <t:${Math.floor(expiry / 1000)}:R>.`;
      return `${formatTimestamp(args.time)} 🔑 ${what} ${fix} Until then, everything keeps working.`;
    case "expired":
      what = "Conduit's Steam sign-in has expired, so it can't reach your Rust servers.";
      break;
    case "rejected":
      what =
        "Facepunch no longer accepts Conduit's Steam sign-in, so it can't reach your Rust servers.";
      break;
  }
  return `${formatTimestamp(args.time)} 🔑 ${what} ${fix}`;
}

/**
 * An action that failed after it was allowed (the click line is written before
 * the action runs, so without this the channel only shows the attempt).
 * `reason` is short, plain copy, never an error message or stack.
 */
export function auditFailure(args: AuditActor & { summary: string; reason: string }): string {
  return `${formatTimestamp(args.time)} ⚠️ ${actor(args.userId, args.userName)} ${args.summary} failed: ${args.reason}`;
}

/** A switch change the server never confirmed (the state lock timed out). */
export function auditUnconfirmed(args: { time: Date; label: string }): string {
  return `${formatTimestamp(args.time)} ⚠️ "${args.label}": the server didn't confirm the change`;
}
