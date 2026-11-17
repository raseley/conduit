# Conduit user guide

Everything about setting up and running Conduit, in more detail than the
[README](../README.md). Jump to what you need:

- [First-time setup](#first-time-setup)
- [Running it for your group](#running-it-for-your-group)
- [Day to day](#day-to-day)
- [Troubleshooting](#troubleshooting)

## First-time setup

The first time Conduit runs, a setup window walks you through six steps. Each step explains
exactly what to click, so this is just what to expect. You'll need to be signed in to
Discord in your browser.

1. **Create bot.** You make your own Discord bot in the Discord Developer Portal and paste
   its token into Conduit. Conduit checks the token with Discord right away.
2. **Enable intents.** You turn on the bot's **Server Members Intent**, which lets it keep
   up with your server's members and their roles. Conduit checks this with Discord too; the
   bot can't log in without it.
3. **Invite bot.** You add the bot to your Discord server with a link that asks for just
   the permissions Conduit needs, and Conduit finds your server by itself. Unless you untick
   it, Conduit also creates a private **Conduit** category with **#conduit** for its panels
   and **#conduit-log** for its activity log. When you set Conduit up again, for example
   after **Reset configuration**, the bot is usually still in your server: Conduit shows it
   straight away, and you click **Continue** instead of inviting the bot again.
4. **Connect Steam.** You sign in with the Steam account you play Rust with, which
   registers Conduit with Rust+ the same way the phone app does.
5. **Pair server.** In Rust, join your server, press Esc, open **Rust+** and click
   **Pair with Server**. Conduit catches the pairing by itself.
6. **Finish in Discord.** The last screen lists what is left to do in Discord: give your
   roles access to the Conduit category, then run **/conduit setup** to check the roles
   (see below).

From then on, Conduit lives in the system tray.

## Running it for your group

### The Setup hub

Run **`/conduit setup`** in your Discord server to open the Setup hub. Only you see it.
From there you can:

- pick the **control channel** for the panels and the **logging channel** for the activity
  log (the wizard's #conduit and #conduit-log, or channels of your own);
- choose the **Admin roles** and **User roles** (see below);
- add devices and cameras, post the panels afresh with **Rebuild panels**, set up **Pushover**,
  and turn **Start on login** on or off.

Anyone with a Conduit role can run **`/conduit status`** for a quick status with links to
the panels.

### Who can do what

- **User roles** can use the devices: turn switches on and off, refresh, look at and watch
  storage contents, and capture cameras.
- **Admin roles** can do all of that, plus open the Setup hub, add, rename and remove
  devices, and change switch and alarm settings.
- **Everyone else** can see the panels (if they can see the channel) but can't press
  anything. Conduit checks every click and tells them they need a role.

Name your roles **Conduit Admin** and **Conduit** and you don't have to choose them: while
no Admin or User role is chosen, Conduit takes the role called **Conduit Admin** as the
Admin role and the one called **Conduit** as the User role (capital letters don't matter).
It looks when it starts and whenever the Setup hub opens, and never replaces roles you chose
yourself.

Your Discord server's owner and administrators can always use the Setup hub, even before
any roles are chosen, so you can't lock yourself out. They still need a Conduit role to use
the devices.

### The panels

Conduit keeps one group of messages per Rust server in the control channel: a **Server**
message (status, players and queue, your team), then **Switches**, **Alarms**, **Storage**
and **Cameras**, each in its own message once you have a device of that type. Conduit
edits these in place as things change instead of posting new ones.

Each device is one line with one button for the everyday action: **Turn on** / **Turn off**
for a switch, **Contents** for a storage monitor, **Capture** for a camera. A storage
monitor's contents are shown only to you. A camera's picture is posted in the logging channel
and mentions you (with no logging channel set, only you see it), and that camera's
**Capture** stays disabled for 30 seconds afterwards. Each message ends with a **Manage a
switch / alarm / monitor / camera…** menu for everything else: renaming, auto-off timers,
alarm loudness and paging, watching a storage monitor, and removing a device.

Panels only ever show what the server last reported. A switch Conduit hasn't heard from
yet shows as **Unknown** with a **Refresh** button rather than a guess, and after a click
the button shows **Waiting…** until the server confirms it. If the server connection drops,
the Server message shows 🟡 Reconnecting, then 🔴 Offline if it's still down after a minute,
and the buttons are disabled until it's back.

### The activity log

The logging channel gets a timestamped line for every button press and command (with who
did it), every device change, and in-game events such as deaths and team chat. These lines
are **silent**: the channel shows as unread but nobody gets a notification. Two things do
notify:

- **Alarms**, at the level you choose per alarm: **Silent** (no notification),
  **Normal** (the default: a notification, no ping), **Active** (pings @here) or
  **Everyone** (pings @everyone).
- **Steam sign-in reminders** (see [Day to day](#day-to-day)), which ping your Admin
  roles.

Alarm alerts are posted in the logging channel, so choose one if you want them.

### Pairing more devices and servers

- **A device** (smart switch, smart alarm or storage monitor): click **Add device** in the
  Setup hub, then in Rust open the device and choose **Pair**. Conduit asks you to name it
  and adds it to the panels.
- **A camera:** click **Add camera** in the Setup hub and enter the camera's identifier,
  as set on it in-game.
- **Another server:** join it in Rust and use **Pair with Server** in the Rust+ menu, as in
  setup. Conduit adds its panels by itself.

### Phone alerts with Pushover (optional)

[Pushover](https://pushover.net/) is a separate app that sends alerts to your phone. Click
**Pushover…** in the Setup hub and enter your Pushover application token and user (or
group) key. Then pick an alarm in **Manage an alarm…** and set its **Paging priority**
(Low, Medium or High) for each alarm that should page you.

## Day to day

### The tray icon

Conduit runs in the Windows system tray. The ring on its icon shows how things are:

- **Green:** everything is connected.
- **Amber:** something is reconnecting, or needs attention soon.
- **Red:** a connection is down, or the Steam sign-in has expired.

Click the icon to open the **Status** window. Right-click it for **Status…**,
**Sign in with Steam again…** and **Quit Conduit**. Closing a window doesn't stop Conduit;
use **Quit Conduit** for that.

### The Status window

It has a row for each Rust server, one for the push listener that receives pairings and
alarms, and one for Discord, each saying whether it is connected. When the Steam sign-in
needs attention there is a **Steam sign-in** row and a **Sign in with Steam again** button.
At the bottom:

- **Copy diagnostics** copies a report for bug reports (see
  [Troubleshooting](#troubleshooting)).
- **Reset configuration** deletes Conduit's panels from Discord and erases all its saved
  settings, sign-ins, servers and devices, then starts setup again. It asks first, and it
  can't be undone.

### Start on login

Turn **Start on login** on in the Setup hub and Conduit starts with Windows, straight into
the tray. It is off by default.

### When the Steam sign-in expires

The Rust+ token from your Steam sign-in lasts about two weeks. Conduit renews it by itself
from two days before it expires. If that doesn't work, Conduit reminds you in the logging
channel (or the control channel if there is none), more often as the deadline gets closer,
and pings your Admin roles. To fix it, on the PC running Conduit, right-click the tray icon
and choose **Sign in with Steam again…**. Until it expires, everything keeps working.

### When the PC sleeps

While the PC is asleep or off, Conduit is too: the bot goes offline in Discord, buttons
don't respond, and alarms during that time can be missed. When the PC wakes, Conduit
reconnects by itself.

### When the server wipes

After a map wipe your old devices are gone. Remove each one with its **Manage** menu and
pair the new ones. If the server itself stops connecting, pair it again with **Pair with Server** in the
in-game Rust+ menu; Conduit recognizes it and keeps its settings.

## Troubleshooting

**The bot is offline in Discord.** Check that the PC is on and Conduit is in the tray, then
open the Status window and look at the Discord row. If you reset the bot's token in the
Developer Portal, or turned off the Server Members Intent, the bot can't log in: turn the
intent back on, or use **Reset configuration** and run setup again with the new token.

**The Status window says Conduit "can't post".** The bot can't send in one of its channels.
Make sure the bot's role can see and send messages in the control and logging channels
(channel settings, **Permissions**).

**The pairing never arrives.** Make sure you are playing on the server you are pairing,
that the server has Rust+ turned on, and that Conduit is running with its push listener
connected (Status window). Then try **Pair with Server** (or the device's **Pair**) again.

**A switch shows "Unknown".** Conduit hasn't heard that switch's state from the server, for
example just after a restart or a reconnect. It never guesses; press the switch's
**Refresh** button to ask the server again. If it stays unknown, the server can't reach it: you may have lost access
to the tool cupboard that covers it, or it was removed in-game.

**A camera won't capture.** Rust+ can't show cameras while the paired player is connected
to the server in-game. Disconnect from the server, then try again.

**Steam sign-in is refused.** If Facepunch's login didn't go through, try again; it is
usually temporary. If Conduit says the sign-in "may have changed" or Rust+ didn't accept
the registration more than once, click **Copy diagnostics** and include it when you report
the problem.

### Reporting a bug

Open the Status window and click **Copy diagnostics**. It copies a report to your
clipboard: Conduit's version, your Windows version, the connection status and recent log
lines. Tokens and keys are left out, but it does include things like your server's name,
so look it over before posting it publicly. Paste it into a
[new issue](https://github.com/raseley/conduit/issues/new).
