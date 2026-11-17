# Conduit

<!-- Badges (CI, OpenSSF Scorecard, latest release) go here once the repository is public and
has its first release. -->

**Control your Rust base from Discord.**

Flip your smart switches, get pinged when an alarm goes off, and check your storage, all from
your own Discord server, for your whole team.

> Conduit is a free, unofficial fan project. It is not made by or connected to Facepunch
> Studios.

## What you can do

- **Turn switches on and off** with one button.
- **Get alarm alerts** in Discord, and on your phone if you like.
- **See your storage**, including how long your tool cupboard's upkeep will last.
- **See who's online** on your server and in your team.
- **Grab a camera picture** whenever you want.
- **Decide who can press the buttons.** Everyone else can only look.

## Why it runs on your PC

Online Rust+ bots run on someone else's server, so they need your Rust+ sign-in. Whoever
holds it can control your devices and read your team chat. Conduit runs on your own PC
instead, so your sign-in never leaves your hands.

- **No middleman.** Your sign-ins go only to Facepunch and Discord, the services they belong
  to. There is no Conduit server or account.
- **Locked to your PC.** Your sign-ins are stored encrypted, so only your Windows account
  can read them.
- **Your own bot.** You create the Discord bot yourself, so nobody else's bot sits in your
  server.
- **Nothing to shut down.** No subscription, and no outside service that can go offline or
  get hacked.

The catch: the bot only works while your PC is on. More in
[Privacy and safety](docs/privacy-and-safety.md).

## What you need

- **A Windows PC that stays on.** Conduit runs on it. When the PC is off, so is your bot.
- **Rust on Steam**, and a server that has Rust+ (most do).
- **A Discord server where you're an admin.**
- **About 10 minutes.**

## Get started

### 1. Download and install

Download **`Conduit-<version>-setup.exe`** from the
[Releases page](https://github.com/raseley/conduit/releases/latest) and run it.

Windows may warn you with "Windows protected your PC". That's normal for a new app. Click
**More info**, then **Run anyway**.

### 2. Follow the setup window

Conduit opens a setup window that walks you through it one step at a time. Keep Discord
open in your browser, and have Rust ready.

1. **Make your own Discord bot** and paste in its token. The window shows you where to click.
2. **Turn on one setting** for the bot.
3. **Add the bot to your Discord server.** Conduit makes a private channel for its buttons
   and another for its log.
4. **Sign in with Steam** on Steam's own page. Conduit never sees your password.
5. **Pair your server.** In Rust, press **Esc**, open **Rust+**, and click
   **Pair with Server**.

### 3. Finish in Discord

1. Make two roles: **Conduit Admin** (people who manage Conduit) and **Conduit** (people who
   can press the buttons). Give them to your team.
2. Let those roles see the new **Conduit** category.
3. Type **`/conduit setup`** in Discord to check everything is right.

That's it. Your buttons are in **#conduit**, and Conduit now waits quietly in your system
tray.

## Adding devices

In Discord, type **`/conduit setup`** and click **Add device**. Then, in Rust, open
the switch, alarm or storage monitor and choose **Pair**. Give it a name, and it shows up in
**#conduit**.

## Is everything working?

Look at Conduit's icon in the system tray, near the clock:

- **Green:** all good.
- **Amber:** reconnecting, or something needs attention soon.
- **Red:** something is down. Click the icon to see what.

## Need help?

- **[User guide](docs/user-guide.md):** every feature, setting and fix, in detail.
- **[Privacy and safety](docs/privacy-and-safety.md):** what Conduit does with your
  accounts. In short, everything stays on your own PC.
- **[Verifying your download](docs/verifying-your-download.md):** how to check your file is
  genuine.
- **Found a bug?** [Open an issue](https://github.com/raseley/conduit/issues/new). Found a
  security problem? See [SECURITY.md](SECURITY.md).

## For developers

Conduit is open source, and contributions are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) to build it from source.

## License

[MIT](LICENSE)
