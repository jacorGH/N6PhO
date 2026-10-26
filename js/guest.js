// Guest / spectator: shows the picture the host sends (whole game, or only your own view when
// private screens are on) and sends inputs when seated in a port.
const Guest = (() => {
  const C = window.N6;
  const { $ } = App;
  let peer = null, conn = null, call = null, slot = null, joined = false, wasPrivate = null;

  function join(code, name, role) {
    peer = new Peer(App.peerOptions());
    const timeout = setTimeout(() => {
      if (!joined) { App.msg('lobbyMsg', 'The room didn’t answer. Check the code and that the host’s screen is still open.'); cleanup(); }
    }, 15000);

    peer.on('open', () => {
      conn = peer.connect(C.peerPrefix + code, { metadata: { name, role } });
      conn.on('open', () => { joined = true; clearTimeout(timeout); enter(code); });
      conn.on('data', onData);
      conn.on('close', () => ended('The host closed the room.'));
    });
    peer.on('call', (c) => {
      try { if (call) call.close(); } catch (e) {}
      call = c;
      c.answer();
      c.on('stream', attach);
    });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        clearTimeout(timeout);
        App.msg('lobbyMsg', `No room found with code ${code}.`);
        cleanup();
      } else if (!joined) {
        App.msg('lobbyMsg', `Connection problem: ${err.type || err.message}.`);
      } else {
        App.toast(`Connection problem: ${err.type || err.message}`);
      }
    });
  }

  function enter(code) {
    App.enterPlay('guest', { onLeave: cleanup });
    $('#sheetCode').textContent = code;
    const v = $('#remote');
    v.addEventListener('resize', updateAspect);
    v.addEventListener('loadedmetadata', updateAspect);
    $('#soundBtn').onclick = () => {
      v.muted = false; v.play().catch(() => {});
      $('#soundBtn').hidden = true;
    };
    App.onLayout(fitVideo);
    updateAspect();
  }

  function attach(s) {
    const v = $('#remote');
    v.srcObject = s;
    v.play().catch(() => {});
    $('#waiting').hidden = true;
    if (v.muted && !$('#soundBtn').hidden) App.toast('Open the menu and tap “Turn sound on” for audio.');
    updateAspect();
  }

  function onData(d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'ping') { send({ t: 'pong', ts: d.ts }); if (d.roster) roster(d.roster); }
    else if (d.t === 'roster') roster(d);
    else if (d.t === 'note') App.toast(d.text);
    else if (d.t === 'kick') ended('The host removed you from the room.');
  }

  function roster(r) {
    const port = r.you != null ? r.you + 1 : null;
    $('#badge').innerHTML = (port ? `<span class="dot p${port}"></span><span>Port ${port}</span>` : '<span>Watching</span>')
      + `<span class="dim">${r.rtt != null ? r.rtt + ' ms' : '– ms'}</span>`;
    if (!r.started) $('#waiting').hidden = false;

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

  // The host already cropped the picture, so just fit the video to the screen area.
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

  function ended(text) {
    if (!joined) return;
    joined = false;
    Skin.unmount();
    slot = null;
    cleanup();
    App.show('lobby');
    App.msg('lobbyMsg', text);
  }

  function cleanup() {
    try { if (call) call.close(); } catch (e) {}
    try { if (conn) conn.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    call = conn = peer = null;
  }

  return { join };
})();
