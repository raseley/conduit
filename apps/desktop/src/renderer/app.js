/*
 * Conduit desktop renderer logic.
 *
 * Plain ESM JavaScript (not TypeScript): the renderer runs in a DOM context and
 * talks only to the typed `window.conduit` bridge exposed by the preload
 * bridge. Keeping it as .js means it is copied verbatim into the build and
 * is not subject to the strict, DOM-free main-process tsconfig. The bridge it
 * uses is fully typed on the main/preload side (ipc-contract.ts).
 *
 * One file drives both surfaces; `window.conduit.surface` selects which root to
 * show. Tokens/styling live in styles.css.
 */

const api = window.conduit;

if (api?.surface === "status") {
  initStatus();
} else {
  initWizard();
}

/* ── Wizard ──────────────────────────────────────────────────────────────── */
function initWizard() {
  const root = document.getElementById("wizard");
  root.classList.remove("hidden");

  const primary = document.getElementById("wizard-primary");
  const spinner = document.getElementById("wizard-spinner");
  const tokenInput = document.getElementById("discord-token");
  const serverIdInput = document.getElementById("server-id");
  const inviteLink = document.getElementById("invite-link");
  const manualToggle = document.getElementById("manual-server-toggle");
  const manualBlock = document.querySelector("[data-manual-server]");
  const picker = document.querySelector("[data-server-picker]");
  const choicesEl = document.querySelector("[data-server-choices]");
  const botNameEl = document.querySelector("[data-bot-name]");
  const serverConfirmEl = document.querySelector("[data-server-confirm]");
  const diagnosticsBtn = document.getElementById("steam-diagnostics");
  const createChannelsBox = document.getElementById("create-channels");
  const createChannelsLabel = document.querySelector("[data-create-channels]");
  const retryChannelsBtn = document.getElementById("retry-channels");
  const finishStepsEl = document.querySelector("[data-finish-steps]");
  const inviteTitleEl = document.querySelector("[data-invite-title]");
  const inviteInstructionsEl = document.querySelector("[data-invite-instructions]");
  const inviteThenEl = document.querySelector("[data-invite-then]");
  const serverFoundEl = document.querySelector("[data-server-found]");
  const foundServerEl = document.querySelector("[data-found-server]");
  const pickerCaptionEl = document.querySelector("[data-picker-caption]");
  const inviteElsewhereEl = document.querySelector("[data-invite-elsewhere]");
  const inviteElsewhereLink = document.getElementById("invite-elsewhere");

  const PRIMARY_LABEL = {
    bot: "Check token ▸",
    intents: "I've enabled it ▸",
    invite: "I've invited the bot ▸",
    steam: "Connect Steam ▸",
    pair: "Retry pairing ▸",
    finish: "Done ▸",
  };

  // Open instructional/invite links externally (the renderer can't navigate).
  document.body.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-link]");
    if (!a) return;
    e.preventDefault();
    const url = a.getAttribute("data-link");
    if (url) api.openExternal(url);
  });

  let state = null;
  // The invite step's manual Server ID entry (a local view toggle, not wizard state).
  let manualServer = false;
  // The bot was already in a server, but the user wants to invite it to another
  // one: show the instructions in place of what Conduit found (a local view toggle).
  let inviteElsewhere = false;

  manualToggle.addEventListener("click", (e) => {
    e.preventDefault();
    manualServer = !manualServer;
    if (state) render(state);
    if (manualServer) serverIdInput.focus();
  });

  inviteElsewhereLink.addEventListener("click", (e) => {
    e.preventDefault();
    inviteElsewhere = true;
    if (state) render(state);
  });

  diagnosticsBtn.addEventListener("click", async () => {
    await api.copyDiagnostics();
    diagnosticsBtn.textContent = "Copied ✓";
    setTimeout(() => (diagnosticsBtn.textContent = "Copy diagnostics"), 1500);
  });

  retryChannelsBtn.addEventListener("click", async () => {
    render(await api.setupChannels(true));
  });

  /** Conduit couldn't create its channels: offer a retry or a way on without them. */
  function channelFallback(s) {
    return s.current === "invite" && s.channels?.kind === "fallback";
  }

  /**
   * The invite step's layout when the bot was already in a server as it opened:
   * "found" (one server, confirmed with Continue) or "picker" (several).
   * Undefined otherwise, and the step shows the invite instructions.
   */
  function offeredLayout(s) {
    if (s.current !== "invite" || !s.alreadyInvited || inviteElsewhere || manualServer) {
      return undefined;
    }
    return s.serverChoices?.length === 1 ? "found" : "picker";
  }

  /** Append `text` to `el`, turning `**bold**` spans into <strong> (no innerHTML). */
  function appendMarked(el, text) {
    text.split("**").forEach((part, i) => {
      if (i % 2 === 1) {
        const strong = document.createElement("strong");
        strong.textContent = part;
        el.appendChild(strong);
      } else if (part) {
        el.append(part);
      }
    });
  }

  /** "<prefix><strong>name</strong><suffix>", built without innerHTML. */
  function fillConfirm(el, prefix, name, suffix, iconUrl) {
    el.replaceChildren();
    if (iconUrl) {
      const img = document.createElement("img");
      img.className = "server-icon";
      img.src = iconUrl;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      el.appendChild(img);
    }
    const strong = document.createElement("strong");
    strong.textContent = name;
    el.append(prefix, strong, suffix);
  }

  function renderChoices(choices) {
    choicesEl.replaceChildren();
    for (const server of choices) {
      const btn = document.createElement("button");
      btn.className = "server-choice";
      btn.type = "button";
      if (server.iconUrl) {
        const img = document.createElement("img");
        img.className = "server-icon";
        img.src = server.iconUrl;
        img.alt = "";
        img.referrerPolicy = "no-referrer";
        btn.appendChild(img);
      } else {
        const blank = document.createElement("span");
        blank.className = "server-icon";
        btn.appendChild(blank);
      }
      const name = document.createElement("span");
      name.textContent = server.name ?? server.id;
      btn.appendChild(name);
      btn.addEventListener("click", () => {
        void api.selectServer(server.id, createChannelsBox.checked);
      });
      choicesEl.appendChild(btn);
    }
  }

  function primaryLabel(s) {
    const status = s.steps[s.current];
    if (s.current === "invite") {
      if (channelFallback(s)) return "Continue without them ▸";
      if (manualServer) return "Save & continue ▸";
      const offered = offeredLayout(s);
      if (offered === "found") return "Continue ▸";
      if (offered === "picker" || (s.serverChoices?.length && !s.alreadyInvited)) {
        return "Search again ▸";
      }
      if (status === "error") return "Try again ▸";
    }
    if (s.current === "intents" && status === "error") return "Check again ▸";
    return PRIMARY_LABEL[s.current] ?? "Continue ▸";
  }

  function render(s) {
    const stepChanged = state && state.current !== s.current;
    state = s;
    if (stepChanged) manualServer = false;
    if (stepChanged || !s.alreadyInvited) inviteElsewhere = false;
    // rail
    for (const el of document.querySelectorAll(".rail-step")) {
      const step = el.getAttribute("data-step");
      el.classList.remove("active", "done");
      const status = s.steps[step];
      if (status === "active" || status === "busy" || status === "error")
        el.classList.add("active");
      if (status === "done") el.classList.add("done");
    }
    // panes
    for (const el of document.querySelectorAll("[data-pane]")) {
      el.classList.toggle("hidden", el.getAttribute("data-pane") !== s.current);
    }
    // invite link (built from the Application ID the token check returned)
    if (inviteLink && s.inviteUrl) inviteLink.setAttribute("data-link", s.inviteUrl);
    // inline message: an error when the step failed, otherwise a neutral note
    const failed = s.steps[s.current] === "error";
    for (const el of document.querySelectorAll("[data-error]")) {
      const step = el.getAttribute("data-error");
      el.textContent = step === s.current && s.message ? s.message : "";
      el.classList.toggle("notice", !failed);
    }
    // confirmations: the bot the token belongs to, the server Conduit found
    botNameEl.classList.toggle("hidden", !s.botName);
    if (s.botName) fillConfirm(botNameEl, "Connected to ", s.botName, " ✓");
    serverConfirmEl.classList.toggle("hidden", !s.server);
    if (s.server) {
      fillConfirm(
        serverConfirmEl,
        "Controlling ",
        s.server.name ?? `server ${s.server.id}`,
        " ✓",
        s.server.iconUrl,
      );
    }
    // invite step: the server(s) the bot was already in, or the instructions;
    // then the picker + manual entry, or the channel fallback's choices
    const fallback = channelFallback(s);
    const offered = offeredLayout(s);
    inviteTitleEl.textContent = offered
      ? "Choose the server to control"
      : "Invite the bot to your server";
    inviteInstructionsEl.classList.toggle("hidden", Boolean(offered));
    inviteThenEl.classList.toggle("hidden", Boolean(offered) || fallback);
    serverFoundEl.classList.toggle("hidden", offered !== "found");
    const [only] = s.serverChoices ?? [];
    if (offered === "found" && only) {
      fillConfirm(
        foundServerEl,
        "Conduit's bot is already in ",
        only.name ?? `server ${only.id}`,
        ".",
        only.iconUrl,
      );
    }
    pickerCaptionEl.textContent =
      offered === "picker"
        ? "Conduit's bot is already in more than one server. Pick the one to control:"
        : "The bot is in more than one server. Pick the one to control:";
    inviteElsewhereEl.classList.toggle("hidden", !offered);
    // Inviting elsewhere sets the earlier offer aside: "I've invited the bot"
    // looks again and lists every server.
    const choices = s.alreadyInvited && !offered ? [] : (s.serverChoices ?? []);
    picker.classList.toggle(
      "hidden",
      choices.length === 0 || manualServer || fallback || offered === "found",
    );
    renderChoices(choices);
    manualBlock.classList.toggle("hidden", !manualServer || fallback);
    manualToggle.classList.toggle("hidden", fallback || Boolean(offered));
    manualToggle.textContent = manualServer
      ? "Find my server automatically instead"
      : "Enter the Server ID manually instead";
    createChannelsLabel.classList.toggle("hidden", fallback);
    retryChannelsBtn.classList.toggle("hidden", !fallback);
    // steam step: offer diagnostics when retrying won't help
    diagnosticsBtn.classList.toggle(
      "hidden",
      !(s.current === "steam" && failed && s.offerDiagnostics),
    );
    // pair status caption
    const pairCap = document.querySelector("[data-pair-status]");
    if (pairCap) {
      if (s.pairedServerName) pairCap.textContent = `Paired: ${s.pairedServerName}`;
      else if (s.steps.pair === "busy") pairCap.textContent = "Listening — pair in-game now…";
      else pairCap.textContent = "Waiting for a pairing…";
    }
    // finish copy: which steps remain depends on whether Conduit made its channels
    const finishCap = document.querySelector("[data-finish-status]");
    if (s.finish) {
      finishCap.textContent = s.finish.caption;
      finishStepsEl.replaceChildren();
      for (const step of s.finish.steps) {
        const li = document.createElement("li");
        appendMarked(li, step);
        finishStepsEl.appendChild(li);
      }
    }
    // primary button
    const busy = s.steps[s.current] === "busy";
    primary.textContent = primaryLabel(s);
    primary.disabled = busy;
    retryChannelsBtn.disabled = busy;
    for (const btn of choicesEl.querySelectorAll("button")) btn.disabled = busy;
    spinner.classList.toggle("hidden", !busy);
  }

  primary.addEventListener("click", async () => {
    if (!state) return;
    // For the validate-and-store steps the error (if any) arrives via the
    // wizard-state push, so we don't need to act on the returned result here.
    if (state.current === "bot") {
      await api.submitDiscordToken(tokenInput.value);
    } else if (state.current === "intents") {
      render(await api.checkIntents());
    } else if (state.current === "invite") {
      if (channelFallback(state)) render(await api.setupChannels(false));
      else if (offeredLayout(state) === "found")
        await api.selectServer(state.serverChoices[0].id, createChannelsBox.checked);
      else if (manualServer)
        await api.submitServerId(serverIdInput.value, createChannelsBox.checked);
      else render(await api.detectServer(createChannelsBox.checked));
    } else if (state.current === "steam") {
      render(await api.connectSteam());
    } else if (state.current === "pair") {
      // Pairing is armed automatically; this button re-arms after an error.
      await api.beginPairing();
    } else if (state.current === "finish") {
      await api.finishWizard();
    }
  });

  api.onWizardState(render);
  api.getWizardState().then(render);
}

/* ── Tray status window ────────────────────────────────────────────────────── */
function initStatus() {
  const root = document.getElementById("status");
  root.classList.remove("hidden");

  const rowsEl = document.getElementById("rows");
  const overallDot = document.getElementById("overall-dot");
  const overallCap = document.getElementById("overall-cap");
  const tokenCap = document.getElementById("token-caption");
  const copyBtn = document.getElementById("copy-diagnostics");
  const resetBtn = document.getElementById("reset-config");
  const renewBox = document.getElementById("steam-renewal");
  const renewBtn = document.getElementById("renew-steam");
  const renewResult = document.getElementById("renew-steam-result");

  const OVERALL_TEXT = {
    online: "all systems go",
    idle: "reconnecting…",
    down: "connection lost",
  };

  function render(snap) {
    overallDot.className = `dot ${snap.overall}`;
    overallCap.textContent = OVERALL_TEXT[snap.overall] ?? "";
    tokenCap.textContent = snap.tokenCaption ?? "";
    // The button shows only while a renewal is needed: a sign-in from the tray
    // menu clears the need too, and must take the button away. The outcome line
    // of a sign-in started here stays up after the button has gone.
    renewBtn.classList.toggle("hidden", !snap.steamSignInNeeded);
    renewBox.classList.toggle("hidden", !snap.steamSignInNeeded && renewResult.textContent === "");

    rowsEl.innerHTML = "";
    if (!snap.rows.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No servers paired yet — pair one in-game to begin.";
      rowsEl.appendChild(empty);
      return;
    }
    for (const row of snap.rows) {
      const el = document.createElement("div");
      el.className = "status-row";
      const dot = document.createElement("span");
      dot.className = `dot ${row.level}`;
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = row.label;
      const cap = document.createElement("span");
      cap.className = "cap";
      cap.textContent = row.caption;
      el.append(dot, label, cap);
      rowsEl.appendChild(el);
    }
  }

  // Opens the Steam window; the main process reports a one-line outcome.
  renewBtn.addEventListener("click", async () => {
    renewBtn.disabled = true;
    renewResult.textContent = "Waiting for Steam sign-in…";
    try {
      const result = await api.renewSteamSignIn();
      renewResult.textContent = result.message;
    } finally {
      renewBtn.disabled = false;
    }
  });

  copyBtn.addEventListener("click", async () => {
    await api.copyDiagnostics();
    copyBtn.textContent = "Copied ✓";
    setTimeout(() => (copyBtn.textContent = "Copy diagnostics"), 1500);
  });

  // The main process shows a native confirmation dialog and resolves false if the
  // user cancels; it reopens the wizard when the reset actually runs.
  resetBtn.addEventListener("click", async () => {
    resetBtn.disabled = true;
    try {
      await api.resetConfig();
    } finally {
      resetBtn.disabled = false;
    }
  });

  api.onStatus(render);
  api.getStatus().then(render);
}
