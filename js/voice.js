// Voice chat, full mesh: everyone hears everyone.
// - Host ↔ guest: the host's mic is mixed into the game sound it sends each guest; each guest
//   sends its mic to the host on a one-way call.
// - Guest ↔ guest: guests call each other directly, with the host passing the connection
//   messages between them (the broker). No lobby server involved.
const Voice = (() => {
  let ctx = null, gameSrc = null;
  let mic = null, micSrc = null, muted = false;
  const outs = new Map();   // clientId -> MediaStreamAudioDestinationNode
  const voices = new Map(); // clientId -> { src, el }
  const pendingPlays = new Set();

  function init() {
    if (ctx) { resume(); return ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    ctx.__n6mixer = true; // keep the emulator audio tap from grabbing this context
    resume();
    return ctx;
  }
  function resume() { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); }

  // Browsers block sound until a tap; retry anything that was blocked on the next tap.
  function play(el) {
    const p = el.play();
    if (p && p.catch) p.catch(() => { pendingPlays.add(el); });
  }
  document.addEventListener('pointerdown', () => {
    resume();
    for (const el of pendingPlays) { el.play().then(() => pendingPlays.delete(el)).catch(() => {}); }
  }, true);

  // ---------- Host mixing ----------
  function setGame(track) {
    if (!init()) return false;
    if (gameSrc) try { gameSrc.disconnect(); } catch (e) {}
    gameSrc = ctx.createMediaStreamSource(new MediaStream([track]));
    for (const d of outs.values()) gameSrc.connect(d);
    return true;
  }

  function outFor(id) {
    if (!init()) return null;
    let d = outs.get(id);
    if (!d) {
      d = ctx.createMediaStreamDestination();
      outs.set(id, d);
      if (gameSrc) gameSrc.connect(d);
      if (micSrc) micSrc.connect(d);
    }
    return d.stream.getAudioTracks()[0];
  }

  function dropOut(id) {
    const d = outs.get(id);
    if (!d) return;
    const nodes = [gameSrc, micSrc];
    nodes.forEach((n) => { if (n) try { n.disconnect(d); } catch (e) {} });
    outs.delete(id);
  }

  function addVoice(id, stream) {
    if (!init()) return;
    removeVoice(id);
    // Playing through an <audio> element (not Web Audio) keeps echo cancellation working.
    const el = new Audio();
    el.srcObject = stream;
    el.volume = App.prefs.get('voiceVol') ?? 1;
    play(el);
    voices.set(id, { el });
  }

  function removeVoice(id) {
    const v = voices.get(id);
    if (!v) return;
    v.el.pause(); v.el.srcObject = null;
    pendingPlays.delete(v.el);
    voices.delete(id);
  }

  function setVolume(vol) { for (const v of voices.values()) v.el.volume = vol; }
  const talking = (id) => voices.has(id);

  // ---------- Microphone (host and guests) ----------
  async function startMic() {
    if (mic) return mic;
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
    });
    muted = false;
    if (ctx) {
      micSrc = ctx.createMediaStreamSource(mic);
      for (const d of outs.values()) micSrc.connect(d);
    }
    return mic;
  }

  // Host only: route the host mic into every guest's mix.
  async function startHostMic() {
    init();
    await startMic();
    if (!micSrc && ctx) {
      micSrc = ctx.createMediaStreamSource(mic);
      for (const d of outs.values()) micSrc.connect(d);
    }
  }

  function stopMic() {
    if (micSrc) try { micSrc.disconnect(); } catch (e) {}
    if (mic) mic.getTracks().forEach((t) => t.stop());
    mic = null; micSrc = null; muted = false;
  }

  function setMuted(m) {
    muted = m;
    if (mic) mic.getAudioTracks().forEach((t) => { t.enabled = !m; });
  }

  return {
    init, resume, play, setGame, outFor, dropOut, addVoice, removeVoice, setVolume, talking,
    startMic, startHostMic, stopMic, setMuted,
    micOn: () => !!mic, isMuted: () => muted, micStream: () => mic
  };
})();

// Shared mic UI: the menu toggle turns voice on/off, the floating button mutes.
const MicUI = (() => {
  let handlers = null;
  function wire(h) {
    handlers = h;
    const opt = document.getElementById('optMic'), btn = document.getElementById('micBtn');
    opt.checked = false;
    opt.onchange = async () => {
      if (opt.checked) {
        try {
          await handlers.start();
          btn.hidden = false;
          paint();
          App.toast('Mic on. Tap the mic button to mute.');
        } catch (e) {
          opt.checked = false;
          App.toast(e && e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser settings.' : 'Couldn’t start the microphone.');
        }
      } else {
        handlers.stop();
        btn.hidden = true;
      }
      App.layout();
    };
    btn.onclick = () => { Voice.setMuted(!Voice.isMuted()); paint(); Haptics.tick(); };
  }
  function paint() {
    const btn = document.getElementById('micBtn');
    btn.classList.toggle('muted', Voice.isMuted());
    btn.setAttribute('aria-label', Voice.isMuted() ? 'Unmute microphone' : 'Mute microphone');
  }
  return { wire, paint };
})();
