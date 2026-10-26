# Four Ports

N64 netplay in the browser for up to 4 players plus spectators, built on
EmulatorJS (mupen64plus_next core) and PeerJS. This is the Phase 1 feasibility
build: it answers "does Conker/GoldenEye run well enough, and does the
connection hold up between our homes?"

## How it works
- **The host's phone runs the game.** It streams video + audio to every guest
  over WebRTC (PeerJS media calls). Only the host needs the ROM.
- **Guests send only their controller input** back over a PeerJS data channel.
  The host injects it into ports 2–4 with EmulatorJS `simulateInput`.
- **Spectators** get the stream without a port. The host can move people between
  watching and playing at any time.
- No game state is synced between devices, so iPhone vs Android can't desync.

## Setup
1. Push this folder to a GitHub repo and turn on GitHub Pages (Settings → Pages → main / root).
2. Open the Pages URL. It needs HTTPS, which Pages provides.

## Playing
- **Host:** enter your name, choose your ROM (`.z64 / .n64 / .v64 / .zip`), tap **Open room**,
  then tap the play button on the game. Share the invite link or the 4-letter code.
  You play on port 1 using EmulatorJS's own touch controls or a controller.
- **Guest:** open the link (code auto-fills), tap **Join as player** or **Watch**.
  Tap **Turn sound on** once the picture arrives (browsers block audio until you tap).
- **Split-screen crop:** pick *Top half* / *Bottom half* (2-player) or a quarter (3–4 player)
  from the view menu so you only see your own screen. The choice is remembered.
- **Controllers:** any Bluetooth Xbox/PlayStation/MFi pad works for guests. Right stick = C buttons.
  The touch pad hides itself automatically when a controller connects.

## Phase 1 test checklist
- [ ] GoldenEye and Conker run at full speed on the host phone (try each phone as host).
- [ ] Guest in another home connects and sees the stream.
- [ ] Guest inputs control port 2 (check A, B, Z, C buttons, stick in the Controller Pak/options screen).
- [ ] Playable latency (ping is shown on the host list and the guest HUD).
- [ ] 3–4 players + a spectator: host upload holds up.

## Tuning (js/config.js)
- **Wrong button?** Fix the number in `n64` (the ids are libretro RetroPad ids).
- **Can't connect from another home?** Add your own TURN server to `iceServers`.
  PeerJS's default free relay is shared and can be slow or full.
- **Stream choppy?** Lower `videoBitrate` (host uploads one stream per guest:
  2 Mbps × 4 guests = 8 Mbps upload) or `streamFps` to 30.
- **Guest controller layout:** edit `gamepadButtons`.

## Known limits
- Host must keep the app in the foreground and the screen on (a wake lock is requested).
- Expect roughly 80–200 ms of stream delay depending on networks; fine for co-op and
  casual multiplayer, not ideal for twitch shooting.
- Touch pad has no D-pad yet (neither game needs it in play).
- Use ROMs you dumped from cartridges you own.
