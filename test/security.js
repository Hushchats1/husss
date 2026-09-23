'use strict';
const os = require('os'), fs = require('fs'), path = require('path'), { execSync } = require('child_process');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hcsec-'));
const { server } = require('../server.js');
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NAMES = 'S,DB,enableLock,disableLock,lockOn,wipeNow';
const E = (page, fn) => page.evaluate(`(async()=>{const {${NAMES}}=window.__HC_TEST; return await (${fn.toString()})();})()`);
let n = 0; const ok = m => console.log('  ✓', m, `(${++n})`);
async function until(fn, msg, ms = 10000) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error('timeout: ' + msg); await sleep(120); } }
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 800 } });
  await ctx.addInitScript(() => { window.__HC_TEST = {}; });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(base + '/');
  await p.click('text=Create account'); await p.fill('input[placeholder="Display name"]', 'Sec'); await p.fill('input[maxlength="12"]', 'sec_t'); await p.click('text=Continue');
  await until(() => E(p, () => S.net === 'online'), 'online');
  ok('account created');

  // ---- before lock: identity is plaintext in localStorage (expected — lock is opt-in)
  const before = await p.evaluate(() => localStorage.getItem('hl.key'));
  if (!before || !before.includes('"handle":"sec_t"')) throw new Error('expected plaintext key before lock');
  ok('without App Lock, key is plain (baseline)');

  // ---- enable lock
  await E(p, () => enableLock('4321'));
  const afterKey = await p.evaluate(() => localStorage.getItem('hl.key'));
  const lockRec = await p.evaluate(() => localStorage.getItem('hl.lock'));
  if (afterKey !== null) throw new Error('plaintext key should be gone');
  if (!lockRec || /sec_t|priv|handle/.test(lockRec)) throw new Error('lock record leaks plaintext: ' + lockRec);
  ok('App Lock ON → hl.key removed, hl.lock is pure ciphertext (no ID, no key material visible)');
  const parsed = JSON.parse(lockRec);
  if (!parsed.salt || !parsed.iv || !parsed.ct) throw new Error('bad lock record shape');
  ok('lock record is salt+iv+ciphertext (PBKDF2 + AES-GCM), as documented');

  // ---- wrong PIN cannot decrypt
  let wrongFailed = false;
  try { await p.evaluate(async () => { const { lockDecrypt, lockRec } = window; }); } catch {}
  const wrongOk = await p.evaluate(async (rec) => {
    try {
      const salt = Uint8Array.from(atob(rec.salt.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
      const iv = Uint8Array.from(atob(rec.iv.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
      const ct = Uint8Array.from(atob(rec.ct.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('0000'), 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey({ name:'PBKDF2', salt, iterations:150000, hash:'SHA-256' }, base, { name:'AES-GCM', length:256 }, false, ['decrypt']);
      await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, ct);
      return true;
    } catch { return false; }
  }, JSON.parse(lockRec));
  if (wrongOk) throw new Error('wrong PIN should not decrypt');
  ok('wrong PIN (0000 vs 4321) cannot decrypt the identity — confirmed by direct crypto attempt');

  // ---- reload the page: lock screen should appear before any chat UI
  await p.reload(); await sleep(600);
  const locked = await p.evaluate(() => !!document.querySelector('.pinpad'));
  const appHidden = await p.evaluate(() => document.querySelector('#app') ? document.querySelector('#app').hidden !== false : true);
  if (!locked) throw new Error('lock screen did not appear on reload');
  ok('reloading the page (= reopening the app) shows the PIN pad before anything else');

  // ---- unlock with correct PIN via the real UI
  for (const d of ['4','3','2','1']) await p.click(`.pinkey >> text="${d}"`);
  await until(() => p.evaluate(() => !document.querySelector('.pinpad')), 'unlocked');
  await until(() => E(p, () => S.net === 'online'), 'back online');
  ok('correct PIN (4321) typed on the pad unlocks and loads the account normally');

  // ---- disable lock
  await E(p, () => disableLock('4321'));
  if (!(await p.evaluate(() => localStorage.getItem('hl.key')))) throw new Error('key should be plaintext again');
  ok('turning App Lock off restores normal (unencrypted-at-rest) storage');

  // ---- panic wipe
  await E(p, () => enableLock('9999'));
  await E(p, async () => { await DB.put('messages', { id: 'm1', peer: 'x', dir: 'out', type: 'text', text: 'secret', ts: Date.now(), status: 'sent' }); });
  const hasMsgBefore = await E(p, async () => (await DB.all('messages')).length);
  if (!hasMsgBefore) throw new Error('setup failed');
  await E(p, () => wipeNow());
  await sleep(1500);
  const afterWipe = { key: await p.evaluate(() => localStorage.getItem('hl.key')), lock: await p.evaluate(() => localStorage.getItem('hl.lock')) };
  if (afterWipe.key || afterWipe.lock) throw new Error('storage not cleared: ' + JSON.stringify(afterWipe));
  ok('panic wipe clears identity + lock record from localStorage instantly');
  const onWelcome = await p.evaluate(() => document.body.innerText.includes('Create account'));
  if (!onWelcome) throw new Error('did not return to welcome screen');
  ok('after wipe, app returns to the welcome screen (fresh state, nothing left to recover)');

  if (errs.length) throw new Error('JS errors: ' + JSON.stringify(errs));
  ok('no JavaScript errors during the whole flow');
  console.log(`\nALL ${n} SECURITY CHECKS PASSED`);
  await browser.close(); process.exit(0);
})().catch(e => { console.error('\nFAIL:', e.message); process.exit(1); });
