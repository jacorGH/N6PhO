// Guest-side input: touch pad + Bluetooth controller -> compact state sent to the host.
const Input = (() => {
  const C = window.N64NP;
  const touch = { held: new Set(), x: 0, y: 0 };
  let send = null, raf = 0, beat = 0, lastKey = '', lastState = null, bound = false;

  const round2 = (v) => Math.round(v * 100) / 100;

  function bindTouch(root) {
    if (bound) return;
    bound = true;
    root.querySelectorAll('[data-btn]').forEach((el) => {
      const name = el.dataset.btn;
      const down = (e) => {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
        touch.held.add(name); el.classList.add('on');
      };
      const up = () => { touch.held.delete(name); el.classList.remove('on'); };
      el.addEventListener('pointerdown', down);
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => el.addEventListener(t, up));
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    const stick = root.querySelector('#stick');
    const knob = stick.querySelector('.knob');
    let sid = null;
    const move = (e) => {
      const r = stick.getBoundingClientRect();
      const rad = r.width / 2;
      let dx = (e.clientX - (r.left + rad)) / rad;
      let dy = (e.clientY - (r.top + rad)) / rad;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      touch.x = dx; touch.y = dy;
      knob.style.transform = `translate(${dx * rad * 0.6}px, ${dy * rad * 0.6}px)`;
    };
    stick.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sid = e.pointerId;
      try { stick.setPointerCapture(e.pointerId); } catch (err) {}
      move(e);
    });
    stick.addEventListener('pointermove', (e) => { if (e.pointerId === sid) move(e); });
    const end = (e) => {
      if (e.pointerId !== sid) return;
      sid = null; touch.x = 0; touch.y = 0; knob.style.transform = '';
    };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => stick.addEventListener(t, end));
  }

  function read() {
    const held = new Set(touch.held);
    let x = touch.x, y = touch.y;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      for (const [name, idxs] of Object.entries(C.gamepadButtons)) {
        if (idxs.some((i) => p.buttons[i] && p.buttons[i].pressed)) held.add(name);
      }
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      if (Math.hypot(ax, ay) > C.deadzone) { x += ax; y += ay; }
      const cx = p.axes[2] || 0, cy = p.axes[3] || 0;
      if (cx > 0.5) held.add('CRIGHT');
      if (cx < -0.5) held.add('CLEFT');
      if (cy > 0.5) held.add('CDOWN');
      if (cy < -0.5) held.add('CUP');
      break; // first connected controller only
    }
    let b = 0;
    C.digitalOrder.forEach((n, i) => { if (held.has(n)) b |= (1 << i); });
    return { t: 'in', b, x: round2(App.clamp(x)), y: round2(App.clamp(y)) };
  }

  function loop() {
    const s = read();
    const key = `${s.b},${s.x},${s.y}`;
    if (key !== lastKey) { lastKey = key; lastState = s; if (send) send(s); }
    raf = requestAnimationFrame(loop);
  }

  function start(root, sendFn) {
    send = sendFn;
    bindTouch(root);
    if (!raf) raf = requestAnimationFrame(loop);
    if (!beat) beat = setInterval(() => { if (send && lastState) send(lastState); }, C.inputHeartbeat);
  }

  function stop() {
    cancelAnimationFrame(raf); raf = 0;
    clearInterval(beat); beat = 0;
    if (send) send({ t: 'in', b: 0, x: 0, y: 0 });
    send = null; lastKey = ''; lastState = null;
  }

  return { start, stop };
})();
