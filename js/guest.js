// Guest / spectator: receives the host's stream, sends inputs when seated in a port.
const Guest = (() => {
  const C = window.N64NP;
  const { $, msg } = App;
  let peer = null, conn = null, call = null, slot = null, joined = false, toastTimer = 0;

  const CROPS = {
    full: [0, 0, 1, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 0.5],
    left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1],
    q1: [0, 0, 0.5, 0.5], q2: [0.5, 0, 0.5, 0.5], q3: [0, 0.5, 0.5, 0.5], q4: [0.5, 0.5, 0.5, 0.5]
  };

  function join(code, name, role) {
    peer = new Peer(App.peerOptions());
    const timeout = setTimeout(() => {
      if (!joined) { msg('lobbyMsg', 'The room didn’t answer. Check the code and that the host’s screen is still open.'); cleanup(); }
    }, 15000);

    peer.on('open', () => {
      conn = peer.connect(C.peerPrefix + code, { metadata: { name, role } });
      conn.on('open', () => { joined = true; clearTimeout(timeout); enter(); });
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
        msg('lobbyMsg', `No room found with code ${code}.`);
        cleanup();
      } else if (!joined) {
        msg('lobbyMsg', `Connection problem: ${err.type || err.message}.`);
      } else {
        toast(`Connection problem: ${err.type || err.message}`);
      }
    });
  }

  function enter() {
    App.show('guestScreen');
    const view = $('#view');
    try { view.value = localStorage.getItem('fp-view') || 'full'; } catch (e) {}
    view.onchange = () => { try { localStorage.setItem('fp-view', view.value); } catch (e) {} layout(); };
    window.addEventListener('resize', layout);
    $('#remote').addEventListener('resize', layout);
    $('#remote').addEventListener('loadedmetadata', layout);
    $('#soundBtn').onclick = () => {
      const v = $('#remote'); v.muted = false; v.play().catch(() => {});
      $('#soundBtn').hidden = true;
    };
    $('#padBtn').onclick = () => setPad($('#touchPad').hidden);
    $('#leaveBtn').onclick = () => { cleanup(); location.href = location.pathname; };
    window.addEventListener('gamepadconnected', () => { if (slot != null) { setPad(false); toast('Controller connected'); } });
    layout();
  }

  function attach(s) {
    const v = $('#remote');
    v.srcObject = s;
    v.play().catch(() => {});
    $('#waiting').hidden = true;
    layout();
  }

  function onData(d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'ping') { send({ t: 'pong', ts: d.ts }); if (d.roster) roster(d.roster); }
    else if (d.t === 'roster') roster(d);
    else if (d.t === 'note') toast(d.text);
    else if (d.t === 'kick') ended('The host removed you from the room.');
  }

  function roster(r) {
    const pill = $('#myPort');
    pill.className = 'pill' + (r.you != null ? ` p${r.you + 1}` : '');
    pill.textContent = r.you != null ? `Port ${r.you + 1}` : 'Watching';
    $('#myPing').textContent = r.rtt != null ? `${r.rtt} ms` : '– ms';
    if (!r.started) $('#waiting').hidden = false;

    const nowSlot = r.you != null ? r.you : null;
    if (nowSlot === slot) return;
    slot = nowSlot;
    if (slot != null) {
      Input.start($('#touchPad'), send);
      $('#padBtn').hidden = false;
      const hasPad = [...(navigator.getGamepads ? navigator.getGamepads() : [])].some(Boolean);
      setPad(!hasPad && matchMedia('(pointer: coarse)').matches);
      toast(`You’re on port ${slot + 1}.`);
    } else {
      Input.stop();
      setPad(false);
      $('#padBtn').hidden = true;
    }
  }

  function setPad(on) {
    $('#touchPad').hidden = !on;
    $('#padBtn').textContent = on ? 'Hide touch pad' : 'Show touch pad';
  }

  function layout() {
    const [cx, cy, cw, ch] = CROPS[$('#view').value] || CROPS.full;
    const v = $('#remote'), stage = $('#stage'), crop = $('#crop');
    const vw = v.videoWidth || 4, vh = v.videoHeight || 3;
    const ar = (vw * cw) / (vh * ch);
    const W = stage.clientWidth, H = stage.clientHeight;
    let w = W, h = W / ar;
    if (h > H) { h = H; w = H * ar; }
    crop.style.width = `${w}px`;
    crop.style.height = `${h}px`;
    v.style.width = `${100 / cw}%`;
    v.style.height = `${100 / ch}%`;
    v.style.left = `${(-cx / cw) * 100}%`;
    v.style.top = `${(-cy / ch) * 100}%`;
  }

  function send(m) { try { if (conn && conn.open) conn.send(m); } catch (e) {} }

  function toast(text) {
    const t = $('#toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function ended(text) {
    if (!joined) return;
    joined = false;
    Input.stop();
    slot = null;
    cleanup();
    App.show('lobby');
    msg('lobbyMsg', text);
  }

  function cleanup() {
    try { if (call) call.close(); } catch (e) {}
    try { if (conn) conn.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    call = conn = peer = null;
  }

  return { join };
})();
