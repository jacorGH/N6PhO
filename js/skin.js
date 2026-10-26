// Touch controller engine: renders a skin from data, multitouch with slide-between-buttons,
// extended hit areas, d-pad diagonals, analog stick, haptics, and Bluetooth controller merge.
const Haptics = (() => {
  let sw = null;
  function iosTick() {
    // iOS Safari has no vibrate(); toggling a hidden <input switch> produces a system haptic tick.
    if (!sw) {
      const label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.cssText = 'position:fixed;left:-200px;top:0;opacity:0;pointer-events:none;';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      label.appendChild(input);
      document.body.appendChild(label);
      sw = label;
    }
    sw.click();
  }
  function tick() {
    if (!App.prefs.get('haptics')) return;
    try {
      if (navigator.vibrate) navigator.vibrate(9);
      else iosTick();
    } catch (e) { /* best effort */ }
  }
  return { tick };
})();

const Skin = (() => {
  const C = window.N6;
  const DIRS = [['right'], ['right', 'down'], ['down'], ['down', 'left'], ['left'], ['left', 'up'], ['up'], ['up', 'right']];

  let root = null, def = null, layoutDef = null, items = [], unit = 1;
  let mounted = false, opts = {};
  const pointers = new Map(); // pointerId -> { stick: bool, held: Set }
  const stick = { id: null, x: 0, y: 0, item: null };
  let touchHeld = new Set();
  let raf = 0, beat = 0, lastKey = '', lastState = null;

  // ---------- Build & layout ----------
  function build(lay) {
    layoutDef = lay;
    root.innerHTML = '';
    items = lay.items.map((d) => {
      const el = document.createElement('div');
      el.className = `sk-item sk-${d.type}` + (d.shape ? ` shape-${d.shape}` : '') + (d.color ? ` col-${d.color}` : '');
      if (d.type === 'button') el.innerHTML = `<span>${d.label || ''}</span>`;
      else if (d.type === 'stick') el.innerHTML = '<div class="sk-knob"></div>';
      else if (d.type === 'dpad') el.innerHTML = '<i data-dir="up"></i><i data-dir="down"></i><i data-dir="left"></i><i data-dir="right"></i><b></b>';
      else if (d.type === 'cpad') el.innerHTML = '<i data-dir="up">▲</i><i data-dir="left">◀</i><i data-dir="right">▶</i><i data-dir="down">▼</i>';
      else if (d.type === 'menu') { el.innerHTML = '<span class="bars"></span>'; el.setAttribute('aria-label', 'Menu'); }
      root.appendChild(el);
      return { def: d, el, rect: null };
    });
  }

  function relayout() {
    if (!mounted || root.hidden) return;
    const land = document.body.classList.contains('land');
    const lay = land ? def.landscape : def.portrait;
    if (lay !== layoutDef) { releaseAll(); build(lay); }
    const box = root.getBoundingClientRect();
    const W = box.width, H = box.height;
    unit = land ? Math.min(H / 100, W / 170) : Math.min(W / 100, H / (lay.minH || 84));
    const lift = lay.lift ? Math.max(0, H / unit - (lay.minH || 84)) * lay.lift : 0;

    for (const it of items) {
      const d = it.def, u = unit;
      const w = d.w * u, h = d.h * u;
      const a = d.anchor || 'bl';
      const left = a[1] === 'l' ? d.x * u : a[1] === 'r' ? W - (d.x * u + w) : W / 2 + d.x * u - w / 2;
      const top = a[0] === 't' ? d.y * u : H - ((d.y + lift) * u + h);
      Object.assign(it.el.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px`, fontSize: `${d.shape === 'pill' ? h * 0.55 : Math.min(w, h) * 0.4}px` });
      const L = box.left + left, T = box.top + top;
      it.rect = { left: L, top: T, right: L + w, bottom: T + h, w, h, cx: L + w / 2, cy: T + h / 2 };
    }
  }

  // ---------- Touch ----------
  function hit(x, y, allowStick) {
    let best = null, bestD = Infinity;
    const pad = C.hitPad * unit;
    for (const it of items) {
      const t = it.def.type;
      if (t === 'stick' && !allowStick) continue;
      const r = it.rect;
      if (!r) continue;
      const p = t === 'menu' ? 0 : pad;
      if (x < r.left - p || x > r.right + p || y < r.top - p || y > r.bottom + p) continue;
      const d = Math.hypot((x - r.cx) / r.w, (y - r.cy) / r.h);
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  function inputsAt(it, x, y) {
    const d = it.def, out = new Set();
    if (d.type === 'button') { d.inputs.forEach((i) => out.add(i)); return out; }
    if (d.type === 'dpad' || d.type === 'cpad') {
      const r = it.rect;
      const dx = (x - r.cx) / (r.w / 2), dy = (y - r.cy) / (r.h / 2);
      if (Math.hypot(dx, dy) < 0.22) return out; // dead centre
      const s = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
      DIRS[s].forEach((dir) => out.add(d.inputs[dir]));
    }
    return out;
  }

  function moveStick(e) {
    const r = stick.item.rect;
    const rad = (r.w / 2) * C.stickRange;
    let dx = (e.clientX - r.cx) / rad, dy = (e.clientY - r.cy) / rad;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    stick.x = dx; stick.y = dy;
    const knob = stick.item.el.firstChild;
    knob.style.transform = `translate(${dx * rad}px, ${dy * rad}px)`;
  }

  function isOurs(e) {
    return mounted && (e.target === root || (e.target.closest && e.target.closest('.sk-item')));
  }

  function onDown(e) {
    if (!isOurs(e)) return;
    e.preventDefault();
    const it = hit(e.clientX, e.clientY, true);
    if (!it) return;
    if (it.def.type === 'menu') { Haptics.tick(); if (opts.onMenu) opts.onMenu(); return; }
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    if (it.def.type === 'stick') {
      if (stick.id !== null) return;
      stick.id = e.pointerId; stick.item = it;
      it.el.classList.add('on');
      pointers.set(e.pointerId, { stick: true, held: new Set() });
      moveStick(e);
    } else {
      pointers.set(e.pointerId, { stick: false, held: inputsAt(it, e.clientX, e.clientY) });
    }
    update();
  }

  function onMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (p.stick) { moveStick(e); update(); return; }
    const it = hit(e.clientX, e.clientY, false); // slide onto any button, but never onto the stick
    p.held = it && it.def.type !== 'menu' ? inputsAt(it, e.clientX, e.clientY) : new Set();
    update();
  }

  function onUp(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (p.stick) resetStick();
    pointers.delete(e.pointerId);
    update();
  }

  function resetStick() {
    if (stick.item) {
      stick.item.el.classList.remove('on');
      stick.item.el.firstChild.style.transform = '';
    }
    stick.id = null; stick.x = 0; stick.y = 0;
  }

  function releaseAll() {
    pointers.clear();
    resetStick();
    touchHeld = new Set();
    paint(touchHeld);
  }

  function update() {
    const held = new Set();
    for (const p of pointers.values()) p.held.forEach((h) => held.add(h));
    let fresh = false;
    for (const h of held) if (!touchHeld.has(h)) { fresh = true; break; }
    if (fresh) Haptics.tick();
    touchHeld = held;
    paint(held);
  }

  function paint(held) {
    for (const it of items) {
      const d = it.def;
      if (d.type === 'button') it.el.classList.toggle('on', d.inputs.some((i) => held.has(i)));
      else if (d.type === 'dpad' || d.type === 'cpad') {
        it.el.querySelectorAll('i').forEach((arm) => arm.classList.toggle('on', held.has(d.inputs[arm.dataset.dir])));
      }
    }
  }

  // ---------- Output (touch + controller) ----------
  const round2 = (v) => Math.round(v * 100) / 100;

  function read() {
    const held = new Set(touchHeld);
    let x = stick.x, y = stick.y;
    if (opts.gamepad !== false && navigator.getGamepads) {
      for (const p of navigator.getGamepads()) {
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
        break;
      }
    }
    let b = 0;
    C.digitalOrder.forEach((n, i) => { if (held.has(n)) b |= (1 << i); });
    return { t: 'in', b, x: round2(App.clamp(x)), y: round2(App.clamp(y)) };
  }

  function loop() {
    const s = read();
    const key = `${s.b},${s.x},${s.y}`;
    if (key !== lastKey) { lastKey = key; lastState = s; if (opts.onState) opts.onState(s); }
    raf = requestAnimationFrame(loop);
  }

  let bound = false;
  function bindOnce() {
    if (bound) return;
    bound = true;
    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    ['pointerup', 'pointercancel'].forEach((t) => root.addEventListener(t, onUp));
    root.addEventListener('touchstart', (e) => { if (isOurs(e)) e.preventDefault(); }, { passive: false });
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => { releaseAll(); });
  }

  function mount(el, o) {
    root = el; opts = o || {};
    def = window.N6_SKINS[C.skin];
    layoutDef = null;
    mounted = true;
    bindOnce();
    root.hidden = !App.prefs.get('skin');
    if (!raf) raf = requestAnimationFrame(loop);
    if (!beat) beat = setInterval(() => { if (opts.onState && lastState) opts.onState(lastState); }, C.inputHeartbeat);
    App.layout();
  }

  function unmount() {
    if (!mounted) return;
    releaseAll();
    if (opts.onState) opts.onState({ t: 'in', b: 0, x: 0, y: 0 });
    cancelAnimationFrame(raf); raf = 0;
    clearInterval(beat); beat = 0;
    mounted = false; lastKey = ''; lastState = null;
    root.hidden = true; root.innerHTML = ''; items = []; layoutDef = null;
    App.layout();
  }

  function setVisible(on) {
    if (!mounted) return;
    if (!on) releaseAll();
    root.hidden = !on;
    App.layout();
  }

  return {
    mount, unmount, relayout, setVisible,
    active: () => mounted && !root.hidden,
    isMounted: () => mounted
  };
})();
