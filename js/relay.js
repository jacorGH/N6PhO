// "Your relay": a TURN server just for you, used when two networks can't connect directly.
//   default    - Google STUN + PeerJS's free shared relay
//   cloudflare - a small Cloudflare Worker (relay/cloudflare-worker.js) hands out logins that expire
//   coturn     - your own server (relay/setup-coturn.sh); logins are made on this phone from its secret
// With "Share my relay with friends I invite", direct invites carry short-lived logins.
const Relay = (() => {
  const C = window.N6;
  const FREE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }
  ];
  const DAY = 86400;
  let cache = null; // { servers, expires }

  function settings() {
    return Object.assign({ mode: 'default', url: '', code: '', turn: '', secret: '', share: false }, App.prefs.get('relay') || {});
  }
  function save(s) { App.prefs.set('relay', s); cache = null; }

  async function hmacSha1B64(secret, msg) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
    let s = '';
    for (const b of sig) s += String.fromCharCode(b);
    return btoa(s);
  }

  // Browsers block TURN on port 53, and without trickle it would only add a timeout.
  function cleanServers(list) {
    const arr = Array.isArray(list) ? list : list ? [list] : [];
    return arr.map((s) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => u && !/:53(\?|$)/.test(u));
      return Object.assign({}, s, { urls });
    }).filter((s) => s.urls.length);
  }

  // Fresh logins for your own relay.
  async function mint(s) {
    if (s.mode === 'cloudflare') {
      if (!/^https:\/\//.test(s.url)) throw new Error('The Worker address should start with https://');
      const res = await fetch(s.url, { method: 'POST', headers: { 'X-Access-Code': s.code } });
      let j = null;
      try { j = await res.json(); } catch (e) {}
      if (!res.ok) throw new Error((j && j.error) || `The Worker answered ${res.status}.`);
      const servers = cleanServers(j.iceServers);
      if (!servers.some((x) => x.username)) throw new Error('The Worker didn’t return any relay logins.');
      return { servers, expires: j.expires || Date.now() + 20 * 3600e3 };
    }
    if (s.mode === 'coturn') {
      const urls = s.turn.split(/[\s,]+/).filter(Boolean).map((u) => (/^turns?:/.test(u) ? u : `turn:${u}`));
      if (!urls.length || !s.secret) throw new Error('Enter your relay address and secret.');
      const exp = Math.floor(Date.now() / 1000) + DAY;
      const username = `${exp}:n6pho`;
      return { servers: [{ urls, username, credential: await hmacSha1B64(s.secret, username) }], expires: exp * 1000 };
    }
    return null;
  }

  async function ownCached() {
    if (cache && cache.expires - Date.now() > 3600e3) return cache;
    cache = await mint(settings());
    return cache;
  }

  // ICE servers for any new connection. `extra` = logins a host shared in an invite.
  async function iceServers(extra) {
    const list = [];
    if (extra) list.push(...cleanServers(extra));
    const s = settings();
    if (s.mode !== 'default') {
      try {
        const own = await ownCached();
        list.push({ urls: 'stun:stun.l.google.com:19302' }, ...own.servers);
        return list;
      } catch (e) {
        App.toast('Your relay didn’t answer, so the free shared relay is being used.');
      }
    }
    list.push(...(C.iceServers || FREE));
    return list;
  }

  // Short-lived logins to put in a direct invite (only when sharing is on).
  async function shareable() {
    const s = settings();
    if (!s.share || s.mode === 'default') return null;
    try {
      const own = await ownCached();
      const t = own.servers.find((x) => x.username);
      if (!t) return null;
      // Keep it small: UDP first, then TLS on 443 for strict networks.
      const urls = t.urls.slice().sort((a, b) => score(a) - score(b)).slice(0, 3);
      return { urls, username: t.username, credential: t.credential };
    } catch (e) { return null; }
  }
  const score = (u) => (/transport=udp/.test(u) || /^turn:[^?]+$/.test(u) ? 0 : /^turns:.*:443/.test(u) ? 1 : 2);

  // Does the relay actually hand out a relayed address?
  async function test(servers) {
    const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
    pc.createDataChannel('t');
    const ok = new Promise((res) => {
      pc.onicecandidate = (e) => {
        if (e.candidate && / typ relay /.test(e.candidate.candidate)) res(true);
        if (!e.candidate) res(false);
      };
      setTimeout(() => res(false), 9000);
    });
    await pc.setLocalDescription(await pc.createOffer());
    const r = await ok;
    pc.close();
    return r;
  }

  // relay/setup-coturn.sh prints a link ending in #relay=… that saves your server here.
  function importFromHash() {
    const m = location.hash.match(/relay=([A-Za-z0-9_-]+)/);
    if (!m) return false;
    try {
      const t = m[1];
      const j = JSON.parse(atob(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4)));
      if (j.t !== 'coturn' || !j.urls || !j.secret) throw new Error();
      save(Object.assign(settings(), { mode: 'coturn', turn: [].concat(j.urls).join(', '), secret: j.secret }));
      history.replaceState(null, '', location.pathname + location.search);
      return true;
    } catch (e) { return 'bad'; }
  }

  // ---------- Lobby UI ----------
  function wire() {
    const $ = (id) => document.getElementById(id);
    const modeEl = $('relayMode');
    const fill = () => {
      const s = settings();
      modeEl.value = s.mode;
      $('relayUrl').value = s.url; $('relayCode').value = s.code;
      $('relayTurn').value = s.turn; $('relaySecret').value = s.secret;
      $('relayShare').checked = !!s.share;
      showMode();
      $('relayState').textContent = s.mode === 'cloudflare' ? 'Cloudflare' : s.mode === 'coturn' ? 'Your own server' : 'Free shared relay';
    };
    const showMode = () => {
      document.querySelectorAll('[data-relay]').forEach((el) => { el.hidden = el.dataset.relay !== modeEl.value; });
      $('relayShareRow').hidden = modeEl.value === 'default';
    };
    modeEl.addEventListener('change', showMode);

    $('relaySave').addEventListener('click', async () => {
      const s = {
        mode: modeEl.value, url: $('relayUrl').value.trim(), code: $('relayCode').value.trim(),
        turn: $('relayTurn').value.trim(), secret: $('relaySecret').value.trim(), share: $('relayShare').checked
      };
      const msg = $('relayMsg');
      save(s); fill();
      if (s.mode === 'default') { msg.textContent = 'Saved. Using the free shared relay.'; return; }
      msg.textContent = 'Testing your relay…';
      try {
        const own = await mint(s);
        cache = own;
        msg.textContent = (await test(own.servers))
          ? 'Saved. Your relay works.'
          : 'Saved, but no relayed connection came back. Check the address, and that the server’s firewall allows UDP 3478 and the relay ports.';
      } catch (e) { msg.textContent = `Saved, but the test failed: ${e.message}`; }
    });

    $('workerCopy').addEventListener('click', async () => {
      try {
        const code = await (await fetch('relay/cloudflare-worker.js')).text();
        await navigator.clipboard.writeText(code);
        App.toast('Worker code copied. Paste it into your Cloudflare Worker.');
      } catch (e) { App.toast('Couldn’t copy. Open relay/cloudflare-worker.js in your repo instead.'); }
    });

    const imported = importFromHash();
    fill();
    if (imported === true) {
      document.querySelector('.relay-panel').open = true;
      $('relayMsg').textContent = 'Your server was saved from the setup link. Tap Save and test.';
    } else if (imported === 'bad') {
      $('relayMsg').textContent = 'That relay link was damaged. Run the setup script again or enter the details by hand.';
    }
  }
  window.addEventListener('DOMContentLoaded', wire);

  return { iceServers, shareable, settings, test, mint, cleanServers };
})();
