// Delta skin import (.deltaskin = zip with info.json + PDF/PNG art), stored in IndexedDB,
// plus the skin picker in the menu.
const SkinLibrary = (() => {
  const JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  // Delta's N64 input names -> N6PhO inputs
  const MAP = {
    a: 'A', b: 'B', z: 'Z', l: 'L', r: 'R', start: 'START',
    up: 'DUP', down: 'DDOWN', left: 'DLEFT', right: 'DRIGHT',
    cup: 'CUP', cdown: 'CDOWN', cleft: 'CLEFT', cright: 'CRIGHT'
  };
  const mapName = (n) => MAP[String(n).toLowerCase()];

  // ---------- IndexedDB ----------
  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('n6pho', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('skins', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function store(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('skins', mode);
      const req = fn(t.objectStore('skins'));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  const list = () => store('readonly', (s) => s.getAll());
  const get = (id) => store('readonly', (s) => s.get(id));
  const put = (rec) => store('readwrite', (s) => s.put(rec));
  const del = (id) => store('readwrite', (s) => s.delete(id));

  // ---------- Import ----------
  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not download a helper library. Check your connection.'));
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  async function renderPdf(buf, targetW) {
    await loadScript(PDFJS);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(5, Math.max(1, targetW / base.width)) });
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
    return new Promise((res) => cv.toBlob(res, 'image/png'));
  }

  function findFile(zip, base, name) {
    if (!name) return null;
    const exact = zip.file(base + name) || zip.file(name);
    if (exact) return exact;
    const want = name.split('/').pop().toLowerCase();
    return Object.values(zip.files).find((f) => !f.dir && f.name.split('/').pop().toLowerCase() === want) || null;
  }

  async function asset(zip, base, name, targetW) {
    const f = findFile(zip, base, name);
    if (!f) return null;
    const buf = await f.async('arraybuffer');
    if (/\.pdf$/i.test(name)) return renderPdf(buf, targetW);
    const type = /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png';
    return new Blob([buf], { type });
  }

  function convertItem(it) {
    const frame = it.frame;
    if (!frame) return null;
    const ext = it.extendedEdges || null;
    const inp = it.inputs;
    if (Array.isArray(inp)) {
      const names = inp.map((n) => String(n));
      if (names.some((n) => n.toLowerCase() === 'menu')) return { type: 'menu', frame, ext };
      const mapped = names.map(mapName).filter(Boolean);
      if (mapped.length) return { type: 'button', inputs: mapped, frame, ext };
      const act = names.find((n) => /^quick(save|load)$/i.test(n));
      return act ? { type: 'action', action: act.toLowerCase(), frame, ext } : null;
    }
    if (inp && typeof inp === 'object') {
      if (Object.values(inp).some((v) => /^analogstick/i.test(String(v)))) {
        return { type: 'stick', frame, ext, thumbRef: it.thumbstick || null };
      }
      const dirs = {};
      for (const d of ['up', 'down', 'left', 'right']) { const m = mapName(inp[d]); if (m) dirs[d] = m; }
      return Object.keys(dirs).length ? { type: 'dpad', inputs: dirs, frame, ext } : null;
    }
    return null;
  }

  async function convertRep(rep, zip, base) {
    if (!rep || !rep.mappingSize) return null;
    const mw = rep.mappingSize.width, mh = rep.mappingSize.height;
    const a = rep.assets || {};
    const image = await asset(zip, base, a.resizable || a.large || a.medium || a.small, mw * 3);
    const items = [];
    for (const raw of rep.items || []) {
      const it = convertItem(raw);
      if (!it) continue;
      if (it.type === 'stick' && it.thumbRef) {
        it.thumbBlob = await asset(zip, base, it.thumbRef.name, (it.thumbRef.width || 80) * 3);
        it.thumbW = it.thumbRef.width; it.thumbH = it.thumbRef.height;
      }
      delete it.thumbRef;
      items.push(it);
    }
    const screen = rep.gameScreenFrame || (rep.screens && rep.screens[0] && rep.screens[0].outputFrame) || null;
    return { kind: 'delta', mw, mh, image, items, screen, translucent: !!rep.translucent, ext: rep.extendedEdges || null };
  }

  async function importFile(file) {
    await loadScript(JSZIP);
    const zip = await window.JSZip.loadAsync(file);
    const infoFile = Object.values(zip.files).find((f) => !f.dir && /(^|\/)info\.json$/i.test(f.name));
    if (!infoFile) throw new Error('That file isn’t a Delta skin (no info.json inside).');
    const base = infoFile.name.replace(/info\.json$/i, '');
    const info = JSON.parse(await infoFile.async('string'));
    if (info.gameTypeIdentifier && !/n64/i.test(info.gameTypeIdentifier)) {
      throw new Error('That Delta skin is for a different console. Pick an N64 skin.');
    }
    const reps = info.representations || {};
    const device = reps.iphone || reps.ipad || Object.values(reps)[0] || {};
    const variant = device.edgeToEdge || device.standard || Object.values(device)[0] || {};
    const rec = { id: 'delta:' + (info.identifier || info.name || Date.now()), name: info.name || 'Delta skin', layouts: {} };
    for (const o of ['portrait', 'landscape']) {
      const r = await convertRep(variant[o], zip, base);
      if (r) rec.layouts[o] = r;
    }
    if (!rec.layouts.portrait && !rec.layouts.landscape) throw new Error('No phone layouts found in that skin.');
    await put(rec);
    return rec;
  }

  // Stored record -> live skin def with object URLs
  const urls = [];
  function toDef(rec) {
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    const url = (b) => { if (!b) return null; const u = URL.createObjectURL(b); urls.push(u); return u; };
    const conv = (l) => l && Object.assign({}, l, {
      image: url(l.image),
      items: l.items.map((it) => Object.assign({}, it, { thumb: url(it.thumbBlob), thumbBlob: undefined }))
    });
    return { name: rec.name, portrait: conv(rec.layouts.portrait), landscape: conv(rec.layouts.landscape) };
  }

  // ---------- Menu wiring ----------
  async function refresh(selectedId) {
    const sel = document.getElementById('skinSel');
    let recs = [];
    try { recs = await list(); } catch (e) {}
    sel.innerHTML = `<option value="builtin">${App.esc(window.N6_SKINS[window.N6.skin].name)}</option>`
      + recs.map((r) => `<option value="${App.esc(r.id)}">${App.esc(r.name)}</option>`).join('');
    const id = selectedId || App.prefs.get('skinId') || 'builtin';
    sel.value = recs.some((r) => r.id === id) ? id : 'builtin';
    document.getElementById('skinDel').hidden = sel.value === 'builtin';
    return sel.value;
  }

  async function apply(id) {
    App.prefs.set('skinId', id);
    if (id === 'builtin') { Skin.setDef(null); return; }
    try {
      const rec = await get(id);
      Skin.setDef(rec ? toDef(rec) : null);
    } catch (e) { Skin.setDef(null); }
  }

  async function init() {
    const sel = document.getElementById('skinSel');
    const fileEl = document.getElementById('skinFile');
    const delBtn = document.getElementById('skinDel');
    const id = await refresh();
    await apply(id);

    sel.addEventListener('change', async () => {
      delBtn.hidden = sel.value === 'builtin';
      await apply(sel.value);
    });
    fileEl.addEventListener('change', async () => {
      const f = fileEl.files[0];
      fileEl.value = '';
      if (!f) return;
      App.toast('Importing skin…');
      try {
        const rec = await importFile(f);
        await refresh(rec.id);
        await apply(rec.id);
        App.toast(`Skin “${rec.name}” is ready.`);
      } catch (e) {
        App.toast(e.message || 'That skin could not be imported.');
      }
    });
    delBtn.addEventListener('click', async () => {
      if (sel.value === 'builtin') return;
      await del(sel.value);
      await refresh('builtin');
      await apply('builtin');
      App.toast('Skin deleted.');
    });
  }
  window.addEventListener('DOMContentLoaded', () => { init().catch(() => {}); });

  return { importFile, refresh };
})();
