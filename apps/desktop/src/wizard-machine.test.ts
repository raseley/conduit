import { describe, it, expect } from "vitest";

import {
  DiscordAuthError,
  DiscordProtocolError,
  DiscordUnavailableError,
} from "./discord-probe.js";
import {
  INTENT_OFF_MESSAGE,
  NO_SERVER_MESSAGE,
  buildInviteUrl,
  channelFallbackMessage,
  discordProbeMessage,
  finishCopy,
  initialWizardSnapshot,
  serverDetectionEvent,
  validateDiscordToken,
  validateSnowflake,
  wizardReduce,
  type WizardEvent,
  type WizardServer,
  type WizardSnapshot,
} from "./wizard-machine.js";

const APP_ID = "123456789012345678";
const SERVER_ID = "987654321098765432";
const TOKEN = "MTAxMjM0NTY3ODkwMTIzNDU2Nzg.GabcDe.fGhIjKlMnOpQrStUvWxYz0123456789abcd";

function makeServer(id: string, overrides: Partial<WizardServer> = {}): WizardServer {
  return { id, name: `Server ${id.slice(-3)}`, ...overrides };
}

function reduceAll(events: WizardEvent[], from = initialWizardSnapshot()): WizardSnapshot {
  return events.reduce(wizardReduce, from);
}

/** Events that take a fresh wizard to the given step, all earlier steps done. */
const TO_INTENTS: WizardEvent[] = [{ type: "bot.done", appId: APP_ID, botName: "MyBot" }];
const TO_INVITE: WizardEvent[] = [...TO_INTENTS, { type: "intents.done" }];
const TO_STEAM: WizardEvent[] = [
  ...TO_INVITE,
  { type: "invite.done", server: makeServer(SERVER_ID) },
];
const TO_PAIR: WizardEvent[] = [...TO_STEAM, { type: "steam.done" }];

describe("wizard state machine", () => {
  it("starts on the bot step with the rest pending", () => {
    const s = initialWizardSnapshot();
    expect(s.current).toBe("bot");
    expect(s.steps).toEqual({
      bot: "active",
      intents: "pending",
      invite: "pending",
      steam: "pending",
      pair: "pending",
      finish: "pending",
    });
    expect(s.complete).toBe(false);
  });

  it("advances through the six-step happy path", () => {
    let s = initialWizardSnapshot();

    // Bot: the token is checked live; the check yields the Application ID.
    s = wizardReduce(s, { type: "bot.submit" });
    expect(s.steps.bot).toBe("busy");
    s = wizardReduce(s, { type: "bot.done", appId: APP_ID, botName: "MyBot" });
    expect(s.steps.bot).toBe("done");
    expect(s.current).toBe("intents");
    expect(s.steps.intents).toBe("active");
    expect(s.botName).toBe("MyBot");
    // The invite URL is derived from the probed Application ID.
    expect(s.inviteUrl).toBe(buildInviteUrl(APP_ID));

    // Intents: verified through the app's flags.
    s = wizardReduce(s, { type: "intents.submit" });
    expect(s.steps.intents).toBe("busy");
    s = wizardReduce(s, { type: "intents.done" });
    expect(s.steps.intents).toBe("done");
    expect(s.current).toBe("invite");
    expect(s.steps.invite).toBe("active");

    // Invite: the one server the bot is in is found and used.
    s = wizardReduce(s, { type: "invite.submit" });
    expect(s.steps.invite).toBe("busy");
    s = wizardReduce(s, { type: "invite.done", server: makeServer(SERVER_ID) });
    expect(s.steps.invite).toBe("done");
    expect(s.current).toBe("steam");
    expect(s.steps.steam).toBe("active");
    expect(s.server?.id).toBe(SERVER_ID);

    s = wizardReduce(s, { type: "steam.start" });
    expect(s.steps.steam).toBe("busy");
    s = wizardReduce(s, { type: "steam.done" });
    expect(s.current).toBe("pair");
    expect(s.steps.pair).toBe("active");

    s = wizardReduce(s, { type: "pair.start" });
    expect(s.steps.pair).toBe("busy");
    s = wizardReduce(s, { type: "pair.received", serverName: "My Server" });
    expect(s.steps.pair).toBe("done");
    // Pairing advances to the final, instructional "finish" step.
    expect(s.current).toBe("finish");
    expect(s.steps.finish).toBe("active");
    expect(s.pairedServerName).toBe("My Server");
    expect(s.complete).toBe(true);
  });

  it("keeps a rejected token on the bot step with its message", () => {
    const s = reduceAll([
      { type: "bot.submit" },
      { type: "bot.error", message: "Discord rejected that token." },
    ]);
    expect(s.current).toBe("bot");
    expect(s.steps.bot).toBe("error");
    expect(s.message).toBe("Discord rejected that token.");
    expect(s.inviteUrl).toBeUndefined();

    // Retrying clears the message.
    expect(wizardReduce(s, { type: "bot.submit" }).message).toBeUndefined();
  });

  it("keeps an intent that is still off on the intents step", () => {
    const s = reduceAll([
      ...TO_INTENTS,
      { type: "intents.submit" },
      { type: "intents.error", message: INTENT_OFF_MESSAGE },
    ]);
    expect(s.current).toBe("intents");
    expect(s.steps.intents).toBe("error");
    expect(s.message).toBe(INTENT_OFF_MESSAGE);
  });

  it("zero servers: stays on the invite step with a retry message", () => {
    const s = reduceAll([...TO_INVITE, { type: "invite.submit" }, serverDetectionEvent([])]);
    expect(s.current).toBe("invite");
    expect(s.steps.invite).toBe("error");
    expect(s.message).toBe(NO_SERVER_MESSAGE);
    // The invite link is still offered.
    expect(s.inviteUrl).toBe(buildInviteUrl(APP_ID));
  });

  it("several servers: shows a picker, and picking one advances", () => {
    const servers = [makeServer("111111111111111111"), makeServer("222222222222222222")];
    let s = reduceAll([...TO_INVITE, { type: "invite.submit" }, serverDetectionEvent(servers)]);
    expect(s.current).toBe("invite");
    expect(s.steps.invite).toBe("active");
    expect(s.serverChoices).toEqual(servers);
    expect(s.message).toBeUndefined();

    s = wizardReduce(s, { type: "invite.submit" });
    expect(s.serverChoices).toBeUndefined();
    s = wizardReduce(s, { type: "invite.done", server: servers[1]! });
    expect(s.current).toBe("steam");
    expect(s.server).toEqual(servers[1]);
    expect(s.serverChoices).toBeUndefined();
  });

  it("manual server entry advances with just the id", () => {
    const s = reduceAll([
      ...TO_INVITE,
      { type: "invite.submit" },
      { type: "invite.done", server: { id: SERVER_ID } },
    ]);
    expect(s.current).toBe("steam");
    expect(s.server).toEqual({ id: SERVER_ID });
  });

  it("a cancelled Steam sign-in is not an error", () => {
    const s = reduceAll([
      ...TO_STEAM,
      { type: "steam.start" },
      { type: "steam.cancelled", message: "Sign-in was cancelled." },
    ]);
    expect(s.current).toBe("steam");
    expect(s.steps.steam).toBe("active");
    expect(s.message).toBe("Sign-in was cancelled.");
    expect(s.offerDiagnostics).toBeUndefined();
  });

  it("a Steam error can offer diagnostics, cleared on the next attempt", () => {
    let s = reduceAll([
      ...TO_STEAM,
      { type: "steam.start" },
      { type: "steam.error", message: "steam bad", offerDiagnostics: true },
    ]);
    expect(s.steps.steam).toBe("error");
    expect(s.current).toBe("steam");
    expect(s.message).toBe("steam bad");
    expect(s.offerDiagnostics).toBe(true);

    s = wizardReduce(s, { type: "steam.start" });
    expect(s.offerDiagnostics).toBeUndefined();
    expect(s.message).toBeUndefined();
  });

  it("pair.cancel steps back to active but keeps a completed pair done", () => {
    let s = reduceAll([...TO_PAIR, { type: "pair.start" }, { type: "pair.cancel" }]);
    expect(s.steps.pair).toBe("active");
    expect(s.current).toBe("pair");

    s = wizardReduce(s, { type: "pair.received", serverName: "X" });
    s = wizardReduce(s, { type: "pair.cancel" });
    expect(s.steps.pair).toBe("done");
    // Already paired: cancel is a no-op and we stay on the finish step.
    expect(s.current).toBe("finish");
  });

  it("does not mutate the input snapshot", () => {
    const s = reduceAll(TO_INVITE);
    const frozen = JSON.stringify(s);
    wizardReduce(s, { type: "bot.submit" });
    wizardReduce(s, { type: "invite.choose", servers: [makeServer(SERVER_ID)] });
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe("Conduit's channels on the invite step", () => {
  const CREATED: WizardEvent = {
    type: "channels.done",
    category: "Conduit",
    control: "conduit",
    logging: "conduit-log",
  };
  const TO_CHANNELS: WizardEvent[] = [
    ...TO_INVITE,
    { type: "invite.submit" },
    { type: "channels.submit", server: makeServer(SERVER_ID) },
  ];
  const PAIRED: WizardEvent[] = [
    { type: "steam.done" },
    { type: "pair.received", serverName: "My Server" },
  ];

  it("stays busy on the invite step, server known, while the channels are made", () => {
    const s = reduceAll(TO_CHANNELS);
    expect(s.current).toBe("invite");
    expect(s.steps.invite).toBe("busy");
    expect(s.server?.id).toBe(SERVER_ID);
    expect(s.channels).toBeUndefined();
  });

  it("created → advances, and Finish shows the created-channels copy", () => {
    let s = reduceAll([...TO_CHANNELS, CREATED]);
    expect(s.current).toBe("steam");
    expect(s.steps.invite).toBe("done");
    expect(s.channels).toEqual({
      kind: "created",
      category: "Conduit",
      control: "conduit",
      logging: "conduit-log",
    });

    s = reduceAll(PAIRED, s);
    expect(s.current).toBe("finish");
    expect(s.finish?.caption).toContain("Paired with My Server.");
    expect(s.finish?.caption).toContain(
      "Your panels are in #conduit, and the activity log is in #conduit-log.",
    );
    const steps = s.finish!.steps.join("\n");
    expect(steps).toMatch(/access to the \*\*Conduit\*\* category/);
    expect(steps).toMatch(/\*\*admin\*\* and \*\*user\*\* roles/);
    // The channels are already chosen: no "pick a channel" steps.
    expect(steps).not.toMatch(/control channel/);
    expect(steps).not.toMatch(/logging channel/);
  });

  for (const reason of ["missing-permission", "forbidden"] as const) {
    it(`${reason} → fallback copy, and the step is not stuck`, () => {
      let s = reduceAll([...TO_CHANNELS, { type: "channels.fallback", reason }]);
      // A choice, not an error: the primary button is live.
      expect(s.current).toBe("invite");
      expect(s.steps.invite).toBe("active");
      expect(s.channels).toEqual({ kind: "fallback", reason });
      expect(s.message).toBe(channelFallbackMessage(reason));
      expect(s.message).toMatch(/invite link above again/);
      expect(s.message).toMatch(/Continue without them/);
      // The invite link is still offered, to grant the permission.
      expect(s.inviteUrl).toBe(buildInviteUrl(APP_ID));

      s = wizardReduce(s, { type: "channels.skip" });
      expect(s.current).toBe("steam");
      expect(s.steps.invite).toBe("done");
      expect(s.message).toBeUndefined();

      s = reduceAll(PAIRED, s);
      const steps = s.finish!.steps.join("\n");
      expect(steps).toMatch(/Create two text channels/);
      expect(steps).toMatch(/\*\*#conduit\*\*.*\*\*#conduit-log\*\*/);
      expect(steps).toMatch(/Pick the \*\*control channel\*\*/);
      expect(steps).toMatch(/Pick the \*\*logging channel\*\*/);
      expect(s.finish?.caption).not.toContain("Your panels are in");
    });
  }

  it("a retry after the fallback can still create them", () => {
    const s = reduceAll([
      ...TO_CHANNELS,
      { type: "channels.fallback", reason: "missing-permission" },
      { type: "channels.submit", server: makeServer(SERVER_ID) },
      CREATED,
    ]);
    expect(s.current).toBe("steam");
    expect(s.channels?.kind).toBe("created");
    expect(s.message).toBeUndefined();
  });

  it("a failure other than permission has its own copy", () => {
    const s = reduceAll([...TO_CHANNELS, { type: "channels.fallback", reason: "failed" }]);
    expect(s.steps.invite).toBe("active");
    expect(s.message).toMatch(/Try again/);
  });

  it("not asked for → Finish keeps the pick-the-channels steps", () => {
    const s = reduceAll([...TO_STEAM, ...PAIRED]);
    expect(s.channels).toBeUndefined();
    expect(s.finish!.steps.join("\n")).toMatch(/Pick the \*\*control channel\*\*/);
  });

  it("channels.skip is ignored off the invite step", () => {
    const s = reduceAll(TO_PAIR);
    expect(wizardReduce(s, { type: "channels.skip" })).toBe(s);
  });
});

describe("servers the bot is already in, as the invite step opens", () => {
  const ONE = makeServer(SERVER_ID, { iconUrl: "https://cdn.discordapp.com/icons/x/y.png" });
  const SEVERAL = [makeServer("111111111111111111"), makeServer("222222222222222222")];

  /** The pane's layout, as the renderer picks it from the snapshot. */
  function layout(s: WizardSnapshot): "found" | "picker" | "instructions" {
    if (!s.alreadyInvited) return "instructions";
    return s.serverChoices?.length === 1 ? "found" : "picker";
  }

  it("one server → the found layout, waiting for the user to confirm it", () => {
    const s = reduceAll([...TO_INVITE, { type: "invite.found", servers: [ONE] }]);
    expect(layout(s)).toBe("found");
    expect(s.serverChoices).toEqual([ONE]);
    // A choice, not an automatic advance: the step stays open and live.
    expect(s.current).toBe("invite");
    expect(s.steps.invite).toBe("active");
    expect(s.server).toBeUndefined();
    expect(s.message).toBeUndefined();
    // Inviting it to a different server stays possible.
    expect(s.inviteUrl).toBe(buildInviteUrl(APP_ID));
  });

  it("several servers → the picker straight away", () => {
    const s = reduceAll([...TO_INVITE, { type: "invite.found", servers: SEVERAL }]);
    expect(layout(s)).toBe("picker");
    expect(s.serverChoices).toEqual(SEVERAL);
    expect(s.steps.invite).toBe("active");
  });

  it("no server → the instructions, as for a brand-new bot", () => {
    const s = reduceAll([...TO_INVITE, { type: "invite.found", servers: [] }]);
    expect(layout(s)).toBe("instructions");
    expect(s).toEqual(reduceAll(TO_INVITE));
  });

  it("a failed lookup (no event) → the instructions, and the button can retry", () => {
    let s = reduceAll(TO_INVITE);
    expect(layout(s)).toBe("instructions");
    expect(s.steps.invite).toBe("active");
    s = reduceAll([{ type: "invite.submit" }, serverDetectionEvent([ONE])], s);
    expect(s.current).toBe("steam");
    expect(s.server).toEqual(ONE);
  });

  it("confirming the found server advances with it", () => {
    const s = reduceAll([
      ...TO_INVITE,
      { type: "invite.found", servers: [ONE] },
      { type: "invite.submit" },
      { type: "invite.done", server: ONE },
    ]);
    expect(s.current).toBe("steam");
    expect(s.server).toEqual(ONE);
    expect(s.alreadyInvited).toBeUndefined();
    expect(s.serverChoices).toBeUndefined();
  });

  it("a channel fallback after confirming shows the instructions, to re-invite", () => {
    const s = reduceAll([
      ...TO_INVITE,
      { type: "invite.found", servers: [ONE] },
      { type: "invite.submit" },
      { type: "channels.submit", server: ONE },
      { type: "channels.fallback", reason: "missing-permission" },
    ]);
    expect(layout(s)).toBe("instructions");
    expect(s.message).toMatch(/invite link above again/);
    expect(s.server).toEqual(ONE);
  });

  it("looking again after an invite elsewhere is the usual detection", () => {
    const s = reduceAll([
      ...TO_INVITE,
      { type: "invite.found", servers: [ONE] },
      { type: "invite.submit" },
      serverDetectionEvent(SEVERAL),
    ]);
    // The picker, below the instructions the user just followed.
    expect(s.serverChoices).toEqual(SEVERAL);
    expect(s.alreadyInvited).toBeUndefined();
  });

  it("is ignored once the step is under way or left", () => {
    const busy = reduceAll([...TO_INVITE, { type: "invite.submit" }]);
    expect(wizardReduce(busy, { type: "invite.found", servers: [ONE] })).toBe(busy);
    const later = reduceAll(TO_STEAM);
    expect(wizardReduce(later, { type: "invite.found", servers: [ONE] })).toBe(later);
  });
});

describe("finishCopy", () => {
  it("names the channels as they are in Discord", () => {
    const copy = finishCopy(
      { kind: "created", category: "CONDUIT", control: "conduit", logging: "conduit-log" },
      "X",
    );
    expect(copy.steps[0]).toContain("**CONDUIT**");
  });

  it("names the roles Conduit chooses by itself, with or without its channels", () => {
    const created = finishCopy(
      { kind: "created", category: "Conduit", control: "conduit", logging: "conduit-log" },
      "X",
    );
    for (const copy of [created, finishCopy(undefined, "X")]) {
      expect(copy.steps.join("\n")).toMatch(/\*\*Conduit Admin\*\* and \*\*Conduit\*\* are chosen/);
    }
  });
});

describe("serverDetectionEvent", () => {
  it("0 servers → an invite error asking to finish the invite", () => {
    expect(serverDetectionEvent([])).toEqual({ type: "invite.error", message: NO_SERVER_MESSAGE });
  });

  it("1 server → done with that server", () => {
    const only = makeServer(SERVER_ID, { iconUrl: "https://cdn.discordapp.com/icons/x/y.png" });
    expect(serverDetectionEvent([only])).toEqual({ type: "invite.done", server: only });
  });

  it("several servers → a picker with all of them", () => {
    const servers = [makeServer("111111111111111111"), makeServer("222222222222222222")];
    expect(serverDetectionEvent(servers)).toEqual({ type: "invite.choose", servers });
  });
});

describe("discordProbeMessage", () => {
  it("a rejected token on the bot step says to reset and copy it again", () => {
    const msg = discordProbeMessage(new DiscordAuthError("401"), "token");
    expect(msg).toMatch(/rejected that token/i);
    expect(msg).toMatch(/Reset Token/);
  });

  it("a rejected token later says the token no longer works", () => {
    expect(discordProbeMessage(new DiscordAuthError("401"), "servers")).toMatch(/no longer/i);
  });

  it("offline / Discord down is retryable", () => {
    expect(discordProbeMessage(new DiscordUnavailableError("fetch failed"), "token")).toMatch(
      /Couldn't reach Discord.*try again/i,
    );
    expect(
      discordProbeMessage(new DiscordUnavailableError("busy", { status: 429 }), "intents"),
    ).toMatch(/Wait a minute/i);
  });

  it("an unexpected answer gets a generic retry", () => {
    expect(discordProbeMessage(new DiscordProtocolError("bad"), "servers")).toMatch(/try again/i);
    expect(discordProbeMessage("weird", "token")).toMatch(/try again/i);
  });

  it("never echoes the error's own message (which could name internals)", () => {
    const err = new DiscordUnavailableError(`request failed for ${TOKEN}`);
    expect(discordProbeMessage(err, "token")).not.toContain(TOKEN);
  });
});

describe("buildInviteUrl", () => {
  it("embeds the app id, bot scope, and permissions", () => {
    const url = buildInviteUrl(APP_ID);
    expect(url).toContain(`client_id=${APP_ID}`);
    expect(url).toContain("scope=bot+applications.commands");
    // View Channels + Send Messages + Manage Messages + Embed Links + Attach
    // Files + Read Message History + Mention Everyone + Manage Channels. Attach
    // Files is required for map/camera posts; Manage Channels creates Conduit's
    // channels; Mention Everyone is for alarm and admin-role pings.
    expect(url).toContain("permissions=257040");
  });
});

describe("validateDiscordToken", () => {
  it("rejects empty / whitespace input", () => {
    expect(validateDiscordToken("")).toMatch(/continue/i);
    expect(validateDiscordToken("   ")).toBeTruthy();
  });

  it("rejects tokens with internal spaces", () => {
    expect(validateDiscordToken("abc def.ghi.jkl")).toMatch(/no spaces/i);
  });

  it("rejects non-three-part tokens", () => {
    expect(validateDiscordToken("justonepart")).toBeTruthy();
    expect(validateDiscordToken("two.parts")).toBeTruthy();
  });

  it("rejects implausibly short tokens", () => {
    expect(validateDiscordToken("a.b.c")).toMatch(/short/i);
  });

  it("accepts a plausibly-shaped token", () => {
    expect(validateDiscordToken(TOKEN)).toBeUndefined();
  });
});

describe("validateSnowflake", () => {
  it("rejects empty input with the field name", () => {
    expect(validateSnowflake("", "Server ID")).toMatch(/Server ID/);
    expect(validateSnowflake("   ", "Server ID")).toMatch(/Server ID/);
  });

  it("rejects non-numeric or wrong-length ids", () => {
    expect(validateSnowflake("not-a-number", "Server ID")).toBeTruthy();
    expect(validateSnowflake("12345", "Server ID")).toBeTruthy();
    expect(validateSnowflake("1".repeat(25), "Server ID")).toBeTruthy();
  });

  it("accepts a 17–20 digit snowflake", () => {
    expect(validateSnowflake(SERVER_ID, "Server ID")).toBeUndefined();
    expect(validateSnowflake(`  ${SERVER_ID}  `, "Server ID")).toBeUndefined();
  });
});
