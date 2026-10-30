# N6PhO

N64 netplay on your phone: up to 4 players plus spectators, built on EmulatorJS
(mupen64plus_next core) and PeerJS, with a Delta-style touch controller.

## How it works
- **The host's phone runs the game** and streams video + audio to everyone over WebRTC.
  Only the host needs the ROM.
- **Guests send only controller input** back; the host feeds it into ports 2–4.
- **Spectators** watch without a port. The host can move people between watching and playing.

## Performance and freezes
- **Performance** (lobby, under Host a room; applies when you open the room):
  *Quality* for newer phones and lighter games, *Balanced* (default), *Fast* for heavy games like
  Conker. Each preset sets the emulator's internal resolution, its canvas size, and the stream frame
  rate, plus some speed settings in Fast. These are EmulatorJS core options for mupen64plus_next;
  if an EmulatorJS build doesn't recognise one, it's ignored.
- The host now sees the emulator's own canvas directly (scaled with CSS) instead of a per-frame
  copy, and guest pictures are copied at the stream rate (30 fps on Balanced/Fast), not 60.
- **Host menu → Performance** shows game speed (emulator frames per second), screen frame rate,
  how many freezes have happened, and the game audio state. If the game stops advancing for
  2 seconds, N6PhO counts a freeze and tries to recover.
- **Why audio matters:** the emulator keeps time with its audio. iOS can pause web audio (the mic
  switching audio modes, a call, Siri), and that freezes the game while everything else keeps
  working. N6PhO nudges the audio back every second and on every tap. If *Game audio* shows
  anything other than "running" during a freeze, that's the cause.

## Emulator menu
During play, taps on the game don't open EmulatorJS's own menu (it would appear oversized,
because the emulator renders in a small box that's scaled up for speed). To use it, open
**host menu → Game → Emulator menu**: the emulator fills the screen at normal size so its settings,
cheats and save-file import/export fit. Tap the game to show its menu bar, then **Back to N6PhO**.

## Stick and buttons
Menu → Stick and buttons (saved per phone):
- **Stick sensitivity:** how far you push for full tilt.
- **Dead zone:** how far you push before anything happens.
- **Stick response:** *Even*, *Precise* (fine aiming near the centre, good for GoldenEye), or
  *Fast* (reaches full tilt sooner).
- **Floating stick:** wherever your thumb lands becomes the centre.
- **Invert stick up/down.**
- **Button size:** 80% to 130% (built-in skin).
Sensitivity, dead zone, response and invert also apply to a Bluetooth controller's stick.

## Two ways to join
- **Room code** (uses the free PeerJS lobby server to find each other).
- **Direct invite** (no lobby server at all). Host menu → *Invite directly* → **Create invite** →
  share it. Your friend opens the link, taps Join, and shares back a short **reply**. Paste it into
  *Friend’s reply* → **Connect**. One invite per friend. Invites are about 120 characters and replies
  about 110 (more if the invite carries your relay logins).
- Only the first connection differs. Video, game sound, voice and stats are all set up *inside*
  that connection afterwards, so once you're connected nothing needs the lobby server.
- If the lobby server is down, the room still opens: the room code shows "—" and direct invites work.
- Video uses **H.264 first** (iPhones encode it in hardware, easier on the battery), then VP8.
- Direct invites include the room code when there is one, so a direct friend whose connection drops
  can come back through the lobby automatically. With no room code, they need a fresh invite
  (their port is still held for a minute).

## Host as broker
Once friends are connected, the host passes connection messages between them. That's how
guests open voice connections to each other, whether they joined by room code or direct invite,
with no lobby server involved. Only connection messages are passed along; the host doesn't see the audio.

## Your relay (TURN)
Lobby → **Your relay**. A relay carries the game when two networks can't connect directly.
- **Free shared relay** (default): Google STUN + PeerJS's public relay.
- **Cloudflare** (recommended): paste `relay/cloudflare-worker.js` into a free Cloudflare Worker
  (the app has a *Copy the Worker code* button), set three settings (`TURN_KEY_ID`,
  `TURN_KEY_API_TOKEN`, `ACCESS_CODE`), then enter the Worker address and access code. The Worker
  only hands out logins that expire within a day, and only to someone with your access code.
- **Your own server**: run `relay/setup-coturn.sh` on a free Ubuntu server (e.g. Oracle Always Free):
  `curl -fsSLO https://YOU.github.io/n6pho/relay/setup-coturn.sh && sudo bash setup-coturn.sh https://YOU.github.io/n6pho/`
  It prints a link; open it on your phone and N6PhO saves the relay. Logins are made on your
  phone from the server's secret and expire within a day. Open UDP/TCP 3478 and UDP 49160–49999
  in the cloud firewall.
- **Save and test** checks that the relay really hands out a relayed address.
- **Share my relay with friends I invite**: direct invites carry those short-lived logins, so a
  friend on a strict network can still connect. Anyone holding that invite link could use your
  relay until the logins expire.

## Voice chat
Menu → Voice chat → **Microphone**. Everyone in the room hears you, spectators included.
A mic button appears next to the status badge; tap it to mute and unmute.
- Full mesh, so everyone hears everyone: the host's voice rides along with the game sound it
  sends, guests send their mic to the host, and guests call each other directly through the host
  as broker.
- Use headphones if you can. Phone speakers plus a mic can echo, and iPhones lower game volume
  while the mic is on.
- If voices are silent, tap the screen once (browsers hold back sound until you tap).

## Auto-reconnect
If a player's connection drops, the host **holds their port for 60 seconds** (shown as
"Reconnecting…" in the host's player list). The player's phone retries on its own and drops
them straight back into the same port, mic included. Reloading the page or rejoining with the
invite link also gets your port back. Nobody else can take a held port; the host can free it early.
Leaving on purpose frees the port right away. Change the hold time with `reconnectWindow` in `js/config.js`.

## Connection stats and picture quality
- **Signal bars** in the badge show each connection at a glance (green good, yellow OK, red poor).
- **Host menu → Players:** ping, bitrate, packet loss, frame rate for every guest, and whether
  the connection goes direct or through a relay server.
- **Guest menu → Connection:** the same from the receiving side, plus picture resolution.
- **Picture quality (host menu):** *Auto* tunes each guest separately: it backs off when that
  guest's connection starts losing packets or lagging, creeps back up when it's clean, and drops
  to 30 fps if the host phone itself is overloaded. *High* and *Data saver* fix the quality instead.

## Private screens (no screen watching)
Split-screen games put every player's view on one picture. With **Private screens** on, the host
cuts the picture up *before sending it*, so each player only ever receives their own view.
The host's own screen shows only port 1's view too. Spectators always get the whole game.

- Host menu → Screens → pick the game's layout: top / bottom, left / right, or quarters.
  The choice is remembered per game.
- Turn it on when the match starts and off for menus (menus use the whole screen).
- Players whose port isn't part of the split (e.g. port 3 in a 2-player match) see the whole game.
- Top / bottom halves are wide strips; landscape gives them much more room.
- **Shared middle strip** (0–20%, default 6%, remembered per game) widens each player's view past
  the split line so things drawn across the middle, like Conker's timer, stay visible to everyone.
  The trade-off is a thin sliver of the neighbouring view.

## Touch controller
- **Portrait:** game on top, full controller deck below. On tall phones the controls lift
  toward your thumbs.
- **Landscape:** game fills the screen and translucent buttons float over it
  (opacity is adjustable in the menu).
- **Slide between buttons:** keep your thumb down and slide from A to B, or around the
  C buttons and D-pad (diagonals work).
- **Forgiving hit areas:** touches just outside a button still count.
- **Haptics:** a tick on every press. Android uses vibration; iPhone uses a Safari system-haptic
  trick that works on recent iOS but isn't guaranteed.
- **Controller connected?** Touch controls hide themselves; turn them back on in the menu.
- The host plays port 1 with the same touch controller (EmulatorJS's own pad is hidden).
  The host's Bluetooth controller is still handled by EmulatorJS.

## Menu (☰ on the controller)
- **Host:** room code + share invite, player ports, spectators, quick save / quick load, close room.
- **Guests:** split-screen view crop, sound on, leave room.
- **Everyone:** touch controls on/off, vibration on/off, landscape button opacity.

## Delta skins
Menu → Controls → **Import Delta skin** and pick an N64 `.deltaskin` file. N6PhO reads its layout,
art (PDF or PNG), thumbstick and touch areas, and places the game screen where the skin says.
Skins are stored on the device and can be switched or deleted from the same menu.
Supported Delta inputs: A, B, Z, L, R, Start, D-pad, C buttons, analog stick, menu, quick save/load.

## Built-in skin is data
`js/skin-n64.js` defines every button's position and size for portrait and landscape.
Units: portrait 1u = 1% of screen width, landscape 1u = 1% of screen height. Each item has an
`anchor` (`tl`, `tc`, `tr`, `bl`, `bc`, `br`) and x/y measured from that corner.
Add a new skin by copying the file, changing the name, and setting `skin` in `js/config.js`.

## Icons
Two icon sets: `icons/personal/` (the original) and `icons/public/` (the stand-in for sharing
widely). Switch with `iconSet` at the top of `js/config.js`. Each set has a matching manifest
(`manifest-personal.json`, `manifest-public.json`) so **Add to Home Screen** works on iPhone and
Android. iPhones keep the icon they saved, so remove and re-add the home-screen app after switching.

## Setup
1. Push this folder to a GitHub repo and turn on GitHub Pages (Settings → Pages → main / root).
2. Open the Pages URL on both phones. Add it to the home screen for full-screen play.

## Tuning (js/config.js)
- **Wrong button?** Fix the number in `n64` (libretro RetroPad ids).
- **Can't connect from another home?** Add your own TURN server to `iceServers`.
- **Stream choppy?** Lower `videoBitrate` (host uploads one stream per guest) or `streamFps`.
- **Touch feel:** `hitPad` (extra touch area) and `stickRange` (how far to push for full tilt).

## Known limits
- Host must keep the app open with the screen on (a wake lock is requested).
- Expect roughly 80–200 ms of stream delay for guests.
- Use ROMs you dumped from cartridges you own.
