'use strict';
/* =====================================================================
   Hushchats server  —  zero dependencies (Node 18+ built-ins only)
   ---------------------------------------------------------------------
   What it does
   • Serves the web app (public/) and the Android APK
   • WebSocket relay at /ws:
       – accounts: a handle is bound to a public key (ECDSA-signed login)
       – presence: who is online / last seen, pushed live to friends
       – offline queue: messages wait on the server until the friend's
         device comes back, then are delivered and removed
       – ephemeral signalling: typing + call setup (never stored)
   • Media: POST/GET /api/media  (photos + voice notes, stored ENCRYPTED —
     the server never sees keys or content)
   Privacy: every message/receipt/call frame is end-to-end encrypted by the
   apps. The server only sees who talks to whom, when, and sizes.
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------ config ------------------------------ */
const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ALLOW_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
/* TURN relay: when set, calls are forced through this relay so neither side ever learns the other's IP.
   Static creds (TURN_URL/TURN_USER/TURN_PASS) or a coturn "use-auth-secret" shared secret (TURN_SECRET) — either works.
   Free options if you don't want to run your own: openrelay.metered.ca, or self-host coturn (cheap on Railway/Fly). */
const TURN_URLS = (process.env.TURN_URL || '').split(',').map(x => x.trim()).filter(Boolean);
const TURN_USER = process.env.TURN_USER || '';
const TURN_PASS = process.env.TURN_PASS || '';
const TURN_SECRET = process.env.TURN_SECRET || '';
const MEDIA_MAX = 9 * 1024 * 1024;              // encrypted media upload limit
const MEDIA_TTL = 14 * 24 * 3600 * 1000;        // photos/voice notes live 14 days
const QUEUE_TTL = 30 * 24 * 3600 * 1000;        // undelivered messages live 30 days
const DEVICE_TTL = 45 * 24 * 3600 * 1000;       // devices unseen this long stop receiving queued mail
const ALIAS_TTL = 30 * 24 * 3600 * 1000;        // an old ID forwards to the new one for 30 days
const TOKEN_TTL = 24 * 3600 * 1000;
const ENV_MAX = 300 * 1024;                     // one queued envelope (profile photos are the biggest)
const SIG_MAX = 64 * 1024;
const QUEUE_MAX = 5000;                         // envelopes per device
const WS_MAX = 1024 * 1024;
const OFFLINE_GRACE = 4000;                     // don't flash "offline" on a 4 s network blip
const PING_MS = 8000;                           // was 20000: a dead phone socket (locked screen, network
                                                 // switch, backgrounded app) could sit "online" for up to
                                                 // 20000*2.5=50s before the server noticed and cleared it —
                                                 // long enough that a friend's presence still said "online",
                                                 // and a call placed to that stale connection would ring into
                                                 // nothing and then time out as "call failed". Pinging every
                                                 // 8s and giving up after 2 missed pings (~20s total) catches
                                                 // a dead device roughly 2.5x faster without flapping a merely
                                                 // slow connection offline.
const RESERVED = new Set(['admin', 'root', 'system', 'support', 'hushchats', 'help', 'null', 'undefined', 'server']);

const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

/* ------------------------------ helpers ----------------------------- */
const HANDLE_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const isHandle = x => typeof x === 'string' && x.length >= 3 && x.length <= 12 && HANDLE_RE.test(x);
const isDev = x => typeof x === 'string' && /^[a-f0-9]{8,32}$/.test(x);
const isMid = x => typeof x === 'string' && x.length > 0 && x.length <= 64 && /^[A-Za-z0-9_-]+$/.test(x);
const b64uOk = (x, max) => typeof x === 'string' && x.length <= max && /^[A-Za-z0-9_-]*$/.test(x);
const now = () => Date.now();
const rid = n => crypto.randomBytes(n).toString('hex');
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------ storage ----------------------------- */
/* users:   handle -> { pub, name, created, lastSeen, hide, devs:{ devId: lastSeenTs } }
   queues:  handle -> { devId: [ { mid, from, cls, iv, ct, ts } ] }
   aliases: oldHandle -> { to, exp }
   Files are written atomically; point DATA_DIR at a Railway Volume so they survive redeploys. */
const F_USERS = path.join(DATA_DIR, 'users.json');
const F_QUEUES = path.join(DATA_DIR, 'queues.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
let db = readJson(F_USERS, { users: {}, aliases: {} });
let users = db.users || {}, aliases = db.aliases || {};
let queues = readJson(F_QUEUES, {});
let dirtyU = false, dirtyQ = false, saveTimer = null;
function writeAtomic(file, data) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
function flushSync() {
  try { if (dirtyU) { writeAtomic(F_USERS, JSON.stringify({ users, aliases })); dirtyU = false; } } catch (e) { log('save users failed', e.message); }
  try { if (dirtyQ) { writeAtomic(F_QUEUES, JSON.stringify(queues)); dirtyQ = false; } } catch (e) { log('save queues failed', e.message); }
}
function markU() { dirtyU = true; sched(); }
function markQ() { dirtyQ = true; sched(); }
function sched() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; flushSync(); }, 800); }

/* ------------------------------ runtime state ----------------------- */
const online = new Map();      // handle -> Set<conn>
const watchers = new Map();    // handle -> Set<conn>
const tokens = new Map();      // token -> { handle, exp }
const recent = new Map();      // dedupe key -> ts
const offTimers = new Map();   // handle -> timeout (offline grace)

/* Chases the whole alias chain (someone can rename more than once inside the 30-day window),
   not just one hop — a cycle guard keeps this safe even if data ever got corrupted. */
function resolveAlias(h) {
  for (let hops = 0; hops < 8; hops++) { const a = aliases[h]; if (!a || a.exp <= now()) break; h = a.to; }
  return h;
}
const handleTaken = h => !!users[h] || (aliases[h] && aliases[h].exp > now()) || RESERVED.has(h);

/* ------------------------------ presence ---------------------------- */
function presenceOf(h) {
  const u = users[h]; if (!u) return null;
  if (u.hide) return { on: false, ls: 0 };
  return { on: online.has(h), ls: u.lastSeen || 0 };
}
function pushTo(conn, obj) { if (conn.ws && !conn.ws.closed) conn.ws.send(JSON.stringify(obj)); }
function broadcastPresence(h) {
  const set = watchers.get(h); if (!set || !set.size) return;
  const p = presenceOf(h); if (!p) return;
  const msg = JSON.stringify({ op: 'presence', id: h, on: p.on, ls: p.ls });
  set.forEach(c => { if (c.ws && !c.ws.closed) c.ws.send(msg); });
}
function goOnline(conn) {
  const h = conn.handle; let set = online.get(h);
  const timer = offTimers.get(h); if (timer) { clearTimeout(timer); offTimers.delete(h); }
  const first = !set || set.size === 0;
  if (!set) online.set(h, set = new Set());
  set.add(conn);
  if (first) broadcastPresence(h);
}
function goOffline(conn) {
  const h = conn.handle; if (!h) return;
  const set = online.get(h); if (!set) return;
  set.delete(conn);
  if (set.size) return;
  const t = setTimeout(() => {
    offTimers.delete(h);
    const s2 = online.get(h); if (s2 && s2.size) return;
    online.delete(h);
    if (users[h]) { users[h].lastSeen = now(); markU(); }
    broadcastPresence(h);
  }, OFFLINE_GRACE);
  offTimers.set(h, t);
}

/* ------------------------------ queue ------------------------------- */
function activeDevs(u, exceptDev) {
  const t = now(); const out = [];
  for (const [d, ts] of Object.entries(u.devs || {})) if (t - ts < DEVICE_TTL && d !== exceptDev) out.push(d);
  return out;
}
/* '*' is a fallback bucket (see below) for a recipient with no currently-active device at all —
   without it, a message to someone whose only device has gone stale (or who is between
   reinstalls) would silently vanish even though their account still exists. */
function enqueue(from, to, env, senderDev) {
  const u = users[to]; if (!u) return false;
  const q = queues[to] || (queues[to] = {});
  const devs = activeDevs(u, from === to ? senderDev : null);
  const buckets = devs.length ? devs : ['*'];
  for (const dev of buckets) {
    const list = q[dev] || (q[dev] = []);
    if (env.cls === 'profile') for (let i = list.length - 1; i >= 0; i--) if (list[i].cls === 'profile' && list[i].from === from) list.splice(i, 1);
    list.push(env);
    while (list.length > QUEUE_MAX) list.shift();
    if (dev !== '*') {
      const set = online.get(to);
      if (set) set.forEach(c => { if (c.authed && c.dev === dev) pushTo(c, { op: 'msg', from, mid: env.mid, cls: env.cls, iv: env.iv, ct: env.ct, ts: env.ts }); });
    }
  }
  markQ();
  return true;
}
function flushQueue(conn) {
  const byDev = queues[conn.handle]; if (!byDev) return;
  /* claim anything left in the no-active-device fallback bucket the moment any device authenticates */
  if (byDev['*'] && byDev['*'].length) {
    const list = byDev[conn.dev] || (byDev[conn.dev] = []);
    list.push(...byDev['*']); delete byDev['*']; markQ();
  }
  const list = byDev[conn.dev]; if (!list || !list.length) return;
  for (const e of list) pushTo(conn, { op: 'msg', from: e.from, mid: e.mid, cls: e.cls, iv: e.iv, ct: e.ct, ts: e.ts });
}

/* ------------------------------ crypto ------------------------------ */
function verifySig(pubB64u, message, sigB64u) {
  try {
    const raw = Buffer.from(pubB64u, 'base64url'); if (raw.length !== 65 || raw[0] !== 4) return false;
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    return crypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64u, 'base64url'));
  } catch { return false; }
}

/* ------------------------------ WebSocket (RFC 6455) ---------------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class WS {
  constructor(socket, onText, onClose) {
    this.s = socket; this.buf = Buffer.alloc(0); this.frag = null; this.closed = false; this.lastRx = now();
    this.onText = onText; this.onClose = onClose;
    socket.setNoDelay(true); socket.setKeepAlive(true, 15000);
    socket.on('data', d => { this.lastRx = now(); try { this.feed(d); } catch (e) { this.kill(1002); } });
    socket.on('close', () => this.fin());
    socket.on('error', () => this.fin());
  }
  fin() { if (this.fired) return; this.fired = true; this.closed = true; try { this.s.destroy(); } catch {} this.onClose(); }
  kill(code) { if (!this.closed) { try { this.frame(0x8, Buffer.from([code >> 8, code & 255])); } catch {} } this.closed = true; try { this.s.end(); } catch {} setTimeout(() => this.fin(), 200); }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80); let len = b[1] & 0x7f, off = 2;
      if (!masked) return this.kill(1002);
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2)) return this.kill(1009); len = b.readUInt32BE(6); off = 10; }
      if (len > WS_MAX) return this.kill(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4); const data = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) data[i] = b[off + 4 + i] ^ mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op >= 0x8) {
        if (!fin || len > 125) return this.kill(1002);
        if (op === 0x8) { this.kill(1000); return; }
        if (op === 0x9) this.frame(0xA, data);
        continue;
      }
      if (op === 0x1 || op === 0x2) { if (this.frag) return this.kill(1002); if (fin) this.text(data); else this.frag = [data]; }
      else if (op === 0x0) {
        if (!this.frag) return this.kill(1002);
        this.frag.push(data); if (this.frag.reduce((s, x) => s + x.length, 0) > WS_MAX) return this.kill(1009);
        if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this.text(all); }
      } else return this.kill(1002);
    }
  }
  text(data) { this.onText(data.toString('utf8')); }
  frame(op, payload) {
    if (this.closed && op !== 0x8) return;
    const n = payload.length; let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
    if (this.s.writableLength > 16 * 1024 * 1024) { this.kill(1013); return; }
    this.s.write(Buffer.concat([head, payload]));
  }
  send(str) { this.frame(0x1, Buffer.from(str, 'utf8')); }
  ping() { this.frame(0x9, Buffer.alloc(0)); }
}

/* ------------------------------ connections ------------------------- */
const conns = new Set();
function onConnect(socket) {
  const conn = { ws: null, handle: '', dev: '', authed: false, nonce: rid(16), watching: new Set(), bad: 0, opCount: 0, opWin: now(), pending: Promise.resolve() };
  conn.ws = new WS(socket, txt => handle(conn, txt), () => cleanup(conn));
  conns.add(conn);
  pushTo(conn, { op: 'hello', nonce: conn.nonce, t: now() });
}
function cleanup(conn) {
  conns.delete(conn);
  unwatch(conn);
  if (conn.authed) goOffline(conn);
}
function unwatch(conn) { conn.watching.forEach(h => { const s = watchers.get(h); if (s) { s.delete(conn); if (!s.size) watchers.delete(h); } }); conn.watching.clear(); }

function handle(conn, txt) {
  let m; try { m = JSON.parse(txt); } catch { return; }
  if (!m || typeof m !== 'object' || typeof m.op !== 'string') return;
  const t = now(); if (t - conn.opWin > 10000) { conn.opWin = t; conn.opCount = 0; }
  if (m.op !== 'ackmsgs' && ++conn.opCount > 400) return reply(conn, m, { ok: false, err: 'rate' });
  if (m.op === 'pong') return;
  if (!conn.authed && m.op !== 'auth') return reply(conn, m, { ok: false, err: 'auth' });
  const fn = OPS[m.op]; if (!fn) return reply(conn, m, { ok: false, err: 'op' });
  try { fn(conn, m); } catch (e) { log('op error', m.op, e.message); reply(conn, m, { ok: false, err: 'server' }); }
}
function reply(conn, m, data) { if (m && m.q != null) pushTo(conn, Object.assign({ re: m.q }, data)); }

const OPS = {
  auth(conn, m) {
    if (conn.authed) return reply(conn, m, { ok: false, err: 'already' });
    const h = String(m.handle || '').toLowerCase(), dev = m.dev;
    if (!isHandle(h) || !isDev(dev) || !b64uOk(m.pub, 120) || !b64uOk(m.sig, 200)) return reply(conn, m, { ok: false, err: 'bad' });
    if (!verifySig(m.pub, `hushchats-auth|${conn.nonce}|${h}|${dev}`, m.sig)) { if (++conn.bad > 4) conn.ws.kill(1008); return reply(conn, m, { ok: false, err: 'badsig' }); }
    let u = users[h];
    if (u && u.pub !== m.pub) return reply(conn, m, { ok: false, err: 'taken' });
    if (!u) {
      if (handleTaken(h)) return reply(conn, m, { ok: false, err: 'taken' });
      u = users[h] = { pub: m.pub, name: '', created: now(), lastSeen: 0, hide: false, devs: {} };
      log('new account', h);
    }
    if (typeof m.name === 'string') u.name = m.name.slice(0, 40);
    u.devs = u.devs || {}; u.devs[dev] = now(); markU();
    /* a second socket from the same device replaces the first (stale connection) */
    const set = online.get(h); if (set) set.forEach(c => { if (c !== conn && c.dev === dev) { c.ws.kill(1000); } });
    conn.handle = h; conn.dev = dev; conn.authed = true;
    const token = rid(24); tokens.set(token, { handle: h, exp: now() + TOKEN_TTL }); conn.token = token;
    goOnline(conn);
    reply(conn, m, { ok: true, token, hide: !!u.hide });
    flushQueue(conn);
  },
  ackmsgs(conn, m) {
    if (!Array.isArray(m.mids)) return;
    const list = (queues[conn.handle] || {})[conn.dev]; if (!list) return;
    const set = new Set(m.mids.slice(0, 500).map(String));
    const keep = list.filter(e => !set.has(e.mid));
    if (keep.length !== list.length) { queues[conn.handle][conn.dev] = keep; markQ(); }
  },
  send(conn, m) {
    const from = conn.handle; let to = String(m.to || '').toLowerCase();
    if (!isHandle(to) || !isMid(m.mid) || !b64uOk(m.iv, 40) || !b64uOk(m.ct, ENV_MAX)) return reply(conn, m, { ok: false, err: 'bad' });
    to = resolveAlias(to);
    if (!users[to]) return reply(conn, m, { ok: false, err: 'nouser' });
    const cls = ['msg', 'rcpt', 'profile', 'sync', 'ctl'].includes(m.cls) ? m.cls : 'msg';
    const key = from + '>' + to + ':' + m.mid;
    if (recent.has(key)) return reply(conn, m, { ok: true, ts: recent.get(key), dup: true });
    const ts = now(); recent.set(key, ts);
    enqueue(from, to, { mid: m.mid, from, cls, iv: m.iv, ct: m.ct, ts }, conn.dev);
    reply(conn, m, { ok: true, ts });
  },
  sig(conn, m) {
    const from = conn.handle; let to = String(m.to || '').toLowerCase();
    if (!isHandle(to) || !b64uOk(m.iv, 40) || !b64uOk(m.ct, SIG_MAX)) return reply(conn, m, { ok: false, err: 'bad' });
    to = resolveAlias(to);
    const set = online.get(to); const devs = new Set();
    if (set) set.forEach(c => {
      if (!c.authed || c === conn) return;
      if (m.dev && c.dev !== m.dev) return;
      pushTo(c, { op: 'sig', from, dev: conn.dev, iv: m.iv, ct: m.ct }); devs.add(c.dev);
    });
    reply(conn, m, { ok: true, devs: [...devs] });
  },
  watch(conn, m) {
    const ids = (Array.isArray(m.ids) ? m.ids : []).slice(0, 5000).map(x => String(x).toLowerCase()).filter(isHandle);
    unwatch(conn);
    const out = {};
    for (const id of ids) {
      const rid2 = resolveAlias(id); if (!users[rid2]) continue;   // still show presence for a friend under their old ID during the alias window
      let s = watchers.get(rid2); if (!s) watchers.set(rid2, s = new Set()); s.add(conn); conn.watching.add(rid2);
      out[id] = presenceOf(rid2);
    }
    reply(conn, m, { ok: true, presence: out });
  },
  lookup(conn, m) {
    let id = String(m.id || '').toLowerCase(); if (!isHandle(id)) return reply(conn, m, { ok: true, exists: false });
    id = resolveAlias(id);   // an ID someone renamed away from still resolves to their current one for 30 days
    const u = users[id]; if (!u) return reply(conn, m, { ok: true, exists: false });
    reply(conn, m, { ok: true, exists: true, pub: u.pub, name: u.name || '', id });
  },
  profile(conn, m) { const u = users[conn.handle]; if (u && typeof m.name === 'string') { u.name = m.name.slice(0, 40); markU(); } reply(conn, m, { ok: true }); },
  privacy(conn, m) {
    const u = users[conn.handle]; if (!u) return;
    const hide = !!m.hide; if (u.hide !== hide) { u.hide = hide; markU(); broadcastPresence(conn.handle); }
    reply(conn, m, { ok: true });
  },
  rename(conn, m) {
    const old = conn.handle, nid = String(m.id || '').toLowerCase();
    if (!isHandle(nid)) return reply(conn, m, { ok: false, err: 'bad' });
    if (nid === old) return reply(conn, m, { ok: true });
    if (handleTaken(nid)) return reply(conn, m, { ok: false, err: 'taken' });
    const u = users[old]; users[nid] = u; delete users[old];
    if (queues[old]) { queues[nid] = queues[old]; delete queues[old]; markQ(); }
    aliases[old] = { to: nid, exp: now() + ALIAS_TTL };
    const set = online.get(old); online.delete(old); online.set(nid, set);
    set.forEach(c => { c.handle = nid; if (c !== conn) pushTo(c, { op: 'renamed', id: nid }); });
    tokens.forEach(v => { if (v.handle === old) v.handle = nid; });
    markU();
    /* people watching the old ID see it go away; they switch to the new one when they read my "rename" message */
    const ws = watchers.get(old); if (ws) ws.forEach(c => pushTo(c, { op: 'presence', id: old, on: false, ls: now() }));
    log('rename', old, '->', nid);
    reply(conn, m, { ok: true });
  },
  delete(conn, m) {
    const h = conn.handle; delete users[h]; delete queues[h]; markU(); markQ();
    const set = online.get(h); online.delete(h);
    reply(conn, m, { ok: true });
    if (set) set.forEach(c => { c.authed = false; setTimeout(() => c.ws.kill(1000), 100); });
    const ws = watchers.get(h); if (ws) ws.forEach(c => pushTo(c, { op: 'presence', id: h, on: false, ls: now() }));
    log('deleted account', h);
  }
};

/* ------------------------------ HTTP -------------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.apk': 'application/vnd.android.package-archive', '.txt': 'text/plain; charset=utf-8' };
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'x-token, content-type, range');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'content-length, content-range, content-disposition');
}
function json(res, code, obj) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); res.end(b); }
function sendFile(req, res, file, headers) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    let start = 0, end = st.size - 1, code = 200; const h = Object.assign({ 'Accept-Ranges': 'bytes' }, headers);
    const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (rg && (rg[1] || rg[2])) {
      if (rg[1]) { start = parseInt(rg[1], 10); if (rg[2]) end = Math.min(end, parseInt(rg[2], 10)); } else { start = Math.max(0, st.size - parseInt(rg[2], 10)); }
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      code = 206; h['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    h['Content-Length'] = end - start + 1;
    res.writeHead(code, h);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}
function readBody(req, res, limit, cb) {
  let n = 0; const chunks = []; let dead = false;
  req.on('data', c => { if (dead) return; n += c.length; if (n > limit) { dead = true; json(res, 413, { ok: false, err: 'toobig' }); req.destroy(); return; } chunks.push(c); });
  req.on('end', () => { if (!dead) cb(Buffer.concat(chunks)); });
  req.on('error', () => {});
}
function authToken(req) { const t = tokens.get(String(req.headers['x-token'] || '')); return t && t.exp > now() ? t : null; }

const server = http.createServer((req, res) => {
  let url; try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (p.startsWith('/api/')) cors(res);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  let m;
  if ((m = /^\/api\/handle\/([a-z0-9_]{1,20})$/.exec(p))) { const h = m[1]; return json(res, 200, { ok: true, available: isHandle(h) && !handleTaken(h) }); }
  if (p === '/api/ice') {
    /* time-limited TURN credential (1 hour) so a leaked value stops working soon after */
    let servers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
    let relay = false;
    if (TURN_SECRET && TURN_URLS.length) {
      const exp = Math.floor(now() / 1000) + 3600, user = `${exp}:hc`;
      const pass = crypto.createHmac('sha1', TURN_SECRET).update(user).digest('base64');
      servers = servers.concat(TURN_URLS.map(u => ({ urls: u, username: user, credential: pass })));
      relay = true;
    } else if (TURN_URLS.length && TURN_USER && TURN_PASS) {
      servers = servers.concat(TURN_URLS.map(u => ({ urls: u, username: TURN_USER, credential: TURN_PASS })));
      relay = true;
    }
    return json(res, 200, { ok: true, servers, relay });
  }
  if (p === '/api/apk') {
    return fs.stat(path.join(PUBLIC_DIR, 'Hushchats.apk'), (e, st) => json(res, 200, { exists: !e && st.isFile(), name: 'Hushchats.apk', size: !e && st.isFile() ? st.size : 0 }));
  }
  if (p === '/api/media' && req.method === 'POST') {
    const t = authToken(req); if (!t) return json(res, 401, { ok: false, err: 'auth' });
    return readBody(req, res, MEDIA_MAX, body => {
      if (!body.length) return json(res, 400, { ok: false, err: 'empty' });
      const id = rid(16);
      fs.writeFile(path.join(MEDIA_DIR, id), body, err => err ? json(res, 500, { ok: false, err: 'disk' }) : json(res, 200, { ok: true, id, size: body.length }));
    });
  }
  if ((m = /^\/api\/media\/([a-f0-9]{32})$/.exec(p))) {
    const file = path.join(MEDIA_DIR, m[1]);
    if (req.method === 'DELETE') { if (!authToken(req)) return json(res, 401, { ok: false, err: 'auth' }); return fs.unlink(file, () => json(res, 200, { ok: true })); }
    if (req.method === 'GET' || req.method === 'HEAD') return sendFile(req, res, file, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' });
  }
  if (p.startsWith('/api/')) return json(res, 404, { ok: false, err: 'nf' });

  /* static files */
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel = p === '/' ? '/index.html' : p;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (ext === '.apk') { headers['Content-Disposition'] = 'attachment; filename="Hushchats.apk"'; headers['Cache-Control'] = 'no-cache'; }
  else if (ext === '.html' || rel === '/sw.js' || ext === '.webmanifest') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
  else headers['Cache-Control'] = 'public, max-age=3600';
  if (rel === '/sw.js') headers['Service-Worker-Allowed'] = '/';
  sendFile(req, res, file, headers);
});

server.on('upgrade', (req, socket) => {
  if (!/^\/ws\/?(\?.*)?$/.test(req.url) || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  onConnect(socket);
});

/* ------------------------------ housekeeping ------------------------ */
setInterval(() => {
  const t = now();
  conns.forEach(c => {
    if (!c.ws || c.ws.closed) return;
    if (t - c.ws.lastRx > PING_MS * 2.5) return c.ws.kill(1001);
    c.ws.ping(); pushTo(c, { op: 'hb', t });
  });
}, PING_MS).unref();
setInterval(() => {
  const t = now();
  recent.forEach((ts, k) => { if (t - ts > 2 * 3600 * 1000) recent.delete(k); });
  tokens.forEach((v, k) => { if (v.exp < t) tokens.delete(k); });
  for (const [k, a] of Object.entries(aliases)) if (a.exp < t) { delete aliases[k]; markU(); }
  for (const [h, byDev] of Object.entries(queues)) {
    for (const dev of Object.keys(byDev)) {
      const keep = byDev[dev].filter(e => t - e.ts < QUEUE_TTL);
      if (keep.length !== byDev[dev].length) { byDev[dev] = keep; markQ(); }
      if (!keep.length && !(users[h] && users[h].devs && users[h].devs[dev])) { delete byDev[dev]; markQ(); }
    }
    if (!users[h]) { delete queues[h]; markQ(); }
  }
  fs.readdir(MEDIA_DIR, (err, files) => { if (err) return; files.forEach(f => { const fp = path.join(MEDIA_DIR, f); fs.stat(fp, (e, st) => { if (!e && t - st.mtimeMs > MEDIA_TTL) fs.unlink(fp, () => {}); }); }); });
}, 10 * 60 * 1000).unref();

function shutdown() { log('shutting down'); flushSync(); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
/* Last line of defense: this server holds every user's live WebSocket in one process, so any single
   uncaught error — a bad request, an edge case nobody hit in testing — must never be allowed to kill
   the process and disconnect everyone at once. Log it and keep running instead of crash-looping. */
process.on('uncaughtException', e => log('uncaughtException', e && e.stack || e));
process.on('unhandledRejection', e => log('unhandledRejection', e && e.stack || e));

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => log(`Hushchats server on :${PORT}  data=${DATA_DIR}  users=${Object.keys(users).length}`));
}
module.exports = { server, flushSync };
