'use strict';
const os = require('os'), fs = require('fs'), path = require('path'), { execSync } = require('child_process');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hcttl-'));
const { server } = require('../server.js');
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NAMES = 'S,DB,addFriend,saveFriend,openChat';
const E = (page, fn) => page.evaluate(`(async()=>{const {${NAMES}}=window.__HC_TEST; return await (${fn.toString()})();})()`);
let n = 0; const ok = m => console.log('  ✓', m, `(${++n})`);
async function until(fn, msg, ms = 10000) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error('timeout: ' + msg); await sleep(120); } }
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  async function user(name, handle) {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 800 } });
    await ctx.addInitScript(() => { window.__HC_TEST = {}; });
    const p = await ctx.newPage();
    await p.goto(base + '/'); await p.click('text=Create account'); await p.fill('input[placeholder="Display name"]', name); await p.fill('input[maxlength="12"]', handle); await p.click('text=Continue');
    await until(() => E(p, () => S.net === 'online'), name + ' online'); return p;
  }
  const a = await user('Alice', 'alice_x'), b = await user('Bobby', 'bobby_x');
  await E(a, () => addFriend('bobby_x', '', '', ''));
  await until(() => E(a, () => S.friends.get('bobby_x')), 'friend added');
  await E(a, async () => { S.settings.ttl = 1; try { localStorage.setItem('hl.settings', JSON.stringify(S.settings)); } catch {} });   // 1 second, for a fast test
  await a.fill('#txt', 'this message will self-destruct'); await a.click('#btnSend');
  await until(() => E(a, async () => (await DB.msgs('bobby_x')).some(m => m.ttl === 1)), 'ttl attached'); ok('message sent with a 1-second TTL attached');
  await E(b, async () => { const f = S.friends.get('alice_x'); if (f) { f.status = 'friend'; await saveFriend(f); } await openChat('alice_x'); });
  await until(() => E(b, async () => (await DB.msgs('alice_x')).some(m => m.ttl === 1)), 'bob got ttl'); ok('bob\'s copy also carries the TTL (peer was told to expire it too)');
  await sleep(35000);
  const aGone = await E(a, async () => (await DB.msgs('bobby_x')).length === 0 || !(await DB.msgs('bobby_x')).some(m => m.text === 'this message will self-destruct'));
  const bGone = await E(b, async () => !(await DB.msgs('alice_x')).some(m => m.text === 'this message will self-destruct'));
  if (!aGone || !bGone) throw new Error('message did not disappear: sender=' + aGone + ' receiver=' + bGone);
  ok('message disappeared from BOTH sides after it expired (sweeper runs every 30s)');
  console.log(`\nALL ${n} DISAPPEARING-MESSAGE CHECKS PASSED`);
  await browser.close(); process.exit(0);
})().catch(e => { console.error('\nFAIL:', e.message); process.exit(1); });
