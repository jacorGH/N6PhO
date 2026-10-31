// Shared helpers, browser patches, layout, menu and lobby wiring.
const App = (() => {
  const C = window.N6;

  // 1) Keep WebGL frames readable so the host can capture the game canvas (Safari needs this).
  if (C.preserveDrawingBuffer) {
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (typeof type === 'string' && type.includes('webgl')) {
        attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
      }
      return origGetContext.call(this, type, attrs);
    };
  }

  // 2) Tap the emulator's audio: anything connected to the speakers also feeds a stream node.
  const audio = { dest: null, ctxs: new Set() };
  if (window.AudioNode) {
    const origConnect = AudioNode.prototype.connect;
    const dests = new WeakMap();
    AudioNode.prototype.connect = function (target, ...rest) {
      const result = origConnect.call(this, target, ...rest);
      try {
        if (window.AudioDestinationNode && target instanceof AudioDestinationNode && !target.context.__n6mixer) {
          const ctx = target.context;
          audio.ctxs.add(ctx);
          let d = dests.get(ctx);
          if (!d && ctx.createMediaStreamDestination) {
            d = ctx.createMediaStreamDestination();
            dests.set(ctx, d);
            audio.dest = d;
          }
          if (d) origConnect.call(this, d);
        }
      } catch (e) { /* best effort */ }
      return result;
    };
  }

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v));
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  // ---------- Preferences ----------
  const prefs = {
    get(k) {
      try { const v = localStorage.getItem('n6-' + k); if (v !== null) return JSON.parse(v); } catch (e) {}
      return C.defaults[k];
    },
    set(k, v) { try { localStorage.setItem('n6-' + k, JSON.stringify(v)); } catch (e) {} }
  };

  function show(id) { document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== id; }); }
  function msg(id, text) { const el = document.getElementById(id); if (el) el.textContent = text || ''; }
  function makeCode() {
    let s = '';
    for (const n of crypto.getRandomValues(new Uint32Array(4))) s += CODE_CHARS[n % CODE_CHARS.length];
    return s;
  }
  function peerOptions(iceServers) {
    const o = { debug: 1 };
    const ice = iceServers || C.iceServers;
    if (ice) o.config = { iceServers: ice };
    return o;
  }
  // The emulator times itself off its audio. If iOS suspends that audio (a call, Siri, the mic
  // switching the audio session), the game freezes, so keep nudging it back to running.
  // The emulator lives in its own frame; the host registers a bridge to reach its audio.
  let emuBridge = null;
  function setEmuBridge(fn) { emuBridge = fn; }
  function resumeEmuAudio() {
    const b = emuBridge && emuBridge();
    if (b) return b.resumeAudio();
    let stuck = false;
    for (const ctx of audio.ctxs) {
      if (ctx.state !== 'running' && ctx.state !== 'closed') { stuck = true; ctx.resume().catch(() => {}); }
    }
    return stuck;
  }
  const emuAudioState = () => {
    const b = emuBridge && emuBridge();
    if (b) return b.audioState();
    for (const c of audio.ctxs) return c.state;
    return 'none';
  };
  document.addEventListener('pointerdown', resumeEmuAudio, true);
  setInterval(resumeEmuAudio, 1000);

  function audioTrack() { return audio.dest ? audio.dest.stream.getAudioTracks()[0] || null : null; }

  let toastTimer = 0;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  let wake = null;
  async function keepAwake() {
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wake) keepAwake();
  });

  // ---------- Layout ----------
  // Portrait: game on top, controller deck below. Landscape: game fills, buttons float over it.
  let aspect = 4 / 3;
  const layoutHooks = [];
  function setAspect(ar) { if (ar && isFinite(ar) && Math.abs(ar - aspect) > 0.001) { aspect = ar; layout(); } }
  function onLayout(fn) { layoutHooks.push(fn); }

  // An imported Delta skin can place the game screen anywhere; null = default layout.
  function setScreenRect(r) {
    const el = $('#screenArea');
    if (!r) { ['left', 'top', 'width', 'height', 'right', 'bottom'].forEach((k) => { el.style[k] = ''; }); return; }
    Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, right: 'auto', bottom: 'auto' });
  }

  function layout() {
    const play = $('#play');
    if (play.hidden) return;
    const W = window.innerWidth, H = window.innerHeight;
    const land = W > H;
    document.body.classList.toggle('land', land);
    const skinOn = typeof Skin !== 'undefined' && Skin.active();
    play.classList.toggle('noskin', !skinOn);
    $('#menuFab').hidden = skinOn;
    document.documentElement.style.setProperty('--screen-h', `${Math.round(Math.min(W / aspect, H * 0.55))}px`);
    document.documentElement.style.setProperty('--skin-alpha', prefs.get('alpha'));
    requestAnimationFrame(() => {
      if (typeof Skin !== 'undefined') Skin.relayout();
      layoutHooks.forEach((fn) => fn());
    });
  }
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => setTimeout(layout, 250));

  // ---------- Menu sheet ----------
  let leaveHandler = null;
  function openMenu() { $('#sheet').hidden = false; }
  function closeMenu() { $('#sheet').hidden = true; }

  function enterPlay(role, { onLeave } = {}) {
    document.body.dataset.role = role;
    leaveHandler = onLeave;
    $('#leaveBtn').textContent = role === 'host' ? 'Close room' : 'Leave room';
    show('play');
    layout();
  }

  function wireMenu() {
    $('#menuFab').addEventListener('click', openMenu);
    $('#sheetClose').addEventListener('click', closeMenu);
    $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeMenu(); });

    const skinEl = $('#optSkin'), hapEl = $('#optHaptics'), alphaEl = $('#optAlpha');
    skinEl.checked = prefs.get('skin');
    hapEl.checked = prefs.get('haptics');
    alphaEl.value = prefs.get('alpha');
    skinEl.addEventListener('change', () => { prefs.set('skin', skinEl.checked); Skin.setVisible(skinEl.checked); });
    hapEl.addEventListener('change', () => { prefs.set('haptics', hapEl.checked); if (hapEl.checked) Haptics.tick(); });
    alphaEl.addEventListener('input', () => { prefs.set('alpha', +alphaEl.value); document.documentElement.style.setProperty('--skin-alpha', alphaEl.value); });

    $('#leaveBtn').addEventListener('click', () => {
      if (leaveHandler) leaveHandler();
      location.href = location.pathname;
    });

    window.addEventListener('gamepadconnected', () => {
      if (!Skin.isMounted() || !Skin.active()) return;
      Skin.setVisible(false);
      skinEl.checked = false;
      toast('Controller connected. Touch controls hidden (turn them back on in the menu).');
    });
  }

  function playerName() { return $('#name').value.trim().slice(0, 16) || 'Player'; }

  // ---------- Lobby ----------
  function init() {
    const nameEl = $('#name'), codeEl = $('#code'), romEl = $('#rom');
    nameEl.value = prefs.get('name') || '';
    nameEl.addEventListener('change', () => prefs.set('name', nameEl.value.trim()));

    const room = new URLSearchParams(location.search).get('room');
    if (room) codeEl.value = room.toUpperCase().slice(0, 4);
    codeEl.addEventListener('input', () => {
      codeEl.value = codeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    });

    const perfEl = $('#perfSel');
    perfEl.value = prefs.get('perf');
    perfEl.addEventListener('change', () => prefs.set('perf', perfEl.value));

    romEl.addEventListener('change', () => {
      const f = romEl.files[0];
      msg('romName', f ? f.name : 'No ROM chosen');
      $('#hostBtn').disabled = !f;
    });

    $('#hostBtn').addEventListener('click', () => {
      const f = romEl.files[0];
      if (!f) return;
      $('#hostBtn').disabled = true;
      msg('lobbyMsg', 'Opening room…');
      keepAwake();
      Host.open(f, playerName());
    });

    const join = (role) => {
      const code = codeEl.value.trim();
      if (code.length !== 4) { msg('lobbyMsg', 'Enter the 4-character room code from the host.'); codeEl.focus(); return; }
      msg('lobbyMsg', 'Connecting…');
      keepAwake();
      Guest.join(code, playerName(), role);
    };
    // Direct invites: opened as a link (#invite=…) or pasted.
    const showInvite = (text) => {
      let inv;
      try {
        inv = Codes.unpack(text);
        if (inv.kind !== 'invite') throw new Error('That’s a reply code. It goes into the host’s phone, under Invite directly.');
      } catch (e) { msg('lobbyMsg', e.message); return; }
      $('#dFrom').textContent = inv.name || 'a friend';
      $('#directPanel').hidden = false;
      $('#dChoose').hidden = false;
      $('#dReplyBox').hidden = true;
      msg('dGuestStatus', '');
      const go = (role) => { keepAwake(); $('#dChoose').hidden = true; Guest.joinDirect(inv, playerName(), role); };
      $('#dJoinBtn').onclick = () => go('player');
      $('#dWatchBtn').onclick = () => go('spectator');
      $('#directPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    const hm = location.hash.match(/invite=(N6I\.[A-Za-z0-9_-]+)/);
    if (hm) { showInvite(hm[1]); history.replaceState(null, '', location.pathname + location.search); }
    $('#pasteInviteBtn').addEventListener('click', async () => {
      let t = '';
      try { t = await navigator.clipboard.readText(); } catch (e) { t = window.prompt('Paste the invite code') || ''; }
      if (t) showInvite(t);
    });
    document.querySelectorAll('.app-url').forEach((el) => { el.textContent = location.origin + location.pathname; });

    $('#joinBtn').addEventListener('click', () => join('player'));
    $('#watchBtn').addEventListener('click', () => join('spectator'));

    wireMenu();
  }
  window.addEventListener('DOMContentLoaded', init);

  return { $, esc, clamp, prefs, show, msg, toast, makeCode, peerOptions, audioTrack, keepAwake, resumeEmuAudio, emuAudioState, setEmuBridge,
    layout, setAspect, onLayout, setScreenRect, enterPlay, openMenu, closeMenu };
})();
