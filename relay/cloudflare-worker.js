// N6PhO relay Worker for Cloudflare.
// Hands out TURN logins that expire within a day, and only to someone who knows your access code.
// Your long-term TURN key never leaves Cloudflare.
//
// Settings (Worker → Settings → Variables and Secrets):
//   TURN_KEY_ID         your TURN key ID (Realtime → TURN Server in the Cloudflare dashboard)
//   TURN_KEY_API_TOKEN  that TURN key's API token (add it as a Secret)
//   ACCESS_CODE         any passphrase you make up; you type the same one into N6PhO (add it as a Secret)

const TTL = 20 * 60 * 60; // logins last 20 hours

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Access-Code, Content-Type',
      'Access-Control-Max-Age': '86400'
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return reply({ error: 'This is the N6PhO relay. It only answers the app.' }, 405);
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN || !env.ACCESS_CODE) {
      return reply({ error: 'The Worker is missing a setting: TURN_KEY_ID, TURN_KEY_API_TOKEN or ACCESS_CODE.' }, 500);
    }
    if (!(await sameText(request.headers.get('X-Access-Code') || '', env.ACCESS_CODE))) {
      return reply({ error: 'Wrong access code.' }, 401);
    }

    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL })
      }
    );
    if (!res.ok) return reply({ error: `Cloudflare refused the TURN key (${res.status}). Check TURN_KEY_ID and TURN_KEY_API_TOKEN.` }, 502);
    const data = await res.json();
    let servers = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    // Browsers block port 53, which would only add a timeout.
    servers = servers
      .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length);
    return reply({ iceServers: servers, expires: Date.now() + TTL * 1000 });
  }
};

// Compare without leaking timing.
async function sameText(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
