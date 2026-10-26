// Host: runs EmulatorJS, sends each guest their own picture (full game, or only their part of the
// split screen when private screens are on), and applies every player's input.
const Host = (() => {
  const C = window.N6;
  const { $, esc } = App;
  let peer = null, code = '', hostName = 'Host', started = false, pingTimer = 0, romFile = null, gameName = '';
  let audioTrack = null, drawRaf = 0, hostCtx = null;
  let priv = false, split = 'quad';
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
    $('#qsBtn').onclick = () => gameCall('quickSave', 'Saved.');
    $('#qlBtn').onclick = () => gameCall('quickLoad', 'Loaded.');
  }

  function close() {
    for (const c of clients.values()) send(c, { t: 'note', text: 'The host closed the room.' });
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

  // Audio starts a moment after the game; once it exists, re-call guests so they get sound.
  function attachAudio(tries) {
    const a = App.audioTrack();
    if (a) {
      if (!audioTrack) {
        audioTrack = a;
        if (tries > 0) for (const c of clients.values()) callClient(c);
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
    if (audioTrack) tracks.push(audioTrack);
    const call = peer.call(c.id, new MediaStream(tracks));
    c.call = call;
    if (call) setTimeout(() => tuneBitrate(call), 1500);
  }

  async function tuneBitrate(call) {
    const pc = call.peerConnection;
    if (!pc) return;
    for (const s of pc.getSenders()) {
      if (!s.track || s.track.kind !== 'video') continue;
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = C.videoBitrate;
      p.encodings[0].maxFramerate = C.streamFps;
      try { await s.setParameters(p); } catch (e) {}
    }
  }

  // ---------- Guests ----------
  function onJoin(conn) {
    const meta = conn.metadata || {};
    const c = { id: conn.peer, conn, name: String(meta.name || 'Guest').slice(0, 16), slot: null, rtt: null, call: null, viewKey: null, last: new Map() };
    clients.set(c.id, c);
    if (meta.role === 'player') {
      const s = freeSlot();
      if (s > 0) seat(c, s);
      else send(c, { t: 'note', text: 'All four ports are taken, so you joined as a spectator.' });
    }
    conn.on('data', (d) => onData(c, d));
    conn.on('close', () => drop(c));
    conn.on('error', () => drop(c));
    callClient(c);
    App.toast(`${c.name} joined${c.slot != null ? ` on port ${c.slot + 1}` : ' to watch'}.`);
    broadcast();
  }

  function onData(c, d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'in') applyInput(c, d);
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
  function seat(c, s) { release(c); if (c.slot != null) ports[c.slot] = null; ports[s] = c; c.slot = s; updateViews(); }
  function unseat(c) { release(c); if (c.slot != null) ports[c.slot] = null; c.slot = null; updateViews(); }

  function drop(c) {
    if (!clients.has(c.id)) return;
    unseat(c);
    try { if (c.call) c.call.close(); } catch (e) {}
    clients.delete(c.id);
    updateViews();
    App.toast(`${c.name} left.`);
    broadcast();
  }

  function send(c, m) { try { if (c.conn.open) c.conn.send(m); } catch (e) {} }

  function rosterFor(c) {
    return {
      t: 'roster', code,
      ports: ports.map((p, i) => (i === 0 ? hostName : p ? p.name : null)),
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
    const ts = performance.now();
    for (const c of clients.values()) send(c, { t: 'ping', ts, roster: rosterFor(c) });
    render();
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
      return `<li class="port p${n}"><span class="n">${n}</span>
        <span class="who">${esc(p.name)}<small>${p.rtt != null ? p.rtt + ' ms' : 'Connecting…'}</small></span>
        <span class="acts">
          <button class="btn small ghost" data-act="unseat" data-id="${esc(p.id)}">Move to watching</button>
          <button class="btn small ghost" data-act="kick" data-id="${esc(p.id)}">Remove</button>
        </span></li>`;
    }).join('');

    const specs = [...clients.values()].filter((c) => c.slot == null);
    const open = freeSlot() > 0;
    $('#specList').innerHTML = specs.length
      ? specs.map((c) => `<li><span class="who">${esc(c.name)}<small>${c.rtt != null ? c.rtt + ' ms' : 'Connecting…'}</small></span>
          <span class="acts">
            ${open ? `<button class="btn small" data-act="seat" data-id="${esc(c.id)}">Give a port</button>` : ''}
            <button class="btn small ghost" data-act="kick" data-id="${esc(c.id)}">Remove</button>
          </span></li>`).join('')
      : '<li class="dim small empty">No one is watching yet.</li>';
  }

  function onAction(e) {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const c = clients.get(b.dataset.id);
    if (!c) return;
    if (b.dataset.act === 'unseat') unseat(c);
    if (b.dataset.act === 'seat') { const s = freeSlot(); if (s > 0) seat(c, s); }
    if (b.dataset.act === 'kick') {
      send(c, { t: 'kick' });
      setTimeout(() => { try { c.conn.close(); } catch (err) {} drop(c); }, 300);
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
