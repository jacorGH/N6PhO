// Connection stats from WebRTC getStats(), plus automatic picture quality on the host.
const NetStats = (() => {
  const C = window.N6;

  async function routeOf(report) {
    let pair = null;
    report.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId);
    });
    if (!pair) report.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    if (!pair) return { rtt: null, relay: false };
    const local = report.get(pair.localCandidateId), remote = report.get(pair.remoteCandidateId);
    return {
      rtt: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
      relay: (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay')
    };
  }

  // Host side: what we're sending to one guest.
  async function outbound(pc, prev) {
    const r = await pc.getStats();
    let out = null, rin = null;
    r.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
      if (s.type === 'remote-inbound-rtp' && s.kind === 'video') rin = s;
    });
    const route = await routeOf(r);
    const now = performance.now();
    let kbps = null;
    if (out && prev && prev.bytes != null) kbps = ((out.bytesSent - prev.bytes) * 8) / (now - prev.t);
    return {
      t: now, bytes: out ? out.bytesSent : null, kbps,
      fps: out && out.framesPerSecond != null ? Math.round(out.framesPerSecond) : null,
      width: out ? out.frameWidth : null, height: out ? out.frameHeight : null,
      limit: out ? out.qualityLimitationReason : null,
      loss: rin && rin.fractionLost != null ? rin.fractionLost : null,
      rtt: rin && rin.roundTripTime != null ? rin.roundTripTime * 1000 : route.rtt,
      relay: route.relay
    };
  }

  // Guest side: what we're receiving from the host.
  async function inbound(pc, prev) {
    const r = await pc.getStats();
    let vin = null;
    r.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') vin = s; });
    const route = await routeOf(r);
    const now = performance.now();
    let kbps = null, loss = null;
    if (vin && prev && prev.bytes != null) {
      kbps = ((vin.bytesReceived - prev.bytes) * 8) / (now - prev.t);
      const lost = vin.packetsLost - prev.lost, got = vin.packetsReceived - prev.got;
      loss = lost + got > 0 ? Math.max(0, lost) / (lost + got) : 0;
    }
    return {
      t: now, bytes: vin ? vin.bytesReceived : null, lost: vin ? vin.packetsLost : 0, got: vin ? vin.packetsReceived : 0,
      kbps, loss,
      fps: vin && vin.framesPerSecond != null ? Math.round(vin.framesPerSecond) : null,
      width: vin ? vin.frameWidth : null, height: vin ? vin.frameHeight : null,
      jitter: vin && vin.jitter != null ? vin.jitter * 1000 : null,
      rtt: route.rtt, relay: route.relay
    };
  }

  // good / ok / poor from ping and packet loss
  function grade(rtt, loss) {
    if (rtt == null) return 'unknown';
    const l = loss || 0;
    if (rtt < 120 && l < 0.02) return 'good';
    if (rtt < 250 && l < 0.06) return 'ok';
    return 'poor';
  }

  function qualityLabel(kbps) {
    if (kbps == null) return '–';
    if (kbps >= 1500) return 'High';
    if (kbps >= 800) return 'Medium';
    return 'Low';
  }

  // Host: pick a bitrate for one guest. mode: auto | high | saver
  function adapt(c, st, mode) {
    const cap = mode === 'high' ? Math.round(C.videoBitrate * 1.5) : mode === 'saver' ? C.minBitrate * 2 : C.videoBitrate;
    let rate = c.rate || Math.min(cap, C.videoBitrate);
    let fps = C.streamFps;
    if (mode === 'auto') {
      const loss = st.loss || 0, rtt = st.rtt || 0;
      // WebRTC already follows available bandwidth on its own (and says "bandwidth-limited" while
      // it ramps up), so only real trouble signs move the cap: packet loss and rising ping.
      const bad = loss > 0.05 || rtt > 300;
      const good = loss < 0.01 && rtt < 200;
      if (bad) { rate *= 0.7; c.goodRun = 0; }
      else if (good) { c.goodRun = (c.goodRun || 0) + 1; if (c.goodRun >= 3) { rate *= 1.15; c.goodRun = 0; } }
      if (st.limit === 'cpu') fps = 30; // host phone is struggling: send fewer frames
    } else if (mode === 'saver') fps = 30;
    rate = Math.round(Math.max(C.minBitrate, Math.min(cap, rate)));
    return { rate, fps };
  }

  async function applyRate(pc, rate, fps) {
    for (const s of pc.getSenders()) {
      if (!s.track || s.track.kind !== 'video') continue;
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = rate;
      p.encodings[0].maxFramerate = fps;
      p.degradationPreference = 'maintain-framerate'; // games feel worse at low fps than at low res
      try { await s.setParameters(p); }
      catch (e) { delete p.degradationPreference; try { await s.setParameters(p); } catch (e2) {} }
    }
  }

  const fmtKbps = (k) => (k == null ? '–' : k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${Math.round(k)} kbps`);
  const fmtLoss = (l) => (l == null ? '–' : `${(l * 100).toFixed(l < 0.1 ? 1 : 0)}%`);

  return { outbound, inbound, grade, qualityLabel, adapt, applyRate, fmtKbps, fmtLoss };
})();
