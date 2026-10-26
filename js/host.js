// Host: runs EmulatorJS, sends each guest their own picture (full game, or only their part of the
// split screen when private screens are on), and applies every player's input.
const Host = (() => {
  const C = window.N6;
  const { $, esc } = App;
  let peer = null, code = '', hostName = 'Host', started = false, pingTimer = 0, romFile = null, gameName = '';
  let audioTrack = null, drawRaf = 0, hostCtx = null;
  let priv = false, split = 'quad', quality = 'auto';
  const clients = new Map();               // peerId -> client
  const ports = [null, null, null, null];  // index 0 is always the host
  const local = { slot: 0, last: new Map() };
  const views = new Map();                 // region key -> { canvas, ctx, track, rect }

  const SPLITS = {
    tb: [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]],
    lr: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]],
    quad: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]
  };

  function open(file, name) {
    romFile = file;
    hostName = name;
    gameName = file.name.replace(/\.[^.]+$/, '');
    code = App.makeCode();
    Voice.init(); // must happen inside the tap that opened the room
    peer = new Peer(C.peerPrefix + code, App.peerOptions());

    peer.on('open', () => {
      App.enterPlay('host', { onLeave: close });
      $('#play').classList.add('prestart');
      $('#sheetCode').textContent = code;
      Skin.mount($('#skin'), {
        onState: (s) => applyInput(local, s), onMenu: App.openMenu, gamepad: false,
        onAction: (a) => (a === 'quicksave' ? gameCall('quickSave', 'Saved.') : gameCall('quickLoad', 'Loaded.'))
      });
      wireScreens();
      render();
      badge();
      loadEmulator(romFile);
      if (!pingTimer) pingTimer = setInterval(pingAll, 2000);
      App.toast(`Room ${code} is open. Tap play on the game to start.`);
    });
    peer.on('connection', (conn) => conn.on('open', () => onJoin(conn)));
    peer.on('call', (call) => {
      // Guests send their microphone on a separate one-way call.
      const c = clients.get(call.peer);
      if (!c || !call.metadata || call.metadata.kind !== 'voice') { try { call.close(); } catch (e) {} return; }
      try { if (c.voiceCall) c.voiceCall.close(); } catch (e) {}
      c.voiceCall = call;
      call.answer();
      call.on('stream', (st) => { Voice.addVoice(c.id, st); render(); });
      call.on('close', () => { if (c.voiceCall === call) { Voice.removeVoice(c.id); c.voiceCall = null; render(); } });
    });
    peer.on('disconnected', () => {
      App.toast('Lost the room server. Reconnecting… (connected players stay connected)');
      try { peer.reconnect(); } catch (e) {}
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') { peer.destroy(); open(romFile, hostName); return; }
      if (err.type === 'peer-unavailable') return;
      const text = `Connection problem: ${err.type || err.message}.`;
      App.msg('lobbyMsg', text);
      if (!$('#play').hidden) App.toast(text);
      $('#hostBtn').disabled = false;
    });

    $('#inviteBtn').onclick = invite;
    $('#portList').onclick = onAction;
    $('#specList').onclick = onAction;
    MicUI.wire({ start: () => Voice.startHostMic(), stop: () => Voice.stopMic() });
    const qEl = $('#qualitySel');
    quality = App.prefs.get('quality') || 'auto';
    qEl.value = quality;
    qEl.onchange = () => { quality = qEl.value; App.prefs.set('quality', quality); for (const c of clients.values()) c.rate = null; };
    $('#qsBtn').onclick = () => gameCall('quickSave', 'Saved.');
    $('#qlBtn').onclick = () => gameCall('quickLoad', 'Loaded.');
  }

  function close() {
    for (const c of clients.values()) send(c, { t: 'closed' });
    Voice.stopMic();
    try { peer.destroy(); } catch (e) {}
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
    App.onLayout(sizeHostView);
  }

  function keyFor(slot) {
    if (!priv || slot == null) return 'full';
    return SPLITS[split][slot] ? `${split}:${slot}` : 'full';
  }
  function rectOf(key) {
    if (key === 'full') return [0, 0, 1, 1];
    const [sp, i] = key.split(':');
    return SPLITS[sp][+i];
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

  function sizeHostView() {
    const hv = $('#hostView');
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.round(hv.clientWidth * dpr), h = Math.round(hv.clientHeight * dpr);
    if (w && h && (hv.width !== w || hv.height !== h)) { hv.width = w; hv.height = h; }
  }

  function drawHost(src, cr) {
    const hv = $('#hostView');
    if (hv.hidden) return;
    if (!hostCtx) hostCtx = hv.getContext('2d');
    const [x, y, w, h] = rectOf(keyFor(0));
    const sx = cr[0] + x * cr[2], sy = cr[1] + y * cr[3], sw = w * cr[2], sh = h * cr[3];
    const W = hv.width, H = hv.height, ar = sw / sh;
    let dw = W, dh = W / ar;
    if (dh > H) { dh = H; dw = H * ar; }
    hostCtx.fillStyle = '#000';
    hostCtx.fillRect(0, 0, W, H);
    hostCtx.drawImage(src, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  function frame() {
    const src = emuCanvas();
    if (src && src.width && src.height) {
      const cr = contentRect(src);
      for (const v of views.values()) drawView(v, src, cr);
      drawHost(src, cr);
    }
    drawRaf = requestAnimationFrame(frame);
  }

  // ---------- Emulator ----------
  function loadEmulator(file) {
    window.EJS_player = '#game';
    window.EJS_core = 'n64';
    window.EJS_pathtodata = C.ejsData;
    window.EJS_gameUrl = URL.createObjectURL(file);
    window.EJS_gameName = gameName;
    window.EJS_color = '#d8352b';
    window.EJS_onGameStart = onGameStart;
    const s = document.createElement('script');
    s.src = C.ejsData + 'loader.js';
    s.onerror = () => App.toast('Could not load the emulator. Check your connection and reload.');
    document.body.appendChild(s);
  }

  function gm() { return window.EJS_emulator && window.EJS_emulator.gameManager; }
  function sim(player, id, value) { const g = gm(); if (g && g.simulateInput) g.simulateInput(player, id, value); }
  function gameCall(fn, done) {
    const g = gm();
    if (!started || !g || typeof g[fn] !== 'function') { App.toast('Start the game first.'); return; }
    try { g[fn](1); App.toast(done); App.closeMenu(); } catch (e) { App.toast('That didn’t work in this build.'); }
  }
  function emuCanvas() {
    return (window.EJS_emulator && window.EJS_emulator.canvas) || document.querySelector('#game canvas');
  }

  function onGameStart() {
    started = true;
    $('#play').classList.remove('prestart');
    $('#hostView').hidden = false;
    App.layout();
    if (!drawRaf) drawRaf = requestAnimationFrame(frame);
    updateViews();
    attachAudio(0);
    for (const c of clients.values()) callClient(c);
    broadcast();
  }

  // Game audio starts a moment after the game. It feeds each guest's mix (game + voices).
  // Without Web Audio, fall back to sending the raw game audio and re-calling guests.
  function attachAudio(tries) {
    const a = App.audioTrack();
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
    const call = peer.call(c.id, new MediaStream(tracks));
    c.call = call;
    c.stats = null; c.statPrev = null;
    if (call) setTimeout(() => {
      if (call.peerConnection) NetStats.applyRate(call.peerConnection, c.rate || C.videoBitrate, C.streamFps);
    }, 1500);
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
  function onJoin(conn) {
    const meta = conn.metadata || {};
    const token = typeof meta.token === 'string' ? meta.token.slice(0, 64) : null;
    const c = {
      id: conn.peer, conn, token, name: String(meta.name || 'Guest').slice(0, 16),
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
    conn.on('data', (d) => onData(c, d));
    conn.on('close', () => drop(c, 'lost'));
    conn.on('error', () => drop(c, 'lost'));
    callClient(c);
    App.toast(back != null ? `${c.name} is back on port ${c.slot + 1}.` : `${c.name} joined${c.slot != null ? ` on port ${c.slot + 1}` : ' to watch'}.`);
    broadcast();
  }

  function onData(c, d) {
    if (!d || typeof d !== 'object') return;
    c.lastSeen = Date.now();
    if (d.t === 'in') applyInput(c, d);
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
    try { c.conn.close(); } catch (e) {}
    Voice.removeVoice(c.id);
    Voice.dropOut(c.id);
    updateViews();
    if (reason === 'lost' && slot != null) App.toast(`${c.name} lost connection. Holding port ${slot + 1} for them.`);
    else if (reason !== 'replaced') App.toast(`${c.name} left.`);
    broadcast();
  }

  function send(c, m) { try { if (c.conn.open) c.conn.send(m); } catch (e) {} }

  function rosterFor(c) {
    return {
      t: 'roster', code,
      ports: ports.map((p, i) => (i === 0 ? hostName : p ? p.name : null)),
      rate: c.rate,
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
    $('#badge').innerHTML = `<span class="dot p1"></span><span>Room ${esc(code)}</span><span class="dim">${players}P${watching ? ` +${watching} watching` : ''}${priv ? ', private' : ''}</span>`;
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
