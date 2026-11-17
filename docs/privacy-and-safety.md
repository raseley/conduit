# Privacy and safety

What Conduit does with your accounts, and why it runs on your own PC.

## Why it runs on your own PC

Conduit is built around one idea: **your Rust+ access stays yours.**

Hosted Rust+ bot services run on someone else's server, so they ask you to hand over your
Rust+ credentials: the token Facepunch issues for your Steam sign-in, and the token for
each server you pair. Whoever holds those can operate your smart devices and read what Rust+
shows (your team, the map, team chat) for as long as the tokens stay valid. Conduit runs on
your own PC instead, so none of that leaves your hands.

- **Your credentials don't leave your PC**, except to talk directly to Facepunch and
  Discord, the services they belong to. There is no Conduit server, account or middleman.
  They are encrypted on disk (see [Is it safe?](#is-it-safe)).
- **Your data is yours.** Your settings, paired servers and devices, and Conduit's logs are
  ordinary files on your PC that you can delete at any time. Panels and the activity log
  live in your own Discord server. No third party keeps a copy of your base layout or your
  activity.
- **Your bot, your Discord app.** You create the Discord bot yourself during setup, so no
  shared bot has permissions in your server.
- **Open source and checkable.** Anyone can read the code, and every release is built in
  GitHub Actions with a signed record of where it came from (see
  [Verifying your download](verifying-your-download.md)).
- **No subscription and nothing to shut down.** No outside service can go offline,
  start charging, or be breached and take your setup with it.
- **The trade-off:** Conduit only works while your PC is on and online. If the PC sleeps or
  shuts down, so does your bot. You also install updates yourself.

## Is it safe?

Conduit holds two keys to your accounts: the Rust+ token Facepunch gives it when you sign in
with Steam, and your Discord bot's token. Here is what it does with them.

- **You sign in on Steam's own page.** Conduit opens Facepunch's official Rust+ login in a
  separate, isolated window. Conduit doesn't see your Steam password; it keeps only the
  Rust+ token Facepunch hands back, and the login window saves no cookies or history to
  disk.
- **Where your tokens go.** The Rust+ token is sent only to Facepunch, and the bot token
  only to Discord. Pairing messages from your Rust server reach Conduit the same way they
  reach the Rust+ phone app, through Google's push service; neither token goes to Google.
  If you turn on Pushover, it receives your Pushover keys and the alert, nothing else.
- **Encrypted on your PC.** Your Rust+ sign-in, push registration, Discord bot token, each
  paired server's Rust+ player token and your Pushover keys are stored encrypted with
  Windows' built-in data protection (DPAPI), so only your Windows account on this PC can
  read them. The rest (settings, server names, devices and panel ids) is kept unencrypted
  in a plain file next to them, in Conduit's folder under `%APPDATA%`. Windows protects that
  folder like the rest of your user files.
- **No secrets in logs.** Conduit's log file and its "Copy diagnostics" report leave out
  tokens and keys.
- **Open source.** The code is all here to read, and you can
  [check that your download](verifying-your-download.md) was built from it.

Found a security problem? Please report it privately: see [SECURITY.md](../SECURITY.md).
