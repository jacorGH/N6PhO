// Guest / spectator: shows the picture the host sends, sends inputs when seated in a port,
// talks over voice chat, and reconnects on its own (keeping its port) if the connection drops.
const Guest = (() => {
  const C = window.N6;
  const { $ } = App;
  let peer = null, conn = null, call = null, voiceCall = null;
  let code = '', name = '', role = 'player', token = '';
  let slot = null, joined = false, wasPrivate = null, lastRoster = null;
  let reconnecting = false, retries = 0, lostAt = 0, retryTimer = 0, lastHeard = 0, watchdog = 0, statsTimer = 0;
  let intentional = false, statPrev = null, stats = null, needVoice = false;

  // A per-room token lets the host recognise you after a drop or a reload.
  function tokenFor(room) {
    const k = 'tok-' + room;
    let t = App.prefs.get(k);
    if (!t) {
      t = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
      App.prefs.set(k, t);
    }
    return t;
  }

  function join(c, n, r) {
    code = c; name = n; role = r; token = tokenFor(c);
    intentional = false;
    connect();
  }

  function connect() {
    closeLinks();
    const me = new Peer(App.peerOptions());
    peer = me;
    const timeout = setTimeout(() => {
      if (peer !== me || (conn && conn.open)) return;
      if (!joined) { App.msg('lobbyMsg', 'The room didn’t answer. Check the code and that the host’s screen is still open.'); closeLinks(); }
      else retryLater();
    }, 15000);

    me.on('open', () => {
      if (peer !== me) return;
      const link = me.connect(C.peerPrefix + code, { metadata: { name, role, token } });
      conn = link;
      link.on('open', () => { clearTimeout(timeout); if (conn === link) onConnected(); });
      link.on('data', (d) => { if (conn === link) onData(d); });
      link.on('close', () => { if (conn === link) lost(); });
    });
    me.on('call', (c) => {
      if (peer !== me) return;
      try { if (call) call.close(); } catch (e) {}
      call = c;
      statPrev = null;
      c.answer();
      c.on('stream', attach);
    });
    me.on('disconnected', () => { if (peer === me && !me.destroyed) try { me.reconnect(); } catch (e) {} });
    me.on('error', (err) => {
      if (peer !== me) return;
      if (!joined) {
        clearTimeout(timeout);
        App.msg('lobbyMsg', err.type === 'peer-unavailable' ? `No room found with code ${code}.` : `Connection problem: ${err.type || err.message}.`);
        closeLinks();
      } else if (err.type === 'peer-unavailable' || err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'webrtc') {
        clearTimeout(timeout);
        retryLater();
      }
    });
  }

  function onConnected() {
    lastHeard = Date.now();
    if (!joined) { joined = true; enter(); }
    else {
      reconnecting = false; retries = 0;
      $('#reconnecting').hidden = true;
      App.toast('Reconnected.');
    }
    needVoice = Voice.micOn(); // re-open voice once the host has registered us (first roster)
    clearInterval(watchdog);
    watchdog = setInterval(() => { if (joined && !reconnecting && Date.now() - lastHeard > 7000) lost(); }, 2000);
  }

  // ---------- Dropped connections ----------
  function lost() {
    if (!joined || intentional || reconnecting) return;
    reconnecting = true;
    lostAt = Date.now(); retries = 0;
    $('#reconnecting').hidden = false;
    Skin.unmount(); slot = null;
    retryLater();
  }

  function retryLater() {
    if (intentional) return;
    if (!reconnecting) { lost(); return; }
    if (Date.now() - lostAt > C.reconnectWindow) { ended('Lost the connection to the room.'); return; }
    clearTimeout(retryTimer);
    const delay = Math.min(1000 * 2 ** retries, 8000);
    retries++;
    retryTimer = setTimeout(connect, delay);
  }

  // ---------- Play screen ----------
  function enter() {
    App.enterPlay('guest', { onLeave: leave });
    $('#sheetCode').textContent = code;
    const v = $('#remote');
    v.addEventListener('resize', updateAspect);
    v.addEventListener('loadedmetadata', updateAspect);
    $('#soundBtn').onclick = () => {
      v.muted = false; Voice.play(v);
      $('#soundBtn').hidden = true;
    };
    $('#giveUpBtn').onclick = () => { leave(); location.href = location.pathname; };
    MicUI.wire({ start: startVoice, stop: stopVoice });
    App.onLayout(fitVideo);
    clearInterval(statsTimer);
    statsTimer = setInterval(sampleStats, 2000);
    updateAspect();
  }

  function attach(s) {
    const v = $('#remote');
    v.srcObject = s;
    Voice.play(v);
    $('#waiting').hidden = true;
    if (v.muted && !$('#soundBtn').hidden) App.toast('Open the menu and tap “Turn sound on” for game sound and voices.');
    updateAspect();
  }

  function onData(d) {
    if (!d || typeof d !== 'object') return;
    lastHeard = Date.now();
    if (d.t === 'ping') { send({ t: 'pong', ts: d.ts }); if (d.roster) roster(d.roster); }
    else if (d.t === 'roster') roster(d);
    else if (d.t === 'note') App.toast(d.text);
    else if (d.t === 'kick') { intentional = true; ended('The host removed you from the room.'); }
    else if (d.t === 'closed') { intentional = true; ended('The host closed the room.'); }
  }

  function roster(r) {
    lastRoster = r;
    badge();
    if (needVoice) { needVoice = false; startVoiceCall(); }
    if (!r.started) $('#waiting').hidden = false;

    const port = r.you != null ? r.you + 1 : null;
    $('#screenNote').textContent = r.privateView
      ? 'Private screens are on: you see only your own view.'
      : port && r.priv
        ? 'Private screens are on, but your port isn’t part of this split, so you see the whole game.'
        : 'You see the whole game. The host can turn on private screens so each player sees only their view.';
    if (wasPrivate !== null && wasPrivate !== r.privateView) {
      App.toast(r.privateView ? 'Private screens on: you see only your view.' : 'Private screens off.');
    }
    wasPrivate = r.privateView;

    const nowSlot = r.you != null ? r.you : null;
    if (nowSlot === slot) return;
    slot = nowSlot;
    if (slot != null) {
      Skin.mount($('#skin'), { onState: send, onMenu: App.openMenu, gamepad: true });
      App.toast(`You’re on port ${slot + 1}.`);
    } else {
      Skin.unmount();
    }
  }

  function badge() {
    const r = lastRoster || {};
    const port = r.you != null ? r.you + 1 : null;
    const g = NetStats.grade(r.rtt, stats && stats.loss);
    $('#badge').innerHTML = (port ? `<span class="dot p${port}"></span><span>Port ${port}</span>` : '<span>Watching</span>')
      + `<span class="sig" data-q="${g}"><i></i><i></i><i></i></span><span class="dim">${r.rtt != null ? r.rtt + ' ms' : '– ms'}</span>`;
  }

  // ---------- Connection stats ----------
  async function sampleStats() {
    const pc = call && call.peerConnection;
    if (!pc || reconnecting) return;
    try {
      const st = await NetStats.inbound(pc, statPrev);
      statPrev = st;
      if (st.kbps == null) return;
      stats = st;
      badge();
      const r = lastRoster || {};
      const rows = [
        ['Signal', { good: 'Good', ok: 'OK', poor: 'Poor', unknown: '–' }[NetStats.grade(r.rtt, st.loss)]],
        ['Ping', r.rtt != null ? `${r.rtt} ms` : '–'],
        ['Picture', `${NetStats.qualityLabel(st.kbps)}, ${NetStats.fmtKbps(st.kbps)}`],
        ['Frames', st.fps != null ? `${st.fps} fps${st.width ? `, ${st.width}×${st.height}` : ''}` : '–'],
        ['Packet loss', NetStats.fmtLoss(st.loss)],
        ['Route', st.relay ? 'Through a relay server' : 'Direct']
      ];
      $('#netInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    } catch (e) { /* best effort */ }
  }

  // ---------- Voice ----------
  async function startVoice() {
    await Voice.startMic();
    startVoiceCall();
  }
  function startVoiceCall() {
    if (!peer || !Voice.micStream()) return;
    try { if (voiceCall) voiceCall.close(); } catch (e) {}
    voiceCall = peer.call(C.peerPrefix + code, Voice.micStream(), { metadata: { kind: 'voice' } });
  }
  function stopVoice() {
    try { if (voiceCall) voiceCall.close(); } catch (e) {}
    voiceCall = null;
    Voice.stopMic();
  }

  // ---------- Layout ----------
  function updateAspect() {
    const v = $('#remote');
    App.setAspect((v.videoWidth || 4) / (v.videoHeight || 3));
    App.layout();
  }
  function fitVideo() {
    if (document.body.dataset.role !== 'guest') return;
    const v = $('#remote'), area = $('#screenArea'), box = $('#crop');
    const ar = (v.videoWidth || 4) / (v.videoHeight || 3);
    const W = area.clientWidth, H = area.clientHeight;
    let w = W, h = W / ar;
    if (h > H) { h = H; w = H * ar; }
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
  }

  function send(m) { try { if (conn && conn.open) conn.send(m); } catch (e) {} }

  function leave() {
    intentional = true;
    send({ t: 'bye' });
    stopVoice();
    setTimeout(closeLinks, 150);
  }

  function ended(text) {
    if (!joined) return;
    joined = false; reconnecting = false;
    clearTimeout(retryTimer); clearInterval(watchdog); clearInterval(statsTimer);
    $('#reconnecting').hidden = true;
    Skin.unmount();
    slot = null;
    stopVoice();
    $('#optMic').checked = false; $('#micBtn').hidden = true;
    closeLinks();
    App.show('lobby');
    App.msg('lobbyMsg', text);
  }

  function closeLinks() {
    try { if (voiceCall) voiceCall.close(); } catch (e) {}
    try { if (call) call.close(); } catch (e) {}
    try { if (conn) conn.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    voiceCall = call = conn = peer = null;
  }

  return { join };
})();
