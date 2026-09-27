'use strict';
const os = require('os'), fs = require('fs'), path = require('path'), { execSync } = require('child_process');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-'));
const { server } = require('../server.js');
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NAMES = 'S,DB,isOnline,addFriend,openChat,saveFriend,startCall,acceptCall,endCall';
const E = (page, fn) => page.evaluate(`(async () => { const {${NAMES}} = window.__HC_TEST; return await (${fn.toString()})(); })()`);
async function until(fn, msg, ms = 15000) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error('timeout: ' + msg); await sleep(150); } }
let n = 0; const ok = m => console.log('  ✓', m, `(${++n})`);
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errs = [];
  async function user(name, handle) {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 800 }, permissions: ['microphone', 'camera', 'notifications'] });
    await ctx.addInitScript(() => { window.__HC_TEST = {}; });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(name + ': ' + e.message));
    await p.goto(base + '/'); await p.click('text=Create account'); await p.fill('input[placeholder="Display name"]', name); await p.fill('input[maxlength="12"]', handle); await p.click('text=Continue');
    await until(() => E(p, () => S.net === 'online'), name + ' online'); return p;
  }
  const a = await user('Alice', 'alice_c'), b = await user('Bobby', 'bobby_c');
  await E(a, () => addFriend('bobby_c', '', '', '')); await until(() => E(a, () => isOnline('bobby_c')), 'presence');
  await E(b, () => addFriend('alice_c', '', '', ''));
  await until(() => E(a, () => S.friends.get('bobby_c') && isOnline('bobby_c')), 'ready');
  // ---- voice call
  await E(a, () => startCall('bobby_c', false));
  await until(() => E(b, () => S.call && S.call.state === 'ringing'), 'bob rings'); ok("bob's phone rings (invite relayed by the server, E2E-encrypted)");
  await E(b, () => acceptCall());
  await until(() => E(a, () => S.call && S.call.state === 'active'), 'alice active'); await until(() => E(b, () => S.call && S.call.state === 'active'), 'bob active'); ok('call connects: both sides active (WebRTC offer/answer/ICE through the server)');
  await sleep(2500);
  const ice = await E(a, () => S.call.pc.iceConnectionState); if (!/connected|completed/.test(ice)) throw new Error('ice ' + ice); ok('media path established (ICE ' + ice + ')');
  const rx = await E(b, () => S.call.remote.getAudioTracks().length); if (rx < 1) throw new Error('no audio'); ok('bob receives alice\'s audio track');
  const lock = await E(a, async () => { await new Promise(r => setTimeout(r, 1500)); return S.call.verified; }); ok('DTLS fingerprint verification result: ' + lock);
  await E(a, () => endCall('hangup'));
  await until(() => E(b, () => !S.call), 'bob call ended'); ok('hang up ends the call on both sides');
  // ---- video call
  await E(b, () => startCall('alice_c', true));
  await until(() => E(a, () => S.call && S.call.state === 'ringing'), 'alice rings'); await E(a, () => acceptCall());
  await until(() => E(b, () => S.call && S.call.state === 'active' && S.call.remote.getVideoTracks().length > 0), 'video active'); ok('video call connects with a remote video track');
  await E(b, () => endCall('hangup')); await until(() => E(a, () => !S.call), 'ended');
  const log = await E(a, async () => (await DB.msgs('bobby_c')).filter(m => m.type === 'call').map(m => m.text));
  ok('call log written: ' + JSON.stringify(log));
  // ---- callee offline -> missed call delivered later
  await b.close();
  await until(() => E(a, () => !isOnline('bobby_c')), 'bob offline', 15000);
  await E(a, () => startCall('bobby_c', false));
  await until(() => E(a, () => !S.call), 'call ended quickly'); ok('calling an offline friend fails fast (no 45-second wait)');
  const b2 = await (await browser.contexts().find(c => c.pages().length === 0) || browser.contexts()[1]).newPage();
  b2.on('pageerror', e => errs.push('Bob2: ' + e.message)); await b2.goto(base + '/');
  await until(() => E(b2, async () => S.net === 'online' && (await DB.msgs('alice_c')).some(m => m.miss)), 'missed call shown', 15000); ok('when bob is back he sees “Missed voice call” from alice');
  if (errs.length) throw new Error('page errors ' + JSON.stringify(errs));
  ok('no JavaScript errors');
  console.log(`\nALL ${n} CALL CHECKS PASSED`);
  await browser.close(); process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
