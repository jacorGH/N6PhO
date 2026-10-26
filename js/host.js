// Host: runs EmulatorJS, streams video + audio to every guest, applies remote players' inputs.
const Host = (() => {
  const C = window.N64NP;
  const { $, esc, msg } = App;
  let peer = null, code = '', hostName = 'Host', stream = null, started = false, pingTimer = 0, romFile = null;
  const clients = new Map();           // peerId -> client
  const ports = [null, null, null, null]; // index 0 is always the host

  function open(file, name) {
    romFile = file;
    hostName = name;
    code = App.makeCode();
    peer = new Peer(C.peerPrefix + code, App.peerOptions());

    peer.on('open', () => {
      App.show('hostScreen');
      $('#roomCode').textContent = code;
      render();
      loadEmulator(romFile);
      if (!pingTimer) pingTimer = setInterval(pingAll, 2000);
    });
    peer.on('connection', (conn) => conn.on('open', () => onJoin(conn)));
    peer.on('disconnected', () => {
      msg('hostMsg', 'Lost contact with the room server. Reconnecting… (players already connected stay connected)');
      try { peer.reconnect(); } catch (e) {}
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') { peer.destroy(); open(romFile, hostName); return; }
      if (err.type === 'peer-unavailable') return; // a guest left mid-handshake
      const text = `Connection problem: ${err.type || err.message}.`;
      msg('hostMsg', text); msg('lobbyMsg', text);
      $('#hostBtn').disabled = false;
    });

    $('#inviteBtn').onclick = invite;
    $('#portList').onclick = onAction;
    $('#specList').onclick = onAction;
  }

  // ---------- Emulator ----------
  function loadEmulator(file) {
    window.EJS_player = '#game';
    window.EJS_core = 'n64';
    window.EJS_pathtodata = C.ejsData;
    window.EJS_gameUrl = URL.createObjectURL(file);
    window.EJS_gameName = file.name.replace(/\.[^.]+$/, '');
    window.EJS_color = '#d8352b';
    window.EJS_onGameStart = onGameStart;
    const s = document.createElement('script');
    s.src = C.ejsData + 'loader.js';
    s.onerror = () => msg('hostMsg', 'Could not load the emulator. Check your internet connection and reload.');
    document.body.appendChild(s);
  }

  function emuCanvas() {
    return (window.EJS_emulator && window.EJS_emulator.canvas) || document.querySelector('#game canvas');
  }

  function sim(player, id, value) {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (gm && gm.simulateInput) gm.simulateInput(player, id, value);
  }

  function onGameStart() {
    started = true;
    const canvas = emuCanvas();
    if (!canvas || !canvas.captureStream) {
      msg('hostMsg', 'This browser cannot stream the game canvas. Try hosting from a different browser.');
      return;
    }
    stream = canvas.captureStream(C.streamFps);
    const v = stream.getVideoTracks()[0];
    if (v && 'contentHint' in v) v.contentHint = 'motion';
    attachAudio(0);
    for (const c of clients.values()) callClient(c);
    msg('hostMsg', 'Game running. Everyone in the room is getting the stream.');
    broadcast();
  }

  // Audio starts a moment after the game; once it exists, add it and re-call guests so they get sound.
  function attachAudio(tries) {
    const a = App.audioTrack();
    if (a) {
      if (!stream.getAudioTracks().length) {
        stream.addTrack(a);
        if (tries > 0) for (const c of clients.values()) callClient(c);
      }
      return;
    }
    if (tries < 20) setTimeout(() => attachAudio(tries + 1), 1000);
  }

  function callClient(c) {
    if (!stream) return;
    try { if (c.call) c.call.close(); } catch (e) {}
    const call = peer.call(c.id, stream);
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
    const c = {
      id: conn.peer, conn,
      name: String(meta.name || 'Guest').slice(0, 16),
      slot: null, rtt: null, call: null, last: new Map()
    };
    clients.set(c.id, c);
    if (meta.role === 'player') {
      const s = freeSlot();
      if (s > 0) seat(c, s);
      else send(c, { t: 'note', text: 'All four ports are taken, so you joined as a spectator.' });
    }
    conn.on('data', (d) => onData(c, d));
    conn.on('close', () => drop(c));
    conn.on('error', () => drop(c));
    if (started) callClient(c);
    broadcast();
  }

  function onData(c, d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'in') applyInput(c, d);
    else if (d.t === 'pong' && typeof d.ts === 'number') {
      c.rtt = Math.round(performance.now() - d.ts);
    }
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
  function seat(c, s) { release(c); if (c.slot != null) ports[c.slot] = null; ports[s] = c; c.slot = s; }
  function unseat(c) { release(c); if (c.slot != null) ports[c.slot] = null; c.slot = null; }

  function drop(c) {
    if (!clients.has(c.id)) return;
    unseat(c);
    try { if (c.call) c.call.close(); } catch (e) {}
    clients.delete(c.id);
    broadcast();
  }

  function send(c, m) { try { if (c.conn.open) c.conn.send(m); } catch (e) {} }

  function rosterFor(c) {
    return {
      t: 'roster',
      ports: ports.map((p, i) => (i === 0 ? hostName : p ? p.name : null)),
      you: c.slot,
      watching: [...clients.values()].filter((x) => x.slot == null).length,
      rtt: c.rtt,
      started
    };
  }

  function broadcast() {
    for (const c of clients.values()) send(c, rosterFor(c));
    render();
  }

  // Ping doubles as a roster refresh so a dropped message never leaves a guest out of date.
  function pingAll() {
    const ts = performance.now();
    for (const c of clients.values()) send(c, { t: 'ping', ts, roster: rosterFor(c) });
    render();
  }

  // ---------- Host UI ----------
  function render() {
    $('#portList').innerHTML = [0, 1, 2, 3].map((i) => {
      const n = i + 1;
      if (i === 0) {
        return `<li class="port p1"><span class="n">1</span><span class="who">${esc(hostName)}<small>You, hosting</small></span></li>`;
      }
      const p = ports[i];
      if (!p) {
        return `<li class="port p${n} open"><span class="n">${n}</span><span class="who">Open<small>Waiting for a player</small></span></li>`;
      }
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
      : '<li class="dim small">No one is watching yet.</li>';
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
      if (navigator.share) { await navigator.share({ title: 'Four Ports', text: `Join my N64 room: ${code}`, url }); return; }
      await navigator.clipboard.writeText(url);
      msg('hostMsg', 'Invite link copied.');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      msg('hostMsg', `Room code: ${code}. Link: ${url}`);
    }
  }

  return { open };
})();
