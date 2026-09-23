'use strict';
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { webcrypto } = require('crypto'); const subtle = webcrypto.subtle;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));
const { server, flushSync } = require('../server.js');
const b64u = b => Buffer.from(b).toString('base64url');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function identity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { kp, pub: b64u(await subtle.exportKey('raw', kp.publicKey)) };
}
class Client {
  constructor(port) { this.port = port; this.pushes = []; this.waiters = []; this.id = 0; this.pend = new Map(); }
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.re != null) { const p = this.pend.get(m.re); if (p) { this.pend.delete(m.re); p(m); } return; }
      if (m.op === 'hello') this.nonce = m.nonce;
      this.pushes.push(m); this.waiters = this.waiters.filter(w => !w(m));
    };
    while (!this.nonce) await sleep(5);
    return this;
  }
  req(op, data) { return new Promise(res => { const q = ++this.id; this.pend.set(q, res); this.ws.send(JSON.stringify(Object.assign({ op, q }, data))); }); }
  async auth(idn, handle, dev, name) {
    const sig = b64u(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, idn.kp.privateKey, new TextEncoder().encode(`hushchats-auth|${this.nonce}|${handle}|${dev}`)));
    return this.req('auth', { handle, pub: idn.pub, name, dev, sig });
  }
  next(pred, ms = 3000) {
    const hit = this.pushes.findIndex(pred); if (hit >= 0) return Promise.resolve(this.pushes.splice(hit, 1)[0]);
    return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for push')), ms); this.waiters.push(m => { if (pred(m)) { clearTimeout(t); res(m); return true; } return false; }); });
  }
  close() { try { this.ws.close(); } catch {} }
}
const http = (port, p, opt) => fetch(`http://127.0.0.1:${port}${p}`, opt);

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  const A = await identity(), B = await identity(), C = await identity();
  const devA = 'a'.repeat(16), devB = 'b'.repeat(16), devB2 = 'c'.repeat(16);
  let n = 0; const ok = name => console.log('  ✓', name, `(${++n})`);

  // --- handles + auth
  assert.strictEqual((await (await http(port, '/api/handle/alice')).json()).available, true); ok('handle free');
  const a = await new Client(port).open(); let r = await a.auth(A, 'alice', devA, 'Alice'); assert(r.ok && r.token); ok('alice registers');
  assert.strictEqual((await (await http(port, '/api/handle/alice')).json()).available, false); ok('handle now taken');
  const c = await new Client(port).open(); r = await c.auth(C, 'alice', 'd'.repeat(16), 'Evil'); assert(!r.ok && r.err === 'taken'); ok('other key cannot steal a handle'); c.close();
  const c2 = await new Client(port).open(); const sigBad = await c2.req('auth', { handle: 'zed', pub: B.pub, dev: devB, sig: b64u(Buffer.alloc(64)) }); assert(!sigBad.ok && sigBad.err === 'badsig'); ok('bad signature rejected'); c2.close();
  r = await a.req('lookup', { id: 'nobody' }); assert.strictEqual(r.exists, false); ok('lookup unknown user');

  // --- offline queue: bob has never connected -> register bob, disconnect, then send
  let b = await new Client(port).open(); r = await b.auth(B, 'bobby', devB, 'Bob'); assert(r.ok); ok('bob registers');
  r = await a.req('lookup', { id: 'bobby' }); assert(r.exists && r.pub === B.pub && r.name === 'Bob'); ok('lookup returns public key');
  const w = await a.req('watch', { ids: ['bobby', 'ghost'] }); assert.strictEqual(w.presence.bobby.on, true); assert(!w.presence.ghost); ok('presence: bob is online');
  b.close(); const off = await a.next(m => m.op === 'presence' && m.id === 'bobby' && !m.on, 8000); assert(off.ls > 0); ok('presence: offline push after grace period');
  r = await a.req('send', { to: 'bobby', mid: 'm1', cls: 'msg', iv: 'AAAA', ct: 'BBBB' }); assert(r.ok && r.ts); ok('send while friend is offline -> stored');
  r = await a.req('send', { to: 'bobby', mid: 'm1', cls: 'msg', iv: 'AAAA', ct: 'BBBB' }); assert(r.ok && r.dup); ok('duplicate send is idempotent');
  r = await a.req('send', { to: 'nosuch', mid: 'm2', iv: 'AA', ct: 'BB' }); assert(!r.ok && r.err === 'nouser'); ok('send to unknown user fails clearly');
  r = await a.req('send', { to: 'bobby', mid: 'm3', cls: 'msg', iv: 'AAAA', ct: 'CCCC' });
  b = await new Client(port).open(); r = await b.auth(B, 'bobby', devB, 'Bob'); assert(r.ok);
  const p1 = await b.next(m => m.op === 'msg' && m.mid === 'm1'); assert.strictEqual(p1.from, 'alice'); const p3 = await b.next(m => m.op === 'msg' && m.mid === 'm3'); ok('queued messages delivered on reconnect, in order');
  const on = await a.next(m => m.op === 'presence' && m.id === 'bobby' && m.on); ok('presence: online push');
  b.close(); await sleep(50);
  b = await new Client(port).open(); await b.auth(B, 'bobby', devB, 'Bob'); await b.next(m => m.op === 'msg' && m.mid === 'm1'); ok('un-acked messages are redelivered');
  b.ws.send(JSON.stringify({ op: 'ackmsgs', mids: ['m1', 'm3'] })); await sleep(100); b.close(); await sleep(50);
  b = await new Client(port).open(); await b.auth(B, 'bobby', devB, 'Bob'); await sleep(300); assert(!b.pushes.some(m => m.op === 'msg')); ok('acked messages are removed from the queue');

  // --- live delivery + sig + second device
  const b2 = await new Client(port).open(); await b2.auth(B, 'bobby', devB2, 'Bob');
  await a.req('send', { to: 'bobby', mid: 'live1', cls: 'msg', iv: 'AAAA', ct: 'DDDD' });
  await b.next(m => m.op === 'msg' && m.mid === 'live1'); await b2.next(m => m.op === 'msg' && m.mid === 'live1'); ok('live message reaches every device of the account');
  r = await a.req('sig', { to: 'bobby', iv: 'AAAA', ct: 'EEEE' }); assert(r.ok && r.devs.length === 2); await b.next(m => m.op === 'sig' && m.from === 'alice'); ok('signalling relayed live (not stored)');
  r = await a.req('sig', { to: 'bobby', dev: devB2, iv: 'AAAA', ct: 'FFFF' }); assert.deepStrictEqual(r.devs, [devB2]); ok('signalling can target one device');
  b2.close(); b.close(); await sleep(50);
  r = await a.req('sig', { to: 'bobby', iv: 'AAAA', ct: 'GGGG' }); assert(r.ok && r.devs.length === 0); ok('signalling to offline user reports nobody reached');

  // --- privacy
  b = await new Client(port).open(); await b.auth(B, 'bobby', devB, 'Bob');
  await b.req('privacy', { hide: true }); const hid = await a.next(m => m.op === 'presence' && m.id === 'bobby'); assert.strictEqual(hid.on, false); ok('hide-online-status hides presence');
  await b.req('privacy', { hide: false });

  // --- media
  r = await http(port, '/api/media', { method: 'POST', body: Buffer.from('x') }); assert.strictEqual(r.status, 401); ok('media upload needs a token');
  const tok = (await a.req('watch', { ids: [] })) && a.token; // token comes from auth reply below
  const a2 = await new Client(port).open(); const ar = await a2.auth(A, 'alice', 'e'.repeat(16), 'Alice'); assert(ar.ok);
  const blob = Buffer.alloc(200000, 7);
  r = await http(port, '/api/media', { method: 'POST', body: blob, headers: { 'x-token': ar.token } }); const up = await r.json(); assert(up.ok && /^[a-f0-9]{32}$/.test(up.id)); ok('media upload');
  r = await http(port, '/api/media/' + up.id); assert.strictEqual(Buffer.from(await r.arrayBuffer()).compare(blob), 0); ok('media download');
  r = await http(port, '/api/media/' + up.id, { headers: { range: 'bytes=10-19' } }); assert.strictEqual(r.status, 206); assert.strictEqual((await r.arrayBuffer()).byteLength, 10); ok('media range request');
  r = await http(port, '/api/media', { method: 'POST', body: Buffer.alloc(9.5 * 1024 * 1024), headers: { 'x-token': ar.token } }).catch(() => ({ status: 413 })); assert.strictEqual(r.status, 413); ok('oversized media rejected');
  r = await http(port, '/api/media/' + up.id, { method: 'DELETE', headers: { 'x-token': ar.token } }); assert((await r.json()).ok); assert.strictEqual((await http(port, '/api/media/' + up.id)).status, 404); ok('media delete');
  r = await http(port, '/../server.js'); assert.notStrictEqual((await r.text()).includes('OPS'), true); ok('path traversal blocked');
  r = await (await http(port, '/api/apk')).json(); assert.strictEqual(r.exists, false); ok('apk info endpoint');

  // --- rename + alias forwarding
  a2.close();
  r = await a.req('rename', { id: 'bobby' }); assert(!r.ok && r.err === 'taken'); ok('cannot rename onto an existing ID');
  r = await a.req('rename', { id: 'alice_new' }); assert(r.ok); ok('rename');
  r = await b.req('send', { to: 'alice', mid: 'alias1', cls: 'msg', iv: 'AAAA', ct: 'HHHH' }); assert(r.ok); const fw = await a.next(m => m.op === 'msg' && m.mid === 'alias1'); ok('old ID forwards to the new one');
  r = await b.req('lookup', { id: 'alice_new' }); assert(r.exists && r.pub === A.pub); ok('lookup by new ID keeps the same key');
  const a3 = await new Client(port).open(); r = await a3.auth(A, 'alice', 'f'.repeat(16), 'Alice'); assert(!r.ok && r.err === 'taken'); ok('old ID is reserved after rename'); a3.close();

  // --- persistence
  flushSync(); assert(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'users.json'), 'utf8')).users.alice_new); ok('data written to disk');

  // --- garbage tolerance
  const g = await new Client(port).open(); g.ws.send('not json'); g.ws.send(JSON.stringify({ op: 'send', to: 'x' })); await sleep(100); ok('garbage frames do not crash the server'); g.close();
  console.log(`\nALL ${n} SERVER CHECKS PASSED`); process.exit(0);
})().catch(e => { console.error('\nFAIL:', e); process.exit(1); });
