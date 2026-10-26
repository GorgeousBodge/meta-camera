// Signalling for cam.html (phone) <-> view.html (glasses).
// The video never passes through here: this only swaps the short WebRTC
// "offer" and "answer" messages, and hands out relay (TURN) credentials.
//
// Vercel env vars:
//   MONITOR_KEY                 your own passphrase; both pages must send it
//   UPSTASH_REDIS_REST_URL      from Upstash (or KV_REST_API_URL if added via Vercel's marketplace)
//   UPSTASH_REDIS_REST_TOKEN    (or KV_REST_API_TOKEN)
//   CF_TURN_KEY_ID              optional: Cloudflare Realtime TURN key id
//   CF_TURN_API_TOKEN           optional: that key's API token
//   TURN_URL, TURN_USER, TURN_PASS  optional: your own coturn instead (TURN_URL can be comma-separated)

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const KEY = process.env.MONITOR_KEY;
const MSG_TTL = 60;    // seconds an unanswered offer/answer lives
const ALIVE_TTL = 15;  // camera counts as "online" this long after its last check-in

async function redis(cmds) {
  const r = await fetch(R_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + R_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('storage ' + r.status);
  return (await r.json()).map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

async function iceServers() {
  const list = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN) {
    try {
      const r = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + process.env.CF_TURN_API_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 3600 }),
        });
      if (r.ok) {
        const j = await r.json();
        // Browsers block port 53, and we wait for full ICE gathering, so drop those URLs.
        return [].concat(j.iceServers).map(s => ({
          ...s, urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u)),
        }));
      }
    } catch (e) { /* fall through to STUN / own TURN */ }
  }
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map(s => s.trim()),
      username: process.env.TURN_USER, credential: process.env.TURN_PASS,
    });
  }
  return list;
}

const parse = s => (s ? JSON.parse(s) : null);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!R_URL || !R_TOKEN || !KEY) {
    return res.status(500).json({ error: 'Not configured: set MONITOR_KEY and the Upstash REST URL/token in Vercel' });
  }
  if (req.headers['x-key'] !== KEY) return res.status(401).json({ error: 'Wrong key' });

  const q = req.query || {}, body = req.body || {};
  const room = String(q.room || body.room || 'cam1').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'cam1';
  const k = `mon:${room}:`;

  try {
    switch (q.a) {
      case 'ice':      // both sides: relay credentials
        return res.json({ iceServers: await iceServers() });

      case 'status': { // viewer: is the camera armed?
        const [alive] = await redis([['GET', k + 'alive']]);
        return res.json({ camOnline: !!alive });
      }

      case 'call':     // viewer: leave an offer for the camera
        await redis([['SET', k + 'offer', JSON.stringify(body.offer), 'EX', MSG_TTL], ['DEL', k + 'answer']]);
        return res.json({ ok: true });

      case 'wait': {   // camera: check in, collect any waiting offer
        const [, offer] = await redis([['SET', k + 'alive', '1', 'EX', ALIVE_TTL], ['GETDEL', k + 'offer']]);
        return res.json({ offer: parse(offer) });
      }

      case 'answer':   // camera: reply to the offer
        await redis([['SET', k + 'answer', JSON.stringify(body.answer), 'EX', MSG_TTL]]);
        return res.json({ ok: true });

      case 'poll': {   // viewer: collect the answer
        const [answer, alive] = await redis([['GETDEL', k + 'answer'], ['GET', k + 'alive']]);
        return res.json({ answer: parse(answer), camOnline: !!alive });
      }

      case 'disarm':   // camera: going offline
        await redis([['DEL', k + 'alive']]);
        return res.json({ ok: true });

      default:
        return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
