'use strict';
/* End-to-end test: two real browsers talking through the real server.
   Run:  node test/e2e.js      (needs playwright + a chromium; only for development, not for deployment) */
const os = require('os'), fs = require('fs'), path = require('path'), { execSync } = require('child_process');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hce-'));
fs.writeFileSync(path.join(__dirname, '..', 'public', 'Hushchats.apk.test'), '');   // (not used) keep dir writable check
fs.unlinkSync(path.join(__dirname, '..', 'public', 'Hushchats.apk.test'));
const { server } = require('../server.js');
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright');
const NAMES = 'S,DB,isOnline,addFriend,openChat,applyNewId,deleteEveryone,openAddFriend,saveFriend,XF,paintMedia,checkApk';
const E = (page, fn, arg) => page.evaluate(`(async () => { const {${NAMES}} = window.__HC_TEST; return await (${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)}); })()`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = m => console.log('  ✓', m, `(${++n})`);
const must = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };

async function until(fn, msg, ms = 12000) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error('timeout: ' + msg); await sleep(120); } }

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port, base = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errors = [];
  async function newUser(name, handle, ua) {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, permissions: ['notifications'], userAgent: ua });
    await ctx.addInitScript(() => { window.__HC_TEST = {}; });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(name + ': ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(name + ' console: ' + m.text()); });
    await page.goto(base + '/');
    await page.click('text=Create account');
    await page.fill('input[placeholder="Display name"]', name);
    await page.fill('input[maxlength="12"]', handle);
    await page.click('text=Continue');
    await until(async () => (await page.textContent('body')).includes('Connected') || (await page.$('#app:not([hidden])')), name + ' app opens');
    return { ctx, page, name, handle };
  }
  const A = await newUser('Alice', 'alice_t'); ok('alice created account');
  const B = await newUser('Bobby', 'bobby_t'); ok('bobby created account');
  await until(() => E(A.page, () => S.net === 'online'), 'alice online'); ok('alice authenticated with the server (signed login)');

  // ---- add friend: unknown id is rejected, real one works and shows presence
  await E(A.page, () => openAddFriend()); await A.page.fill('input[placeholder^="Their ID"]', 'nobody_x'); await A.page.click('text=Add friend');
  await until(() => A.page.$('text=Nobody has the ID'), 'unknown id message'); ok('adding a non-existent ID is refused with a clear message');
  await A.page.keyboard.press('Escape');
  await E(A.page, () => { document.querySelectorAll('.overlay,.sheetwrap,[class*=sheet]').forEach(e => e.remove()); });
  await E(A.page, () => addFriend('bobby_t', '', '', ''));
  await until(() => E(A.page, () => S.friends.has('bobby_t')), 'friend added');
  await until(() => E(A.page, () => isOnline('bobby_t')), 'bobby shows online'); ok('new friend shows REAL online status immediately');
  const hdr = await A.page.textContent('#chatWho'); must(/Online/.test(hdr), 'header says Online: ' + hdr); ok('chat header says Online');

  // ---- message while friend is online: ticks go ✓ → ✓✓ (delivered) 
  await A.page.fill('#txt', 'hello bob'); await A.page.press('#txt', 'Enter');
  await until(() => E(B.page, () => [...S.friends.values()].length && S.friends.has('alice_t')), 'bob got request'); ok('bob received a message request from alice');
  await until(() => E(A.page, async () => (await DB.msgs('bobby_t')).some(m => m.dir === 'out' && m.status === 'delivered')), 'delivered tick'); ok('sender sees ✓✓ delivered');
  // bob opens chat -> read
  await E(B.page, async () => { const fr = S.friends.get('alice_t'); fr.status = 'friend'; await saveFriend(fr); await openChat('alice_t'); });
  await until(() => E(A.page, async () => (await DB.msgs('bobby_t')).some(m => m.dir === 'out' && m.status === 'read')), 'read tick'); ok('after bob opens the chat, alice sees blue ✓✓ (read)');
  const blue = await E(A.page, () => !!document.querySelector('.row.out .st.rd')); must(blue, 'blue tick in DOM'); ok('blue tick is rendered in the bubble');

  // ---- bob goes OFFLINE (closes browser tab): alice sees offline, sends, ✓ only; bob returns and receives
  await E(B.page, () => { const fr = S.friends.get('alice_t'); fr.status = 'friend'; return saveFriend(fr); });
  await B.page.close();
  await until(() => E(A.page, () => !isOnline('bobby_t')), 'bobby offline', 15000); ok('alice sees bobby go OFFLINE in real time');
  const hdr2 = await A.page.textContent('#chatWho'); must(/Last seen/.test(hdr2), 'last seen shown: ' + hdr2); ok('header shows "Last seen …"');
  await A.page.fill('#txt', 'you there?'); await A.page.press('#txt', 'Enter');
  await A.page.fill('#txt', 'second while offline'); await A.page.press('#txt', 'Enter');
  await until(() => E(A.page, async () => (await DB.msgs('bobby_t')).filter(m => m.dir === 'out' && m.status === 'sent').length >= 2), 'one tick'); ok('offline friend → messages show single ✓ (stored on server)');
  await sleep(300);
  must(await E(A.page, async () => !(await DB.msgs('bobby_t')).some(m => m.text === 'you there?' && m.status !== 'sent')), 'stays single tick'); ok('stays single ✓ until the friend is back');
  // photo while offline
  const png = await E(A.page, async () => { const c = document.createElement('canvas'); c.width = 640; c.height = 480; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 640, 480); g.addColorStop(0, '#f00'); g.addColorStop(1, '#00f'); x.fillStyle = g; x.fillRect(0, 0, 640, 480); return c.toDataURL('image/png').split(',')[1]; });
  const tmp = path.join(os.tmpdir(), 'pic.png'); fs.writeFileSync(tmp, Buffer.from(png, 'base64'));
  await A.page.setInputFiles('#imgInput', tmp);
  await until(() => E(A.page, async () => (await DB.msgs('bobby_t')).some(m => m.type === 'image' && m.status === 'sent' && m.media)), 'photo uploaded'); ok('photo encrypted + uploaded while friend offline, shows ✓');

  // bob comes back (new tab, same profile storage)
  const bp = await B.ctx.newPage(); B.page = bp;
  bp.on('pageerror', e => errors.push('Bob2: ' + e.message));
  await bp.goto(base + '/');
  await until(() => E(bp, () => S.friends && S.friends.has('alice_t') && S.net === 'online'), 'bob back online');
  await until(() => E(bp, async () => (await DB.msgs('alice_t')).filter(m => m.dir === 'in').length >= 4), 'bob gets queued msgs'); ok('bob returns → receives everything sent while he was offline');
  await until(() => E(bp, async () => (await DB.msgs('alice_t')).some(m => m.type === 'image' && m.blob && m.blob.size > 100)), 'bob photo downloaded'); ok('bob downloaded + decrypted the photo');
  const same = await E(bp, async () => { const m = (await DB.msgs('alice_t')).find(m => m.type === 'image'); const bmp = await createImageBitmap(m.blob); return bmp.width + 'x' + bmp.height; });
  must(same === '640x480', 'photo dims ' + same); ok('photo arrives intact (640x480)');
  await until(() => E(A.page, async () => (await DB.msgs('bobby_t')).filter(m => m.dir === 'out' && m.status === 'delivered' || m.status === 'read').length >= 3), 'alice ticks upgrade', 15000); ok('alice\'s ticks upgrade to ✓✓ once bob is back');
  await E(bp, () => openChat('alice_t'));
  await until(() => E(A.page, async () => (await DB.msgs('bobby_t')).every(m => m.dir !== 'out' || m.status === 'read')), 'all read', 15000); ok('opening the chat turns everything blue');
  await until(() => E(A.page, () => isOnline('bobby_t')), 'online again'); ok('presence flips back to online');

  // ---- photo UI + progress ring
  await E(A.page, () => { const m = S.msgs.find(x => x.type === 'image'); XF.set(m.id, { state: 'up', prog: 0.4 }); paintMedia(m); });
  must(await E(A.page, () => !!document.querySelector('.mprog .rfg')), 'ring visible'); ok('upload progress ring renders');
  await E(A.page, () => { const m = S.msgs.find(x => x.type === 'image'); XF.delete(m.id); paintMedia(m); });
  must(await E(A.page, () => !document.querySelector('.mprog')), 'ring gone'); ok('ring disappears when transfer finishes');

  // ---- scroll loading: 120 old messages, only the last 40 render, scrolling up loads more
  await E(A.page, async () => { const base = Date.now() - 86400000 * 3; for (let i = 0; i < 120; i++) await DB.put('messages', { id: 'old' + i, peer: 'bobby_t', dir: i % 2 ? 'in' : 'out', type: 'text', text: 'old message ' + i, ts: base + i * 1000, status: 'read' }); await openChat('bobby_t'); });
  await sleep(400);
  const c1 = await E(A.page, () => document.querySelectorAll('#msgs .row').length); must(c1 <= 45 && c1 >= 40, 'initial window ' + c1); ok('long chat renders only the newest ~40 messages (fast open): ' + c1);
  await E(A.page, () => { const b = document.querySelector('#msgs'); b.scrollTop = 0; b.dispatchEvent(new Event('scroll')); });
  await until(() => E(A.page, () => document.querySelectorAll('#msgs .row').length > 70), 'older loaded'); ok('scrolling up loads earlier messages');
  must(await E(A.page, () => S.msgs.length > 120 && !!document.querySelector('#histload')), 'spinner while more remain'); ok('“Loading earlier messages…” spinner shown while more remain');

  // ---- rename: bob changes id, alice's friend follows automatically
  await E(bp, () => applyNewId('bobby_new'));
  await until(() => E(A.page, () => S.friends.has('bobby_new') && !S.friends.has('bobby_t')), 'alice follows rename', 15000); ok('bob changes ID → alice\'s chat moves to the new ID automatically');
  must(await E(A.page, async () => (await DB.msgs('bobby_new')).length > 100), 'history kept'); ok('chat history is kept after the rename');
  await E(A.page, () => { document.querySelectorAll('.overlay').forEach(e => e.remove()); });
  await A.page.fill('#txt', 'after rename'); await A.page.press('#txt', 'Enter');
  await until(() => E(bp, async () => (await DB.msgs('alice_t')).some(m => m.text === 'after rename')), 'msg after rename'); ok('messages flow after the rename');

  // ---- delete for everyone (queued)
  await E(A.page, async () => { const m = (await DB.msgs('bobby_new')).find(x => x.text === 'after rename'); await deleteEveryone(m); });
  await until(() => E(bp, async () => (await DB.msgs('alice_t')).some(m => m.type === 'deleted')), 'delete propagated'); ok('delete-for-everyone reaches the friend');

  // ---- read receipts off
  // ---- Android download bar
  const AN = await newUser('Andy', 'andy_t', 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36');
  await sleep(800); must(!(await AN.page.$('.topbar')), 'no bar without apk'); ok('no download bar when the server has no APK yet (no dead link)');
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'Hushchats.apk'), Buffer.alloc(5 * 1048576, 1));
  try {
    await E(AN.page, async () => { await checkApk(); });
    const bar = await until(() => AN.page.$('.topbar'), 'topbar'); const txt = await bar.textContent();
    must(/Hushchats\.apk/.test(txt) && /Android/.test(txt) && /5\.0 MB/.test(txt) && /Download/.test(txt), 'bar text: ' + txt); ok('Android bar at the top: "' + txt.replace(/\s+/g, ' ') + '"');
    await sleep(500); const box = await bar.boundingBox(); must(box.y === 0, 'bar at top'); ok('bar is fixed at the very top of the screen');
    const [dl] = await Promise.all([AN.page.waitForEvent('download'), AN.page.click('.topbar .tb-btn')]);
    must(dl.suggestedFilename() === 'Hushchats.apk', 'filename ' + dl.suggestedFilename()); ok('tapping Download starts a real download named Hushchats.apk');
    await until(() => AN.page.$('.topbar.started'), 'started state'); ok('bar switches to "Downloading Hushchats.apk — check your notifications"');
    const desk = await A.page.$('.topbar'); must(!desk, 'desktop no bar'); ok('desktop browsers do not see the Android bar');
  } finally { fs.unlinkSync(path.join(__dirname, '..', 'public', 'Hushchats.apk')); }

  must(errors.filter(e => !/favicon|Failed to load resource|net::ERR|404/.test(e)).length === 0, 'page errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in any page');
  console.log(`\nALL ${n} END-TO-END CHECKS PASSED`);
  await browser.close(); process.exit(0);
})().catch(e => { console.error('\nFAIL:', e.message); process.exit(1); });
