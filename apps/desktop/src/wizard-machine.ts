/**
 * Bootstrap-wizard state machine — pure, electron-free logic.
 *
 * The wizard walks the user through everything Conduit needs, in the natural
 * order they'd perform it — all values are gathered here, nothing on the command
 * line. Each step is a single, self-contained action so a brand-new user can
 * follow it end to end with no outside knowledge:
 *   1. Create your bot     → create the app, copy the bot token from its Bot tab.
 *                            The token is checked live against Discord, which
 *                            also yields the Application ID (nothing to paste).
 *   2. Enable intents      → toggle Server Members Intent; verified through the
 *                            application's flags, not taken on trust.
 *   3. Invite the bot      → authorize it into the server; Conduit then finds the
 *                            server itself (one → automatic, several → picker,
 *                            none → retry), with manual ID entry as a fallback.
 *                            On a re-run the bot is usually still in the server:
 *                            Conduit looks before showing the instructions and
 *                            offers what it found instead (one → confirm with a
 *                            click, several → picker).
 *                            Then, unless the user unticks it, Conduit creates
 *                            its private category with #conduit and #conduit-log
 *                            (reusing any that exist). Without permission it
 *                            falls back: retry after re-inviting, or continue
 *                            and make the channels by hand.
 *   4. Connect with Steam  → Rust+ registration
 *   5. Pair your server    → catch the in-game pairing
 *   6. Finish in Discord   → (instructional) /conduit setup next steps
 *
 * The token and intents steps both live on the Discord Developer Portal's Bot
 * tab, ordered top-to-bottom as they appear there (token above intents).
 *
 * The *visuals* live in the renderer and the *side effects* (the Discord probe,
 * storing config, fcm.register, opening the Steam window, beginPairing) live in
 * the main process; this module owns only the step/status bookkeeping and the
 * pure mappings from side-effect results to events and copy, so the transitions
 * are unit-testable in isolation.
 *
 * The machine is a reducer: the main process applies {@link WizardEvent}s as the
 * underlying side effects progress, and the renderer renders the resulting
 * {@link WizardSnapshot} (step rail + active pane + primary-button enablement).
 */

import { BOT_CHANNEL_PERMISSIONS, PERMISSION } from "./discord-probe.js";

/** The six wizard steps, in the order the user performs them. */
export type WizardStep =
  | "bot" // create the app + bot, paste the bot token (validated live → Application ID)
  | "intents" // enable the Server Members privileged intent (verified via app flags)
  | "invite" // authorize the bot into the server → server auto-detected
  | "steam" // Rust+ registration via Steam login
  | "pair" // catch the in-game server pairing
  | "finish"; // finish in Discord: /conduit setup (instructional)

export const WIZARD_STEPS: readonly WizardStep[] = [
  "bot",
  "intents",
  "invite",
  "steam",
  "pair",
  "finish",
];

/** Per-step lifecycle status (drives the rail tick + primary-button state). */
export type StepStatus =
  | "pending" // not reached / not started (muted in the rail)
  | "active" // current step, idle (primary enabled)
  | "busy" // current step, side effect in flight (primary shows a spinner)
  | "error" // current step failed (inline message; primary re-enabled to retry)
  | "done"; // completed (positive tick in the rail)

/** A Discord server (guild) as the wizard shows it. */
export interface WizardServer {
  id: string;
  /** Display name; absent when the ID was entered manually. */
  name?: string;
  /** Icon URL (Discord CDN), when the server has one. */
  iconUrl?: string;
}

/** Why Conduit couldn't create its channels. */
export type ChannelFallbackReason =
  | "missing-permission" // the bot has no Manage Channels in the server
  | "forbidden" // Discord answered 403 when creating them
  | "failed"; // anything else (offline, unexpected answer)

/** How the invite step's "Create the Conduit channels for me" turned out. */
export type WizardChannels =
  /** Created or reused; the names as they are in Discord. */
  | { kind: "created"; category: string; control: string; logging: string }
  /** Not created: the user may retry or continue and make them by hand. */
  | { kind: "fallback"; reason: ChannelFallbackReason };

/**
 * The finish step's copy, chosen by how the channels turned out. Steps may mark
 * bold text with `**…**`; the renderer turns it into `<strong>` without HTML.
 */
export interface FinishCopy {
  caption: string;
  steps: string[];
}

/** A read-only snapshot the renderer renders + the IPC layer ships. */
export interface WizardSnapshot {
  /** The step currently shown in the content pane. */
  current: WizardStep;
  /** Status per step (for the rail + pane). */
  steps: Record<WizardStep, StepStatus>;
  /**
   * Inline message for the current step: an error when the step's status is
   * `error`, otherwise a neutral note (e.g. "Sign-in was cancelled").
   */
  message?: string;
  /** The bot application's name from the live token check ("Connected to MyBot"). */
  botName?: string;
  /**
   * OAuth2 invite URL for the bot, built from the Application ID the token check
   * returned. The invite pane renders it as a clickable link.
   */
  inviteUrl?: string;
  /**
   * Servers to pick from on the invite step: several found after the invite,
   * or the ones the bot was already in when the step opened.
   */
  serverChoices?: WizardServer[];
  /**
   * The bot was already in {@link serverChoices} when the invite step opened (a
   * re-run of the wizard). The pane then offers them in place of the invite
   * instructions: one server → named, with a Continue button; several → the
   * picker. It is a choice, never an automatic advance, since the bot may be in
   * a server the user no longer wants to control.
   */
  alreadyInvited?: boolean;
  /** The Discord server Conduit will control, once chosen. */
  server?: WizardServer;
  /**
   * Conduit's channels, once it tried to create them. Unset when the user
   * didn't ask for them (they pick channels in `/conduit setup` instead).
   */
  channels?: WizardChannels;
  /** The finish step's copy, set when pairing lands. */
  finish?: FinishCopy;
  /** A Steam failure that retrying won't fix: show a "Copy diagnostics" button. */
  offerDiagnostics?: boolean;
  /** Set on the pair step when a server has been received (its display name). */
  pairedServerName?: string;
  /** True once pairing has landed and only the final "finish" step remains. */
  complete: boolean;
}

/** Events the main process applies as side effects progress. */
export type WizardEvent =
  | { type: "bot.submit" } // token submitted, being checked with Discord
  | { type: "bot.done"; appId: string; botName: string } // token valid: app id + name
  | { type: "bot.error"; message: string }
  | { type: "intents.submit" } // checking the app's flags with Discord
  | { type: "intents.done" }
  | { type: "intents.error"; message: string }
  | { type: "invite.found"; servers: WizardServer[] } // the bot's servers as the invite step opens
  | { type: "invite.submit" } // looking for the server (or saving a manual ID)
  | { type: "invite.choose"; servers: WizardServer[] } // several servers: show a picker
  | { type: "invite.done"; server: WizardServer } // server chosen + stored, no channels wanted
  | { type: "invite.error"; message: string }
  | { type: "channels.submit"; server: WizardServer } // server stored; creating Conduit's channels
  | { type: "channels.done"; category: string; control: string; logging: string } // created/reused
  | { type: "channels.fallback"; reason: ChannelFallbackReason } // not created: retry or continue
  | { type: "channels.skip" } // continue without Conduit's channels
  | { type: "steam.start" } // fcm.register kicked off
  | { type: "steam.done" } // credentials obtained
  | { type: "steam.cancelled"; message: string } // user closed the window: not an error
  | { type: "steam.error"; message: string; offerDiagnostics?: boolean }
  | { type: "pair.start" } // beginPairing armed
  | { type: "pair.received"; serverName: string }
  | { type: "pair.error"; message: string }
  | { type: "pair.cancel" }; // pairing wait cancelled → back to active

/** The initial snapshot: the bot step active, the rest pending. */
export function initialWizardSnapshot(): WizardSnapshot {
  return {
    current: "bot",
    steps: {
      bot: "active",
      intents: "pending",
      invite: "pending",
      steam: "pending",
      pair: "pending",
      finish: "pending",
    },
    message: undefined,
    botName: undefined,
    inviteUrl: undefined,
    serverChoices: undefined,
    alreadyInvited: undefined,
    server: undefined,
    channels: undefined,
    finish: undefined,
    offerDiagnostics: undefined,
    pairedServerName: undefined,
    complete: false,
  };
}

/**
 * Discord permissions bitfield the invite URL requests (257040): what the bot
 * needs in its channels ({@link BOT_CHANNEL_PERMISSIONS}: View Channels, Send
 * Messages, Manage Messages, Embed Links, Attach Files, Read Message History,
 * Mention Everyone) plus Manage Channels, used only to create Conduit's
 * channels. Attach Files is required for the map and camera panels, which post
 * image attachments; Mention Everyone for alarm @here/@everyone and admin-role
 * pings.
 */
const INVITE_PERMISSIONS = BOT_CHANNEL_PERMISSIONS | PERMISSION.MANAGE_CHANNELS;

/** Build the bot invite (OAuth2 authorize) URL for a given Application ID. */
export function buildInviteUrl(appId: string): string {
  const id = encodeURIComponent(appId.trim());
  return (
    `https://discord.com/oauth2/authorize?client_id=${id}` +
    `&permissions=${INVITE_PERMISSIONS}&scope=bot+applications.commands`
  );
}

/**
 * Apply an event to produce the next snapshot. Pure — no I/O, no mutation of the
 * input. Unknown transitions return the input unchanged (defensive).
 */
export function wizardReduce(state: WizardSnapshot, event: WizardEvent): WizardSnapshot {
  const steps = { ...state.steps };

  switch (event.type) {
    case "bot.submit":
      steps.bot = "busy";
      return { ...state, current: "bot", steps, message: undefined };

    case "bot.done":
      steps.bot = "done";
      steps.intents = "active";
      return {
        ...state,
        current: "intents",
        steps,
        message: undefined,
        botName: event.botName,
        inviteUrl: buildInviteUrl(event.appId),
      };

    case "bot.error":
      steps.bot = "error";
      return { ...state, current: "bot", steps, message: event.message };

    case "intents.submit":
      steps.intents = "busy";
      return { ...state, current: "intents", steps, message: undefined };

    case "intents.done":
      steps.intents = "done";
      steps.invite = "active";
      return { ...state, current: "invite", steps, message: undefined };

    case "intents.error":
      steps.intents = "error";
      return { ...state, current: "intents", steps, message: event.message };

    case "invite.found":
      // Only as the step opens: once the user has acted, their action decides.
      if (state.current !== "invite" || steps.invite !== "active") return state;
      // None found: the instructions, as for a brand-new bot.
      if (event.servers.length === 0) return state;
      return {
        ...state,
        message: undefined,
        serverChoices: event.servers.map((s) => ({ ...s })),
        alreadyInvited: true,
      };

    case "invite.submit":
      steps.invite = "busy";
      return {
        ...state,
        current: "invite",
        steps,
        message: undefined,
        serverChoices: undefined,
        alreadyInvited: undefined,
      };

    case "invite.choose":
      steps.invite = "active";
      return {
        ...state,
        current: "invite",
        steps,
        message: undefined,
        serverChoices: event.servers.map((s) => ({ ...s })),
        alreadyInvited: undefined,
      };

    case "invite.done":
      steps.invite = "done";
      steps.steam = "active";
      return {
        ...state,
        current: "steam",
        steps,
        message: undefined,
        serverChoices: undefined,
        alreadyInvited: undefined,
        server: { ...event.server },
        channels: undefined,
      };

    case "invite.error":
      steps.invite = "error";
      return { ...state, current: "invite", steps, message: event.message };

    case "channels.submit":
      // The server is stored; stay on the invite step while the channels are made.
      steps.invite = "busy";
      return {
        ...state,
        current: "invite",
        steps,
        message: undefined,
        serverChoices: undefined,
        alreadyInvited: undefined,
        server: { ...event.server },
        channels: undefined,
      };

    case "channels.done":
      steps.invite = "done";
      steps.steam = "active";
      return {
        ...state,
        current: "steam",
        steps,
        message: undefined,
        channels: {
          kind: "created",
          category: event.category,
          control: event.control,
          logging: event.logging,
        },
      };

    case "channels.fallback":
      // Not an error: the step offers a retry and a way on without the channels.
      steps.invite = "active";
      return {
        ...state,
        current: "invite",
        steps,
        message: channelFallbackMessage(event.reason),
        channels: { kind: "fallback", reason: event.reason },
      };

    case "channels.skip":
      if (state.current !== "invite" || state.server === undefined) return state;
      steps.invite = "done";
      steps.steam = "active";
      return { ...state, current: "steam", steps, message: undefined };

    case "steam.start":
      steps.steam = "busy";
      return { ...state, current: "steam", steps, message: undefined, offerDiagnostics: undefined };

    case "steam.done":
      steps.steam = "done";
      steps.pair = "active";
      return { ...state, current: "pair", steps, message: undefined, offerDiagnostics: undefined };

    case "steam.cancelled":
      // Closing the window yourself is not an error: back to idle with a note.
      steps.steam = "active";
      return {
        ...state,
        current: "steam",
        steps,
        message: event.message,
        offerDiagnostics: undefined,
      };

    case "steam.error":
      steps.steam = "error";
      return {
        ...state,
        current: "steam",
        steps,
        message: event.message,
        offerDiagnostics: event.offerDiagnostics ? true : undefined,
      };

    case "pair.start":
      steps.pair = "busy";
      return { ...state, current: "pair", steps, message: undefined };

    case "pair.received":
      // Pairing landed — advance to the final, instructional "finish" step.
      steps.pair = "done";
      steps.finish = "active";
      return {
        ...state,
        current: "finish",
        steps,
        message: undefined,
        pairedServerName: event.serverName,
        finish: finishCopy(state.channels, event.serverName),
        complete: true,
      };

    case "pair.error":
      steps.pair = "error";
      return { ...state, current: "pair", steps, message: event.message };

    case "pair.cancel":
      // Nothing to cancel once paired; otherwise step back out of busy.
      if (steps.pair === "done") return state;
      steps.pair = "active";
      return { ...state, current: "pair", steps, message: undefined };

    default:
      return state;
  }
}

// ── Side-effect results → events + copy (pure) ──────────────────────────────

/** Copy for the zero-servers case after the invite. */
export const NO_SERVER_MESSAGE =
  "Conduit doesn't see your server yet. Finish the invite (open the link above), then click Try again.";

/**
 * The event for the servers the bot can see after the invite: none → stay on
 * the invite step with a retry, one → use it, several → a picker.
 */
export function serverDetectionEvent(servers: readonly WizardServer[]): WizardEvent {
  const [only] = servers;
  if (only === undefined) return { type: "invite.error", message: NO_SERVER_MESSAGE };
  if (servers.length === 1) return { type: "invite.done", server: { ...only } };
  return { type: "invite.choose", servers: servers.map((s) => ({ ...s })) };
}

/** The way on without Conduit's channels, shared by every fallback message. */
const CONTINUE_WITHOUT_CHANNELS =
  "Or click Continue without them, then create two private text channels yourself (for example #conduit and #conduit-log) and pick them in /conduit setup. The last step explains how.";

/**
 * Copy for the invite step when Conduit couldn't create its channels. The
 * invite link stays on the same pane, so re-inviting grants the permission.
 */
export function channelFallbackMessage(reason: ChannelFallbackReason): string {
  switch (reason) {
    case "missing-permission":
      return `The bot can't create channels in this server: it doesn't have Manage Channels. To give it that, open the invite link above again, keep every permission ticked and click Authorize, then click Try again. ${CONTINUE_WITHOUT_CHANNELS}`;
    case "forbidden":
      return `Discord didn't let the bot create the channels. To allow it, open the invite link above again, keep every permission ticked (Manage Channels too) and click Authorize, then click Try again. ${CONTINUE_WITHOUT_CHANNELS}`;
    case "failed":
      return `Conduit couldn't create the channels: Discord didn't answer as expected. Click Try again. ${CONTINUE_WITHOUT_CHANNELS}`;
  }
}

/** Choosing the roles, the same on every path: named for Conduit, they are taken by themselves. */
const CHOOSE_ROLES =
  "Run **/conduit setup** (admins only) and check the **admin** and **user** roles that may operate devices. Roles named **Conduit Admin** and **Conduit** are chosen for you; otherwise choose them there.";

/** The finish step's last two steps, the same on every path. */
const FINISH_TAIL = [
  "Pair a smart switch, alarm, or storage monitor **in-game** and it appears in Discord by itself, ready to control.",
  "Conduit lives in the tray — right-click its icon any time for status. Click **Done** to close this window.",
];

/**
 * The finish step's copy. When Conduit made its channels, the panels and the
 * log are already placed and only the roles remain; otherwise the user makes
 * (or picks) the channels in `/conduit setup`.
 */
export function finishCopy(
  channels: WizardChannels | undefined,
  pairedServerName: string,
): FinishCopy {
  const paired = `Paired with ${pairedServerName}. Conduit is now running in your system tray.`;
  if (channels?.kind === "created") {
    return {
      caption: `${paired} Your panels are in #${channels.control}, and the activity log is in #${channels.logging}.`,
      steps: [
        `Give your Conduit roles access to the **${channels.category}** category: in Discord, right-click it, choose **Edit Category** → **Permissions**, and add the roles. Until then only the bot and server admins can see it.`,
        CHOOSE_ROLES,
        ...FINISH_TAIL,
      ],
    };
  }
  return {
    caption: `${paired} Do the last bit of setup from inside Discord, then you're done.`,
    steps: [
      "Create two text channels for Conduit if you don't have them yet, for example **#conduit** for its panels and **#conduit-log** for its activity log. Keep them private, and give the bot's role access in each channel's **Permissions** settings.",
      "In your Discord server, run **/conduit setup** to open the Setup hub (admins only).",
      "Pick the **control channel** where Conduit posts its device panels.",
      "Pick the **logging channel** — Conduit posts a timestamped audit line there for every action (alarms, deaths, switch toggles). Optional, but recommended.",
      "Check the **admin** and **user** roles that may operate devices. Roles named **Conduit Admin** and **Conduit** are chosen for you; otherwise choose them there.",
      ...FINISH_TAIL,
    ],
  };
}

/** Copy when the Server Members intent is still off in the portal. */
export const INTENT_OFF_MESSAGE =
  "Discord says the Server Members Intent is still off. Turn it on, click Save Changes, then try again.";

/** Which wizard step a Discord probe failure happened on (picks the copy). */
export type DiscordProbeContext = "token" | "intents" | "servers";

/**
 * Friendly copy for a failed Discord probe. Matches on `err.name` (like the
 * discord adapter's `friendlyError`); never includes the token or a stack.
 */
export function discordProbeMessage(err: unknown, context: DiscordProbeContext): string {
  const name = err instanceof Error ? err.name : undefined;
  switch (name) {
    case "DiscordAuthError":
      return context === "token"
        ? "Discord rejected that token. On the Bot tab, click Reset Token, then copy the new token and paste it here."
        : "Discord no longer accepts the bot token (was it reset?). Close setup and start it again with the new token.";
    case "DiscordUnavailableError":
      return (err as { status?: unknown }).status === 429
        ? "Discord is busy right now. Wait a minute, then try again."
        : "Couldn't reach Discord. Check your internet connection, then try again.";
    default:
      return "Discord sent an answer Conduit didn't expect. Wait a moment, then try again.";
  }
}

// ── Input validation ─────────────────────────────────────────────────────────

/**
 * Validate a Discord bot token's *shape* before checking it live with Discord.
 * Rejects the obviously-wrong input so the operator gets immediate, friendly
 * feedback without a network round-trip. A real bot token is three
 * dot-separated base64url-ish segments (e.g. `MTA....G....x...`), typically ≥50
 * chars. Returns a friendly message when invalid, or `undefined` when it looks
 * plausible.
 */
export function validateDiscordToken(raw: string): string | undefined {
  const token = raw.trim();
  if (token.length === 0) {
    return "Paste your bot token to continue.";
  }
  // Reject anything with whitespace inside (a common copy/paste mistake).
  if (/\s/.test(token)) {
    return "That doesn't look right — a bot token has no spaces. Copy it again from the Discord developer portal.";
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    return "That doesn't look like a bot token. Copy the Token (not the Client Secret) from the Bot page of the Discord developer portal.";
  }
  if (token.length < 50) {
    return "That token looks too short. Copy the full Token from the Discord developer portal.";
  }
  return undefined;
}

/**
 * Validate a Discord snowflake id (e.g. a manually entered Server/guild ID): a
 * 17–20 digit number. `noun` names the field for the friendly message. Returns
 * a message when invalid, or `undefined` when it looks plausible.
 */
export function validateSnowflake(raw: string, noun: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0) {
    return `Paste your ${noun} to continue.`;
  }
  if (!/^\d{17,20}$/.test(value)) {
    return `That doesn't look like a ${noun} — it should be a 17–20 digit number. In Discord, enable Developer Mode (User Settings → Advanced), then right-click to copy the ID.`;
  }
  return undefined;
}
