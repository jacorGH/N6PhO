# N6PhO

N64 netplay on your phone: up to 4 players plus spectators, built on EmulatorJS
(mupen64plus_next core) and PeerJS, with a Delta-style touch controller.

## How it works
- **The host's phone runs the game** and streams video + audio to everyone over WebRTC.
  Only the host needs the ROM.
- **Guests send only controller input** back; the host feeds it into ports 2–4.
- **Spectators** watch without a port. The host can move people between watching and playing.

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

## Skins are data
`js/skin-n64.js` defines every button's position and size for portrait and landscape.
Units: portrait 1u = 1% of screen width, landscape 1u = 1% of screen height. Each item has an
`anchor` (`tl`, `tc`, `tr`, `bl`, `bc`, `br`) and x/y measured from that corner.
Add a new skin by copying the file, changing the name, and setting `skin` in `js/config.js`.

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
