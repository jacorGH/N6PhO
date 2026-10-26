# N6PhO

N64 netplay on your phone: up to 4 players plus spectators, built on EmulatorJS
(mupen64plus_next core) and PeerJS, with a Delta-style touch controller.

## How it works
- **The host's phone runs the game** and streams video + audio to everyone over WebRTC.
  Only the host needs the ROM.
- **Guests send only controller input** back; the host feeds it into ports 2–4.
- **Spectators** watch without a port. The host can move people between watching and playing.

## Private screens (no screen watching)
Split-screen games put every player's view on one picture. With **Private screens** on, the host
cuts the picture up *before sending it*, so each player only ever receives their own view.
The host's own screen shows only port 1's view too. Spectators always get the whole game.

- Host menu → Screens → pick the game's layout: top / bottom, left / right, or quarters.
  The choice is remembered per game.
- Turn it on when the match starts and off for menus (menus use the whole screen).
- Players whose port isn't part of the split (e.g. port 3 in a 2-player match) see the whole game.
- Top / bottom halves are wide strips; landscape gives them much more room.

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

## Icon
`icons/` holds the home-screen icon (180 px for iPhone, 192/512 px for Android) and favicon.
`manifest.json` makes it installable with **Add to Home Screen**.

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
