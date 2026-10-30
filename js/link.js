// Connections.
// Every guest has one "link" to the host: either a PeerJS data connection (room code) or a direct
// WebRTC data channel set up with invite/reply codes (no lobby server at all). Video, game sound and
// voice are then negotiated *inside* that link, so after the first connection nothing needs the
// lobby server. The host also passes connection messages between guests (it's the broker), which is
// how guests open voice links to each other.

class Emitter {
  constructor() { this._h = {}; }
  on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; }
  off(e, f) { this._h[e] = (this._h[e] || []).filter((x) => x !== f); return this; }
  emit(e, ...a) { (this._h[e] || []).slice().forEach((f) => { try { f(...a); } catch (err) { console.error(err); } }); }
}

const Links = (() => {
  const rid = () => Math.random().toString(36).slice(2, 10);

  // Video codecs: H.264 first (phones encode it in hardware, easier on the battery), then VP8.
  function preferCodecs(pc) {
    try {
      if (!window.RTCRtpSender || !RTCRtpSender.getCapabilities) return;
      const caps = RTCRtpSender.getCapabilities('video');
      if (!caps) return;
      const score = (c) => (/packetization-mode=1/.test(c.sdpFmtpLine || '') ? 2 : 0) + (/profile-level-id=42e0/.test(c.sdpFmtpLine || '') ? 1 : 0);
      const h264 = caps.codecs.filter((c) => /h264/i.test(c.mimeType)).sort((a, b) => score(b) - score(a));
      const vp8 = caps.codecs.filter((c) => /vp8/i.test(c.mimeType));
      const extra = caps.codecs.filter((c) => /rtx|red|ulpfec/i.test(c.mimeType));
      if (!h264.length && !vp8.length) return;
      const list = [...h264, ...vp8, ...extra];
      for (const t of pc.getTransceivers()) {
        if (t.sender.track && t.sender.track.kind === 'video' && t.setCodecPreferences) t.setCodecPreferences(list);
      }
    } catch (e) { /* keep browser defaults */ }
  }

  // ---------- Link: a message channel that can also carry calls ----------
  class Link extends Emitter {
    constructor(id, metadata, iceServers) {
      super();
      this.id = id; this.metadata = metadata || {}; this.iceServers = iceServers || [];
      this.open = false; this.closed = false; this.calls = new Map();
    }
    send(m) { if (this.open && !this.closed) { try { this._send(m); } catch (e) {} } }
    _onRaw(m) {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'sig') { this._onSig(m); return; }
      this.emit('data', m);
    }
    _sig(m) { this.send(Object.assign({ t: 'sig' }, m)); }
    _onSig(m) {
      let c = this.calls.get(m.id);
      if (m.k === 'offer' && !c) {
        c = new SignalCall(this, m.id, false, m.meta);
        c._offer = m.sdp;
        this.calls.set(m.id, c);
        this.emit('call', c);
        return;
      }
      if (!c) return;
      if (m.k === 'answer') c._onAnswer(m.sdp);
      else if (m.k === 'ice') c._onIce(m.c);
      else if (m.k === 'bye') c.close(true);
    }
    // Start a one-way media call to the other side.
    call(stream, meta) {
      const c = new SignalCall(this, rid(), true, meta);
      this.calls.set(c.id, c);
      c._start(stream);
      return c;
    }
    _opened() { if (this.open || this.closed) return; this.open = true; this.emit('open'); }
    _closed() {
      if (this.closed) return;
      this.closed = true; this.open = false;
      for (const c of [...this.calls.values()]) c.close(true);
      this.emit('close');
    }
    close() { if (this.closed) return; try { if (this._closeImpl) this._closeImpl(); } catch (e) {} this._closed(); }
  }

  // ---------- A media call negotiated through a link ----------
  class SignalCall extends Emitter {
    constructor(link, id, outgoing, meta) {
      super();
      this.link = link; this.id = id; this.outgoing = outgoing; this.metadata = meta || {};
      this.closed = false; this._iceQ = []; this._streams = new Set();
      const pc = this.pc = new RTCPeerConnection({ iceServers: link.iceServers });
      pc.onicecandidate = (e) => { if (e.candidate) link._sig({ id, k: 'ice', c: e.candidate.toJSON() }); };
      pc.ontrack = (e) => {
        const s = e.streams[0] || new MediaStream([e.track]);
        if (!this._streams.has(s.id)) { this._streams.add(s.id); this.emit('stream', s); }
      };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') this.close(); };
    }
    get peerConnection() { return this.pc; }
    async _start(stream) {
      try {
        for (const t of stream.getTracks()) this.pc.addTransceiver(t, { direction: 'sendonly', streams: [stream] });
        preferCodecs(this.pc);
        await this.pc.setLocalDescription(await this.pc.createOffer());
        this.link._sig({ id: this.id, k: 'offer', sdp: this.pc.localDescription.sdp, meta: this.metadata });
      } catch (e) { this.close(); }
    }
    async answer() {
      try {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: this._offer });
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.link._sig({ id: this.id, k: 'answer', sdp: this.pc.localDescription.sdp });
        this._flush();
      } catch (e) { this.close(); }
    }
    async _onAnswer(sdp) {
      try { await this.pc.setRemoteDescription({ type: 'answer', sdp }); this._flush(); } catch (e) { this.close(); }
    }
    _onIce(c) { if (this.pc.remoteDescription) this.pc.addIceCandidate(c).catch(() => {}); else this._iceQ.push(c); }
    _flush() { for (const c of this._iceQ.splice(0)) this.pc.addIceCandidate(c).catch(() => {}); }
    close(silent) {
      if (this.closed) return;
      this.closed = true;
      if (!silent) this.link._sig({ id: this.id, k: 'bye' });
      this.link.calls.delete(this.id);
      try { this.pc.close(); } catch (e) {}
      this.emit('close');
    }
  }

  // ---------- Room-code link: wraps a PeerJS DataConnection ----------
  function fromPeerJS(dc, iceServers) {
    const L = new Link(dc.peer, dc.metadata, iceServers);
    L._send = (m) => dc.send(m);
    L._closeImpl = () => dc.close();
    dc.on('data', (m) => L._onRaw(m));
    dc.on('close', () => L._closed());
    dc.on('error', () => L._closed());
    if (dc.open) setTimeout(() => L._opened(), 0); else dc.on('open', () => L._opened());
    return L;
  }

  // ---------- Direct link: WebRTC data channel, set up with invite/reply codes ----------
  class DirectLink extends Link {
    constructor(iceServers, isHost) {
      super('direct-' + rid(), {}, iceServers);
      this.sid = crypto.getRandomValues(new Uint8Array(4));
      const pc = this.pc = new RTCPeerConnection({ iceServers });
      if (isHost) this._attach(pc.createDataChannel('n6', { ordered: true }));
      else pc.ondatachannel = (e) => this._attach(e.channel);
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        this.emit('state', s);
        if (s === 'failed' || s === 'closed') this._closed();
      };
      this._closeImpl = () => { try { if (this.dc) this.dc.close(); } catch (e) {} pc.close(); };
    }
    _attach(dc) {
      this.dc = dc;
      dc.onopen = () => this._opened();
      dc.onclose = () => this._closed();
      dc.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } this._onRaw(m); };
      if (dc.readyState === 'open') this._opened();
    }
    _send(m) { this.dc.send(JSON.stringify(m)); }

    // Host: make the invite text.
    async createInvite(extra) {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await gathered(this.pc);
      return Codes.pack(Object.assign({ kind: 'invite', sid: this.sid }, Codes.parseSdp(this.pc.localDescription.sdp), extra));
    }
    // Host: use the friend's reply.
    async acceptReply(text) {
      const r = Codes.unpack(text);
      if (r.kind !== 'reply') throw new Error('That’s not a reply code. Paste the code your friend sent back.');
      if (r.sid.join() !== this.sid.join()) throw new Error('That reply belongs to a different invite. Send the newest invite again.');
      await this.pc.setRemoteDescription({ type: 'answer', sdp: Codes.buildSdp(r, 'answer') });
    }
    // Guest: answer an invite, returns the reply text.
    async acceptInvite(inv) {
      this.sid = inv.sid;
      await this.pc.setRemoteDescription({ type: 'offer', sdp: Codes.buildSdp(inv, 'offer') });
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await gathered(this.pc);
      return Codes.pack(Object.assign({ kind: 'reply', sid: inv.sid }, Codes.parseSdp(this.pc.localDescription.sdp)));
    }
  }

  // Codes can't trickle candidates, so wait for gathering (or give up after a few seconds).
  function gathered(pc, ms = 5000) {
    return new Promise((res) => {
      if (pc.iceGatheringState === 'complete') { res(); return; }
      const done = () => { if (pc.iceGatheringState === 'complete') res(); };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(res, ms);
    });
  }

  // ---------- Guest-to-guest link, carried through the host (broker) ----------
  class RelayLink extends Link {
    constructor(hostLink, peerId, iceServers) {
      super(peerId, {}, iceServers);
      this.host = hostLink;
      this.open = true;
    }
    _send(m) { this.host.send({ t: 'relay', to: this.id, msg: m }); }
  }

  return { Link, SignalCall, DirectLink, RelayLink, fromPeerJS, preferCodecs, gathered };
})();

// ---------- Invite / reply codes ----------
// A direct invite only needs what the other phone can't guess: the ICE login, the encryption
// fingerprint and a few addresses. Those are packed into bytes and the full connection
// description is rebuilt on the other side from a fixed template.
const Codes = (() => {
  const PREFIX = { invite: 'N6I.', reply: 'N6R.' };
  const TYPES = ['host4', 'host6', 'mdns', 'srflx4', 'srflx6', 'relay4', 'relay6'];
  const enc = new TextEncoder(), dec = new TextDecoder();

  function b64url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(t) {
    const s = atob(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4));
    return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  }

  function ip6Bytes(a) {
    a = a.split('%')[0];
    let parts = a.split('::');
    const head = parts[0] ? parts[0].split(':') : [], tail = parts[1] ? parts[1].split(':') : [];
    const fill = parts.length > 1 ? Array(8 - head.length - tail.length).fill('0') : [];
    const groups = [...head, ...fill, ...tail];
    if (groups.length !== 8) return null;
    const out = [];
    for (const g of groups) { const v = parseInt(g || '0', 16); out.push(v >> 8, v & 255); }
    return out;
  }
  function ip6Text(b) {
    const g = [];
    for (let i = 0; i < 16; i += 2) g.push(((b[i] << 8) | b[i + 1]).toString(16));
    return g.join(':');
  }
  function addrBytes(c) {
    if (c.ty.endsWith('4')) { const p = c.addr.split('.').map(Number); return p.length === 4 && p.every((x) => x >= 0 && x < 256) ? p : null; }
    if (c.ty.endsWith('6')) return ip6Bytes(c.addr);
    if (c.ty === 'mdns') { // random name like 1f2e…-….local
      const hex = c.addr.replace(/\.local$/, '').replace(/-/g, '');
      if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
      return hex.match(/../g).map((h) => parseInt(h, 16));
    }
    return null;
  }
  function addrText(ty, b) {
    if (ty.endsWith('4')) return b.join('.');
    if (ty.endsWith('6')) return ip6Text(b);
    const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
  }

  function parseSdp(sdp) {
    const get = (re) => (sdp.match(re) || [])[1];
    const fpHex = get(/a=fingerprint:sha-256 (\S+)/i) || '';
    const cands = [], seen = new Set();
    for (const line of sdp.split(/\r?\n/)) {
      if (!line.startsWith('a=candidate:')) continue;
      const t = line.slice(12).split(' ');
      if (t[1] !== '1' || (t[2] || '').toLowerCase() !== 'udp') continue;
      const addr = t[4], port = +t[5], typ = t[7];
      const v6 = addr.includes(':');
      let ty;
      if (typ === 'host') ty = addr.endsWith('.local') ? 'mdns' : v6 ? 'host6' : 'host4';
      else if (typ === 'srflx' || typ === 'prflx') ty = v6 ? 'srflx6' : 'srflx4';
      else if (typ === 'relay') ty = v6 ? 'relay6' : 'relay4';
      else continue;
      const key = `${addr}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cands.push({ ty, addr, port });
    }
    // Keep the most useful few: relays and public addresses first.
    const rank = (c) => (c.ty.startsWith('srflx') ? 0 : c.ty.startsWith('relay') ? 1 : 2);
    cands.sort((a, b) => rank(a) - rank(b));
    return {
      u: get(/a=ice-ufrag:(\S+)/), p: get(/a=ice-pwd:(\S+)/),
      fp: fpHex.split(':').map((h) => parseInt(h, 16)),
      setup: get(/a=setup:(\S+)/), cands: cands.slice(0, 8)
    };
  }

  function pack(o) {
    const w = [];
    const b8 = (v) => w.push(v & 255);
    const b16 = (v) => { b8(v >> 8); b8(v); };
    const str = (s) => { const e = enc.encode(s || '').slice(0, 255); b8(e.length); e.forEach(b8); };
    const lstr = (s) => { const e = enc.encode(s || ''); b16(e.length); e.forEach(b8); };
    b8(1); // format version
    b8(o.kind === 'invite' ? 1 : 2);
    for (let i = 0; i < 4; i++) b8(o.sid[i]);
    str(o.u); str(o.p);
    if (!o.fp || o.fp.length !== 32) throw new Error('Unexpected connection fingerprint.');
    o.fp.forEach(b8);
    b8(o.setup === 'passive' ? 1 : 0);
    const cands = o.cands.map((c) => ({ c, b: addrBytes(c) })).filter((x) => x.b);
    b8(cands.length);
    for (const { c, b } of cands) { b8(TYPES.indexOf(c.ty)); b.forEach(b8); b16(c.port); }
    if (o.kind === 'invite') {
      str(o.name); str(o.room);
      lstr(o.relay ? JSON.stringify(o.relay) : '');
    }
    return PREFIX[o.kind] + b64url(Uint8Array.from(w));
  }

  function unpack(text) {
    const m = String(text || '').match(/N6([IR])\.([A-Za-z0-9_-]+)/);
    if (!m) throw new Error('That doesn’t look like an N6PhO code.');
    const b = unb64url(m[2]);
    let i = 0;
    const r8 = () => { if (i >= b.length) throw new Error('That code is cut off. Copy all of it.'); return b[i++]; };
    const r16 = () => (r8() << 8) | r8();
    const rn = (n) => { const out = []; for (let k = 0; k < n; k++) out.push(r8()); return out; };
    const str = () => dec.decode(Uint8Array.from(rn(r8())));
    const lstr = () => dec.decode(Uint8Array.from(rn(r16())));
    if (r8() !== 1) throw new Error('That code is from a different version of N6PhO.');
    const kind = r8() === 1 ? 'invite' : 'reply';
    const o = { kind, sid: Uint8Array.from(rn(4)), u: str(), p: str(), fp: rn(32), setup: r8() ? 'passive' : 'active', cands: [] };
    const n = r8();
    for (let k = 0; k < n; k++) {
      const ty = TYPES[r8()];
      const len = ty.endsWith('4') ? 4 : 16;
      const addr = addrText(ty, rn(len));
      o.cands.push({ ty, addr, port: r16() });
    }
    if (kind === 'invite') {
      o.name = str(); o.room = str();
      const rj = lstr();
      o.relay = rj ? JSON.parse(rj) : null;
    }
    return o;
  }

  function buildSdp(o, type) {
    const fp = o.fp.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
    const setup = type === 'offer' ? 'actpass' : o.setup === 'passive' ? 'passive' : 'active';
    const lines = [
      'v=0', `o=- ${Math.floor(Math.random() * 1e15)} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0',
      'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
      `a=ice-ufrag:${o.u}`, `a=ice-pwd:${o.p}`, 'a=ice-options:trickle',
      `a=fingerprint:sha-256 ${fp}`, `a=setup:${setup}`, 'a=mid:0',
      'a=sctp-port:5000', 'a=max-message-size:262144'
    ];
    const PREF = { host4: 126, host6: 126, mdns: 126, srflx4: 100, srflx6: 100, relay4: 2, relay6: 2 };
    o.cands.forEach((c, i) => {
      const typ = c.ty.startsWith('relay') ? 'relay' : c.ty.startsWith('srflx') ? 'srflx' : 'host';
      const prio = PREF[c.ty] * 16777216 + (65535 - i) * 256 + 255;
      lines.push(`a=candidate:${i + 1} 1 udp ${prio} ${c.addr} ${c.port} typ ${typ}${typ === 'host' ? '' : ' raddr 0.0.0.0 rport 0'}`);
    });
    lines.push('a=end-of-candidates');
    return lines.join('\r\n') + '\r\n';
  }

  return { pack, unpack, parseSdp, buildSdp };
})();
