// Shared helpers, browser patches and lobby wiring.
const App = (() => {
  const C = window.N64NP;

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

  // 2) Tap the emulator's audio: anything connected to the speakers is also sent to a stream node.
  const audio = { dest: null };
  if (window.AudioNode) {
    const origConnect = AudioNode.prototype.connect;
    const dests = new WeakMap();
    AudioNode.prototype.connect = function (target, ...rest) {
      const result = origConnect.call(this, target, ...rest);
      try {
        if (window.AudioDestinationNode && target instanceof AudioDestinationNode) {
          const ctx = target.context;
          let d = dests.get(ctx);
          if (!d && ctx.createMediaStreamDestination) {
            d = ctx.createMediaStreamDestination();
            dests.set(ctx, d);
            audio.dest = d;
          }
          if (d) origConnect.call(this, d);
        }
      } catch (e) { /* audio tap is best-effort */ }
      return result;
    };
  }

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v));
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== id; });
  }
  function msg(id, text) { const el = document.getElementById(id); if (el) el.textContent = text || ''; }
  function makeCode() {
    let s = '';
    const r = crypto.getRandomValues(new Uint32Array(4));
    for (const n of r) s += CODE_CHARS[n % CODE_CHARS.length];
    return s;
  }
  function peerOptions() {
    const o = { debug: 1 };
    if (C.iceServers) o.config = { iceServers: C.iceServers };
    return o;
  }
  function audioTrack() { return audio.dest ? audio.dest.stream.getAudioTracks()[0] || null : null; }

  let wake = null;
  async function keepAwake() {
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { /* not critical */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wake) keepAwake();
  });

  function playerName() {
    const v = $('#name').value.trim().slice(0, 16);
    return v || 'Player';
  }

  function init() {
    const nameEl = $('#name'), codeEl = $('#code'), romEl = $('#rom');
    try { nameEl.value = localStorage.getItem('fp-name') || ''; } catch (e) {}
    nameEl.addEventListener('change', () => { try { localStorage.setItem('fp-name', nameEl.value.trim()); } catch (e) {} });

    const room = new URLSearchParams(location.search).get('room');
    if (room) codeEl.value = room.toUpperCase().slice(0, 4);

    codeEl.addEventListener('input', () => {
      codeEl.value = codeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    });

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
    $('#joinBtn').addEventListener('click', () => join('player'));
    $('#watchBtn').addEventListener('click', () => join('spectator'));
  }
  window.addEventListener('DOMContentLoaded', init);

  return { $, esc, clamp, show, msg, makeCode, peerOptions, audioTrack, keepAwake };
})();
