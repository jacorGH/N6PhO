// Runs inside emu.html, the frame that holds EmulatorJS. Swapping games reloads only this frame,
// so the page around it (connections, voice, controls, guests' streams) keeps running.
(() => {
  // Keep WebGL frames readable so the host page can copy them for guests.
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (typeof type === 'string' && type.includes('webgl')) attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    return origGetContext.call(this, type, attrs);
  };

  // Tap the game's audio: whatever reaches the speakers also feeds a stream for guests.
  const audio = { dest: null, ctxs: new Set() };
  const origConnect = AudioNode.prototype.connect;
  const dests = new WeakMap();
  AudioNode.prototype.connect = function (target, ...rest) {
    const result = origConnect.call(this, target, ...rest);
    try {
      if (target instanceof AudioDestinationNode) {
        const ctx = target.context;
        audio.ctxs.add(ctx);
        let d = dests.get(ctx);
        if (!d) { d = ctx.createMediaStreamDestination(); dests.set(ctx, d); audio.dest = d; }
        origConnect.call(this, d);
      }
    } catch (e) { /* best effort */ }
    return result;
  };

  const n6 = {
    boot(cfg) {
      window.EJS_player = '#game';
      window.EJS_core = cfg.core;
      window.EJS_pathtodata = cfg.data;
      window.EJS_gameUrl = cfg.gameUrl;
      window.EJS_gameName = cfg.gameName;
      window.EJS_color = cfg.color;
      window.EJS_defaultOptions = cfg.options || {};
      window.EJS_onGameStart = () => { document.body.classList.add('playing'); if (cfg.onGameStart) cfg.onGameStart(); };
      const s = document.createElement('script');
      s.src = cfg.data + 'loader.js';
      s.onerror = () => { if (cfg.onError) cfg.onError(); };
      document.body.appendChild(s);
    },
    emulator: () => window.EJS_emulator || null,
    gameManager: () => (window.EJS_emulator && window.EJS_emulator.gameManager) || null,
    canvas: () => (window.EJS_emulator && window.EJS_emulator.canvas) || document.querySelector('#game canvas'),
    audioTrack: () => (audio.dest ? audio.dest.stream.getAudioTracks()[0] || null : null),
    // iOS can pause web audio (mic switching modes, calls, Siri); the emulator keeps time with it.
    resumeAudio() {
      let stuck = false;
      for (const c of audio.ctxs) {
        if (c.state !== 'running' && c.state !== 'closed') { stuck = true; c.resume().catch(() => {}); }
      }
      return stuck;
    },
    audioState() { for (const c of audio.ctxs) return c.state; return 'none'; },
    // Show EmulatorJS's own buttons and menus (Emulator menu mode) or hide them (play).
    setChrome(show) { document.body.classList.toggle('playing', !show); },
    // Write the game's battery save before the frame goes away.
    flushSaves() {
      try {
        const g = n6.gameManager();
        if (g && typeof g.saveSaveFiles === 'function') g.saveSaveFiles();
      } catch (e) {}
    }
  };
  window.__n6 = n6;
  document.addEventListener('pointerdown', () => n6.resumeAudio(), true);
})();
