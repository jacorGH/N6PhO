// Host: runs EmulatorJS, sends each guest their own picture (full game, or only their part of the
// split screen when private screens are on), and applies every player's input.
const Host = (() => {
  const C = window.N6;
  const { $, esc } = App;
  let peer = null, code = '', hostName = 'Host', started = false, pingTimer = 0, romFile = null, gameName = '';
  let ice = null, pending = null;
  let frameEl = null, everStarted = false, perfTimer = 0; // frameEl = the emulator's frame (emu.html)
  const bridge = () => (frameEl && frameEl.contentWindow && frameEl.contentWindow.__n6) || null; // ice = ICE servers in use; pending = direct invite waiting for a reply
  let audioTrack = null, drawRaf = 0, lastDraw = 0;
  let priv = false, split = 'quad', quality = 'auto', mid = 0.06;
  let preset = null, gw = 0; // gw = CSS width of the emulator box (sets its render resolution)
  const perf = { frames: 0, lastNum: null, lastT: 0, emuFps: null, hostFps: null, stalls: 0, stalledFor: 0, warned: false };
  const clients = new Map();               // peerId -> client
  const ports = [null, null, null, null];  // index 0 is always the host
  const local = { slot: 0, last: new Map() };
  const views = new Map();                 // region key -> { canvas, ctx, track, rect }

  // Split-screen regions. `mid` widens each region past the split line so things the game
  // draws across the middle (Conker's timer, scores) stay visible to everyone.
  const SPLIT_PORTS = { tb: 2, lr: 2, quad: 4 };
  function regionRect(sp, i) {
    const m = mid;
    if (sp === 'tb') return i === 0 ? [0, 0, 1, 0.5 + m] : [0, 0.5 - m, 1, 0.5 + m];
    if (sp === 'lr') return i === 0 ? [0, 0, 0.5 + m, 1] : [0.5 - m, 0, 0.5 + m, 1];
    const x = i % 2 ? 0.5 - m : 0, y = i > 1 ? 0.5 - m : 0;
    return [x, y, 0.5 + m, 0.5 + m];
  }

  function open(file, name) {
    romFile = file;
    hostName = name;
    gameName = file.name.replace(/\.[^.]+$/, '');
    preset = C.perfPresets[App.prefs.get('perf')] || C.perfPresets.balanced;
    C.streamFps = preset.fps;
    Voice.init(); // must happen inside the tap that opened the room

    // The room opens right away; the lobby server is only needed for room codes.
    App.enterPlay('host', { onLeave: close });
    $('#play').classList.add('prestart');
    $('#sheetCode').textContent = '…';
    Skin.mount($('#skin'), {
      onState: (s) => applyInput(local, s), onMenu: App.openMenu, gamepad: false,
      onAction: (a) => (a === 'quicksave' ? gameCall('quickSave', 'Saved.') : gameCall('quickLoad', 'Loaded.'))
    });
    wireScreens();
    render();
    badge();
    loadEmulator(romFile);
    if (!pingTimer) pingTimer = setInterval(pingAll, 2000);
    Relay.iceServers().then((servers) => { ice = servers; startLobby(); });

    $('#inviteBtn').onclick = invite;
    wireDirect();
    $('#portList').onclick = onAction;
    $('#specList').onclick = onAction;
    MicUI.wire({ start: () => Voice.startHostMic(), stop: () => Voice.stopMic() });
    const qEl = $('#qualitySel');
    quality = App.prefs.get('quality') || 'auto';
    qEl.value = quality;
    qEl.onchange = () => { quality = qEl.value; App.prefs.set('quality', quality); for (const c of clients.values()) c.rate = null; };
    $('#ejsMenuBtn').onclick = () => setNative(true);
    $('#ejsDone').onclick = () => setNative(false);
    $('#swapRom').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; swapGame(f); };
    $('#qsBtn').onclick = () => gameCall('quickSave', 'Saved.');
    $('#qlBtn').onclick = () => gameCall('quickLoad', 'Loaded.');
  }

  function close() {
    for (const c of clients.values()) send(c, { t: 'closed' });
    Voice.stopMic();
    if (pending) pending.close();
    try { if (peer) peer.destroy(); } catch (e) {}
  }

  // ---------- Room codes (lobby server) ----------
  function startLobby() {
    code = App.makeCode();
    const me = new Peer(C.peerPrefix + code, App.peerOptions(ice));
    peer = me;
    me.on('open', () => {
      $('#sheetCode').textContent = code;
      badge();
      App.toast(`Room ${code} is open. Tap play on the game to start.`);
    });
    me.on('connection', (dc) => {
      const L = Links.fromPeerJS(dc, ice);
      L.on('open', () => onJoin(L));
    });
    me.on('disconnected', () => { if (!me.destroyed) try { me.reconnect(); } catch (e) {} });
    me.on('error', (err) => {
      if (err.type === 'unavailable-id') { me.destroy(); startLobby(); return; }
      if (err.type === 'peer-unavailable') return;
      if (['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(err.type) && !me.open) {
        code = '';
        $('#sheetCode').textContent = '—';
        badge();
        App.toast('Room codes aren’t available right now. Use Invite directly in the menu.');
      }
    });
  }

  // ---------- Direct invites (no lobby server) ----------
  function wireDirect() {
    $('#dInviteBtn').onclick = createInvite;
    $('#dShareInvite').onclick = async () => {
      const url = $('#dInviteCode').value;
      try {
        if (navigator.share) await navigator.share({ title: 'N6PhO', text: `Join my N6PhO game: ${url}` });
        else { await navigator.clipboard.writeText(url); App.toast('Invite copied.'); }
      } catch (e) {}
    };
    $('#dCopyInvite').onclick = async () => {
      try { await navigator.clipboard.writeText($('#dInviteCode').value); App.toast('Invite copied.'); }
      catch (e) { $('#dInviteCode').select(); }
    };
    $('#dPaste').onclick = async () => {
      try { $('#dReply').value = await navigator.clipboard.readText(); } catch (e) { $('#dReply').focus(); }
    };
    $('#dConnect').onclick = acceptReply;
  }

  async function createInvite() {
    if (!ice) { App.toast('Still getting ready, try again in a second.'); return; }
    if (pending) pending.close();
    const status = $('#dStatus');
    status.textContent = 'Preparing invite…';
    $('#dInviteBtn').disabled = true;
    const L = new Links.DirectLink(ice, true);
    pending = L;
    try {
      const relay = await Relay.shareable();
      const text = await L.createInvite({ name: hostName, room: code, relay });
      if (pending !== L) return;
      $('#dInviteCode').value = `${location.origin}${location.pathname}#invite=${text}`;
      $('#dReply').value = '';
      $('#dInviteBox').hidden = false;
      status.textContent = relay
        ? 'Send this to one friend (it includes your relay logins), then paste their reply.'
        : 'Send this to one friend, then paste their reply.';
    } catch (e) {
      status.textContent = 'Couldn’t make an invite. Try again.';
    } finally { $('#dInviteBtn').disabled = false; }

    // The friend's first message says who they are.
    const hello = (m) => {
      if (!m || m.t !== 'hello') return;
      L.off('data', hello);
      L.metadata = { name: m.name, role: m.role, token: m.token };
      if (pending === L) pending = null;
      $('#dInviteBox').hidden = true;
      status.textContent = '';
      onJoin(L);
    };
    L.on('data', hello);
  }

  async function acceptReply() {
    const L = pending, status = $('#dStatus');
    if (!L) { status.textContent = 'Create an invite first.'; return; }
    try {
      await L.acceptReply($('#dReply').value);
    } catch (e) { status.textContent = e.message; return; }
    status.textContent = 'Connecting…';
    setTimeout(() => {
      if (pending === L && !L.open) {
        status.textContent = 'Couldn’t connect. One of you may be on a strict network: set up Your relay with sharing on, then send a new invite.';
      }
    }, 20000);
  }

  // ---------- Private screens ----------
  function wireScreens() {
    const privEl = $('#optPrivate'), splitEl = $('#splitSel');
    split = App.prefs.get('split:' + gameName) || 'quad';
    splitEl.value = split;
    privEl.checked = false;
    privEl.onchange = () => {
      priv = privEl.checked;
      updateViews();
      App.toast(priv ? 'Private screens on. Everyone sees only their own view.' : 'Private screens off. Everyone sees the whole game.');
      broadcast();
    };
    splitEl.onchange = () => {
      split = splitEl.value;
      App.prefs.set('split:' + gameName, split);
      updateViews();
      broadcast();
    };
    const midEl = $('#midRange');
    mid = App.prefs.get('mid:' + gameName) ?? App.prefs.get('mid');
    midEl.value = mid;
    const showMid = () => { $('#midVal').textContent = mid ? `${Math.round(mid * 100)}%` : 'off'; };
    showMid();
    midEl.oninput = () => {
      mid = +midEl.value;
      App.prefs.set('mid:' + gameName, mid);
      showMid();
      for (const [k, v] of views) v.rect = rectOf(k);
      updateViews();
    };
    App.onLayout(placeGame);
  }

  function keyFor(slot) {
    if (!priv || slot == null) return 'full';
    return slot < SPLIT_PORTS[split] ? `${split}:${slot}` : 'full';
  }
  function rectOf(key) {
    if (key === 'full') return [0, 0, 1, 1];
    const [sp, i] = key.split(':');
    return regionRect(sp, +i);
  }

  function getView(key) {
    let v = views.get(key);
    if (!v) {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 480;
      let shelf = document.getElementById('viewShelf');
      if (!shelf) {
        // Some browsers only stream canvases that are in the page, so keep them in an invisible shelf.
        shelf = document.createElement('div');
        shelf.id = 'viewShelf';
        shelf.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
        document.body.appendChild(shelf);
      }
      shelf.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      const track = canvas.captureStream(C.streamFps).getVideoTracks()[0];
      if (track && 'contentHint' in track) track.contentHint = 'motion';
      v = { canvas, ctx, track, rect: rectOf(key) };
      views.set(key, v);
    }
    return v;
  }

  function updateViews() {
    for (const c of clients.values()) {
      const k = keyFor(c.slot);
      if (k !== c.viewKey) { c.viewKey = k; if (started) swapTrack(c, getView(k).track); }
    }
    for (const [k, v] of views) {
      if (![...clients.values()].some((c) => c.viewKey === k)) { v.track.stop(); v.canvas.remove(); views.delete(k); }
    }
    const [, , w, h] = rectOf(keyFor(0));
    App.setAspect((w * 4) / (h * 3));
    placeGame();
  }

  function swapTrack(c, track) {
    const pc = c.call && c.call.peerConnection;
    const s = pc && pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    if (s) s.replaceTrack(track).catch(() => callClient(c));
    else callClient(c);
  }

  // The game is 4:3; find it inside the emulator canvas in case it's letterboxed.
  function contentRect(src) {
    const sw = src.width, sh = src.height;
    let gw = sw, gh = sw * 0.75;
    if (gh > sh) { gh = sh; gw = sh * 4 / 3; }
    return [(sw - gw) / 2, (sh - gh) / 2, gw, gh];
  }

  function drawView(v, src, cr) {
    const [x, y, w, h] = v.rect;
    const sx = cr[0] + x * cr[2], sy = cr[1] + y * cr[3], sw = w * cr[2], sh = h * cr[3];
    let ow = Math.round(sw), oh = Math.round(sh);
    if (ow > C.maxStreamWidth) { oh = Math.round((oh * C.maxStreamWidth) / ow); ow = C.maxStreamWidth; }
    ow -= ow % 2; oh -= oh % 2;
    if (ow < 2 || oh < 2) return;
    if (v.canvas.width !== ow || v.canvas.height !== oh) { v.canvas.width = ow; v.canvas.height = oh; }
    v.ctx.drawImage(src, sx, sy, sw, sh, 0, 0, ow, oh);
  }

  // The host sees the live emulator canvas itself (no copying): the 4:3 emulator box is scaled
  // and shifted with CSS so the host's region fills the screen area.
  function placeGame() {
    const box = $('#gameWrap'), area = $('#screenArea');
    if (!gw) setRenderWidth(preset.render / Math.min(window.devicePixelRatio || 1, 3));
    const gh = gw * 0.75;
    const [x, y, w, h] = rectOf(keyFor(0));
    const W = area.clientWidth, H = area.clientHeight;
    if (!W || !H) return;
    const sc = Math.min(W / (w * gw), H / (h * gh));
    const tx = (W - sc * w * gw) / 2 - sc * x * gw, ty = (H - sc * h * gh) / 2 - sc * y * gh;
    box.style.transform = `translate(${tx}px, ${ty}px) scale(${sc})`;
  }

  // Emulator menu mode: show EmulatorJS full-screen and unscaled so its own menus fit the phone.
  function setNative(on) {
    if (on && !started) { App.toast('Start the game first.'); return; }
    App.closeMenu();
    $('#play').classList.toggle('ejs-native', on);
    $('#ejsDone').hidden = !on;
    const b = bridge();
    if (b) b.setChrome(on);
    if (on) App.toast('Tap the game to show the emulator menu.');
    App.layout();
  }

  function setRenderWidth(cssW) {
    gw = Math.max(160, Math.round(cssW));
    const box = $('#gameWrap');
    box.style.width = `${gw}px`;
    box.style.height = `${Math.round(gw * 0.75)}px`;
  }

  // After the game starts, check the real canvas size and correct the box once so the emulator
  // renders at the preset's width (smaller = less work for the phone).
  function fixRenderSize() {
    const cv = emuCanvas();
    if (!cv || !cv.width || !gw) return;
    const ratio = cv.width / gw;
    if (Math.abs(cv.width - preset.render) / preset.render > 0.25 && ratio > 0) {
      setRenderWidth(preset.render / ratio); // the frame resizes, and EmulatorJS follows
    }
    App.layout();
  }

  // Copies for guests are made at the stream frame rate, not every screen refresh.
  function frame(t) {
    perf.frames++;
    if (views.size && t - lastDraw >= 1000 / C.streamFps - 4) {
      lastDraw = t;
      const src = emuCanvas();
      if (src && src.width && src.height) {
        const cr = contentRect(src);
        for (const v of views.values()) drawView(v, src, cr);
      }
    }
    drawRaf = requestAnimationFrame(frame);
  }

  // Once a second: emulator frame rate, screen frame rate, and stall detection.
  function perfTick() {
    const now = performance.now(), dt = (now - perf.lastT) / 1000;
    perf.hostFps = perf.lastT ? Math.round(perf.frames / dt) : null;
    perf.frames = 0;
    const g = gm(), num = g && typeof g.getFrameNum === 'function' ? g.getFrameNum() : null;
    if (num != null && perf.lastNum != null) perf.emuFps = Math.max(0, Math.round((num - perf.lastNum) / dt));
    perf.lastNum = num; perf.lastT = now;
    const paused = window.EJS_emulator && window.EJS_emulator.paused;
    if (started && !paused && perf.emuFps === 0) {
      perf.stalledFor++;
      if (perf.stalledFor === 2) {
        perf.stalls++;
        const audioStuck = App.resumeEmuAudio();
        if (!perf.warned) {
          perf.warned = true;
          App.toast(audioStuck ? 'The game’s audio was paused by iOS, so the game froze. Tap the screen to wake it.' : (App.prefs.get('perf') === 'fast' ? 'The game stalled. This game may be too heavy for this phone; try a lighter one.' : 'The game stalled. Try Fast performance (set before opening a room) or a lighter game.'));
        }
      }
    } else perf.stalledFor = 0;

    const rows = [
      ['Game speed', perf.emuFps == null ? '–' : `${perf.emuFps} fps${perf.stalledFor >= 2 ? ' (frozen)' : ''}`],
      ['Screen', perf.hostFps == null ? '–' : `${perf.hostFps} fps`],
      ['Freezes', String(perf.stalls)],
      ['Game audio', App.emuAudioState()],
      ['Mode', `${App.prefs.get('perf')}, streaming ${C.streamFps} fps`]
    ];
    $('#perfInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  // ---------- Emulator ----------
  // EmulatorJS runs in its own frame (emu.html). Swapping games replaces only the frame.
  let romUrl = null;
  function loadEmulator(file) {
    if (frameEl) { const b = bridge(); if (b) b.flushSaves(); frameEl.remove(); frameEl = null; }
    if (romUrl) URL.revokeObjectURL(romUrl);
    romUrl = URL.createObjectURL(file);
    const f = document.createElement('iframe');
    f.src = 'emu.html';
    f.title = 'Emulator';
    f.setAttribute('allow', 'autoplay; gamepad; fullscreen');
    f.addEventListener('load', () => {
      const b = f.contentWindow && f.contentWindow.__n6;
      if (!b) { App.toast('Could not start the emulator frame.'); return; }
      b.boot({
        core: 'n64', data: C.ejsData, gameUrl: romUrl, gameName, color: '#d8352b',
        options: Object.assign({}, preset.options),
        onGameStart, onError: () => App.toast('Could not load the emulator. Check your connection and reload.')
      });
    }, { once: true });
    frameEl = f;
    $('#gameWrap').appendChild(f);
    App.setEmuBridge(bridge);
    placeGame();
  }

  // ---------- Swap the game without ending the room ----------
  function swapGame(file) {
    if (!file) return;
    App.closeMenu();
    for (const c of clients.values()) release(c);
    release(local);
    started = false;
    audioTrack = null;
    priv = false; $('#optPrivate').checked = false;
    perf.lastNum = null; perf.stalledFor = 0; perf.warned = false;
    romFile = file;
    gameName = file.name.replace(/\.[^.]+$/, '');
    // per-game screen settings
    split = App.prefs.get('split:' + gameName) || 'quad'; $('#splitSel').value = split;
    mid = App.prefs.get('mid:' + gameName) ?? App.prefs.get('mid'); $('#midRange').value = mid;
    $('#midVal').textContent = mid ? `${Math.round(mid * 100)}%` : 'off';
    for (const [k, v] of views) v.rect = rectOf(k);
    updateViews();
    $('#play').classList.add('prestart');
    for (const c of clients.values()) send(c, { t: 'note', text: `${hostName} is switching to ${gameName}…` });
    broadcast();
    loadEmulator(file);
    App.toast(`Loading ${gameName}. Tap play on the game to start. Everyone stays connected.`);
  }

  function gm() { const b = bridge(); return b ? b.gameManager() : null; }
  function sim(player, id, value) { const g = gm(); if (g && g.simulateInput) g.simulateInput(player, id, value); }
  function gameCall(fn, done) {
    const g = gm();
    if (!started || !g || typeof g[fn] !== 'function') { App.toast('Start the game first.'); return; }
    try { g[fn](1); App.toast(done); App.closeMenu(); } catch (e) { App.toast('That didn’t work in this build.'); }
  }
  function emuCanvas() { const b = bridge(); return b ? b.canvas() : null; }

  function onGameStart() {
    started = true;
    everStarted = true;
    $('#play').classList.remove('prestart');
    setTimeout(fixRenderSize, 500);
    App.layout();
    if (!drawRaf) drawRaf = requestAnimationFrame(frame);
    if (!perfTimer) perfTimer = setInterval(perfTick, 1000);
    updateViews();
    attachAudio(0);
    // Guests already watching keep their stream through a game swap; only call those without one.
    for (const c of clients.values()) if (!c.call || c.call.closed) callClient(c);
    broadcast();
  }

  // Game audio starts a moment after the game. It feeds each guest's mix (game + voices).
  // Without Web Audio, fall back to sending the raw game audio and re-calling guests.
  function attachAudio(tries) {
    const b = bridge();
    const a = b ? b.audioTrack() : null;
    if (a) {
      if (!audioTrack) {
        audioTrack = a;
        if (!Voice.setGame(a) && tries > 0) for (const c of clients.values()) callClient(c);
      }
      return;
    }
    if (tries < 20) setTimeout(() => attachAudio(tries + 1), 1000);
  }

  function callClient(c) {
    if (!started) return;
    try { if (c.call) c.call.close(); } catch (e) {}
    c.viewKey = keyFor(c.slot);
    const tracks = [getView(c.viewKey).track];
    const mix = Voice.outFor(c.id);
    if (mix) tracks.push(mix); else if (audioTrack) tracks.push(audioTrack);
    const call = c.link.call(new MediaStream(tracks), { kind: 'game' });
    c.call = call;
    c.stats = null; c.statPrev = null;
    setTimeout(() => {
      if (!call.closed) NetStats.applyRate(call.peerConnection, c.rate || C.videoBitrate, C.streamFps);
    }, 2500);
  }

  // Every 2 s: read each guest's connection and adjust their picture quality.
  async function sampleStats(c) {
    const pc = c.call && c.call.peerConnection;
    if (!pc || pc.connectionState === 'closed') return;
    try {
      const st = await NetStats.outbound(pc, c.statPrev);
      c.statPrev = st;
      if (st.kbps == null) return;
      c.stats = st;
      const { rate, fps } = NetStats.adapt(c, st, quality);
      if (rate !== c.rate || fps !== c.fps) { c.rate = rate; c.fps = fps; NetStats.applyRate(pc, rate, fps); }
    } catch (e) { /* stats are best-effort */ }
  }

  // ---------- Guests ----------
  function onJoin(link) {
    const meta = link.metadata || {};
    const token = typeof meta.token === 'string' ? meta.token.slice(0, 64) : null;
    const c = {
      id: link.id, link, token, name: String(meta.name || 'Guest').slice(0, 16),
      slot: null, rtt: null, call: null, voiceCall: null, viewKey: null, last: new Map(),
      lastSeen: Date.now(), rate: null, fps: null, stats: null, statPrev: null
    };

    // Same person on a new connection (reload or network change): take over the old one.
    let back = null;
    if (token) {
      const ghost = [...clients.values()].find((x) => x.token === token);
      if (ghost) { back = ghost.slot; drop(ghost, 'replaced'); }
      const held = ports.findIndex((p) => p && p.reserved && p.token === token);
      if (held > 0) { back = held; ports[held] = null; }
    }

    clients.set(c.id, c);
    if (back != null && back > 0 && !ports[back]) seat(c, back);
    else if (meta.role === 'player') {
      const s = freeSlot();
      if (s > 0) seat(c, s);
      else send(c, { t: 'note', text: 'All four ports are taken, so you joined as a spectator.' });
    }
    link.on('data', (d) => onData(c, d));
    link.on('close', () => drop(c, 'lost'));
    link.on('call', (call) => onGuestCall(c, call));
    callClient(c);
    App.toast(back != null ? `${c.name} is back on port ${c.slot + 1}.` : `${c.name} joined${c.slot != null ? ` on port ${c.slot + 1}` : ' to watch'}.`);
    broadcast();
  }

  // Guests send their mic to the host on a one-way call through their link.
  function onGuestCall(c, call) {
    if (call.metadata.kind !== 'voice') { call.close(); return; }
    try { if (c.voiceCall) c.voiceCall.close(); } catch (e) {}
    c.voiceCall = call;
    call.answer();
    call.on('stream', (st) => { Voice.addVoice(c.id, st); render(); });
    call.on('close', () => { if (c.voiceCall === call) { Voice.removeVoice(c.id); c.voiceCall = null; render(); } });
  }

  function onData(c, d) {
    if (!d || typeof d !== 'object') return;
    c.lastSeen = Date.now();
    if (d.t === 'in') applyInput(c, d);
    else if (d.t === 'relay') {
      // Broker: pass connection messages between guests (voice mesh). Only signalling is forwarded.
      const to = clients.get(d.to);
      if (to && d.msg && d.msg.t === 'sig') send(to, { t: 'relay', from: c.id, msg: d.msg });
    }
    else if (d.t === 'bye') drop(c, 'leave');
    else if (d.t === 'pong' && typeof d.ts === 'number') c.rtt = Math.round(performance.now() - d.ts);
  }

  function applyInput(c, d) {
    if (c.slot == null || !started) return;
    const bits = d.b | 0;
    const x = App.clamp(+d.x || 0), y = App.clamp(+d.y || 0);
    const vals = {};
    C.digitalOrder.forEach((n, i) => {
      const on = (bits >> i) & 1;
      vals[C.n64[n]] = on ? (C.cButtons.includes(n) ? 0x7fff : 1) : 0;
    });
    vals[C.n64.SX_POS] = Math.round(Math.max(0, x) * 0x7fff);
    vals[C.n64.SX_NEG] = Math.round(Math.max(0, -x) * 0x7fff);
    vals[C.n64.SY_POS] = Math.round(Math.max(0, y) * 0x7fff);
    vals[C.n64.SY_NEG] = Math.round(Math.max(0, -y) * 0x7fff);
    for (const [id, v] of Object.entries(vals)) {
      if (c.last.get(id) !== v) { sim(c.slot, +id, v); c.last.set(id, v); }
    }
  }

  function release(c) {
    if (c.slot == null) return;
    for (const id of new Set(Object.values(C.n64))) sim(c.slot, id, 0);
    c.last.clear();
  }

  function freeSlot() { for (let i = 1; i < 4; i++) if (!ports[i]) return i; return -1; }
  function seat(c, s) { release(c); if (c.slot != null && ports[c.slot] === c) ports[c.slot] = null; ports[s] = c; c.slot = s; updateViews(); }
  function unseat(c) { release(c); if (c.slot != null && ports[c.slot] === c) ports[c.slot] = null; c.slot = null; updateViews(); }

  // reason: lost (connection dropped, port is held), leave, kick, replaced
  function drop(c, reason) {
    if (!clients.has(c.id)) return;
    clients.delete(c.id); // first, so the close events below can't re-enter
    const slot = c.slot;
    unseat(c);
    if (reason === 'lost' && slot != null && c.token) {
      ports[slot] = { reserved: true, token: c.token, name: c.name, until: Date.now() + C.reconnectWindow };
    }
    try { if (c.call) c.call.close(); } catch (e) {}
    try { if (c.voiceCall) c.voiceCall.close(); } catch (e) {}
    try { c.link.close(); } catch (e) {}
    Voice.removeVoice(c.id);
    Voice.dropOut(c.id);
    updateViews();
    if (reason === 'lost' && slot != null) App.toast(`${c.name} lost connection. Holding port ${slot + 1} for them.`);
    else if (reason !== 'replaced') App.toast(`${c.name} left.`);
    broadcast();
  }

  function send(c, m) { c.link.send(m); }

  function rosterFor(c) {
    return {
      t: 'roster', code,
      ports: ports.map((p, i) => (i === 0 ? hostName : p ? p.name : null)),
      rate: c.rate,
      game: gameName,
      peers: [...clients.values()].filter((x) => x !== c).map((x) => ({ id: x.id, name: x.name })),
      you: c.slot,
      watching: [...clients.values()].filter((x) => x.slot == null).length,
      rtt: c.rtt, started,
      priv, privateView: keyFor(c.slot) !== 'full'
    };
  }

  function broadcast() {
    for (const c of clients.values()) send(c, rosterFor(c));
    render();
    badge();
  }

  function pingAll() {
    const ts = performance.now(), now = Date.now();
    for (const c of [...clients.values()]) {
      if (now - c.lastSeen > 8000) { drop(c, 'lost'); continue; } // silent for 8 s: treat as dropped
      send(c, { t: 'ping', ts, roster: rosterFor(c) });
      sampleStats(c);
    }
    let changed = false;
    for (let i = 1; i < 4; i++) {
      const p = ports[i];
      if (p && p.reserved && now > p.until) { ports[i] = null; changed = true; App.toast(`${p.name} didn’t come back. Port ${i + 1} is open.`); }
    }
    if (changed) broadcast(); else { render(); badge(); }
  }

  // ---------- Host UI ----------
  function badge() {
    const players = 1 + ports.filter((p, i) => i > 0 && p).length;
    const watching = [...clients.values()].filter((c) => c.slot == null).length;
    $('#badge').innerHTML = `<span class="dot p1"></span><span>${code ? `Room ${esc(code)}` : 'Direct'}</span><span class="dim">${players}P${watching ? ` +${watching} watching` : ''}${priv ? ', private' : ''}</span>`;
  }

  function render() {
    $('#portList').innerHTML = [0, 1, 2, 3].map((i) => {
      const n = i + 1;
      if (i === 0) return `<li class="port p1"><span class="n">1</span><span class="who">${esc(hostName)}<small>You, hosting</small></span></li>`;
      const p = ports[i];
      if (!p) return `<li class="port p${n} open"><span class="n">${n}</span><span class="who">Open<small>Waiting for a player</small></span></li>`;
      if (p.reserved) {
        const secs = Math.max(0, Math.round((p.until - Date.now()) / 1000));
        return `<li class="port p${n} open"><span class="n">${n}</span><span class="who">${esc(p.name)}<small>Reconnecting… holding for ${secs}s</small></span>
          <span class="acts"><button class="btn small ghost" data-act="free" data-slot="${i}">Free this port</button></span></li>`;
      }
      return `<li class="port p${n}"><span class="n">${n}</span>
        <span class="who">${esc(p.name)}${Voice.talking(p.id) ? ' <span class="vc" title="Voice on">🎙</span>' : ''}<small>${statLine(p)}</small></span>
        <span class="acts">
          <button class="btn small ghost" data-act="unseat" data-id="${esc(p.id)}">Move to watching</button>
          <button class="btn small ghost" data-act="kick" data-id="${esc(p.id)}">Remove</button>
        </span></li>`;
    }).join('');

    const specs = [...clients.values()].filter((c) => c.slot == null);
    const open = freeSlot() > 0;
    $('#specList').innerHTML = specs.length
      ? specs.map((c) => `<li><span class="who">${esc(c.name)}${Voice.talking(c.id) ? ' <span class="vc" title="Voice on">🎙</span>' : ''}<small>${statLine(c)}</small></span>
          <span class="acts">
            ${open ? `<button class="btn small" data-act="seat" data-id="${esc(c.id)}">Give a port</button>` : ''}
            <button class="btn small ghost" data-act="kick" data-id="${esc(c.id)}">Remove</button>
          </span></li>`).join('')
      : '<li class="dim small empty">No one is watching yet.</li>';
  }

  function statLine(c) {
    if (c.rtt == null) return 'Connecting…';
    const st = c.stats;
    const g = NetStats.grade(c.rtt, st && st.loss);
    const parts = [`<span class="sig" data-q="${g}"><i></i><i></i><i></i></span>${c.rtt} ms`];
    if (st) {
      parts.push(NetStats.fmtKbps(st.kbps));
      if (st.loss != null) parts.push(`${NetStats.fmtLoss(st.loss)} loss`);
      if (st.fps != null) parts.push(`${st.fps} fps`);
      if (st.relay) parts.push('relayed');
    }
    return parts.join(', ');
  }

  function onAction(e) {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'free') { ports[+b.dataset.slot] = null; broadcast(); return; }
    const c = clients.get(b.dataset.id);
    if (!c) return;
    if (b.dataset.act === 'unseat') unseat(c);
    if (b.dataset.act === 'seat') { const s = freeSlot(); if (s > 0) seat(c, s); }
    if (b.dataset.act === 'kick') {
      send(c, { t: 'kick' });
      setTimeout(() => drop(c, 'kick'), 300);
    }
    broadcast();
  }

  async function invite() {
    if (!code) { App.toast('Room codes aren’t available right now. Use Create invite below.'); return; }
    const url = `${location.origin}${location.pathname}?room=${code}`;
    try {
      if (navigator.share) { await navigator.share({ title: 'N6PhO', text: `Join my N6PhO room: ${code}`, url }); return; }
      await navigator.clipboard.writeText(url);
      App.toast('Invite link copied.');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      App.toast(`Room code ${code}`);
    }
  }

  return { open };
})();
