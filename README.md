# Hushchats — backend + app (Railway ready)

This folder is the **whole project**: a Node.js server (`server.js`) that also serves your website (`public/index.html`).
It has **no dependencies** — nothing to `npm install`.

```
server.js            ← the backend (WebSocket relay, online status, offline message queue, photo storage, TURN credentials)
package.json
public/
  index.html         ← your app
  manifest.webmanifest, sw.js, icon-*.png   ← makes it installable + notifications on Android
  Hushchats.apk      ← PUT YOUR APK HERE (optional, see step 5)
test/                ← automated tests (not needed on Railway)
```

## Deploy on Railway (10 minutes)

1. **Put the folder on GitHub**
   ```
   git init
   git add .
   git commit -m "Hushchats"
   git branch -M main
   git remote add origin https://github.com/YOU/hushchats.git
   git push -u origin main
   ```
   GitHub only ever holds this code — no accounts, no messages, no IP addresses are ever written to it.
2. **Railway** → *New Project* → *Deploy from GitHub repo* → choose it. Railway finds Node and runs `npm start` by itself.
3. In the service: **Settings → Networking → Generate Domain**. That URL is your app (`https://xxxx.up.railway.app`). Open it on both phones.
4. **VERY IMPORTANT — add a Volume** (otherwise every redeploy deletes all accounts, waiting messages and photos):
   *Service → Volumes → New Volume → Mount path* `/data`, then *Variables → New Variable*: `DATA_DIR` = `/data`.
5. **Android download bar (optional):** copy your APK to `public/Hushchats.apk`, `git add`, `git commit`, `git push`.
   Android phones then see a bar at the top: **Hushchats.apk · Your device is Android · 14 MB · [Download]**.
   If the file isn't there, the bar (and every other APK button) stays hidden instead of giving a broken link.

## Turning on IP protection for calls (recommended)

By default, voice/video calls connect the two phones **directly** (standard WebRTC) so each side's IP address is visible to the other. To stop that, add a TURN relay — then every call goes through your server instead, and neither side learns the other's IP. The app itself tells you which mode is active in **Settings → Calls: IP protected / not active**, and warns before a call connects if there's no relay.

Cheapest path — run [coturn](https://github.com/coturn/coturn) as its own small Railway service (a few dollars a month), then on the Hushchats service add these variables:

| Variable | Value |
|---|---|
| `TURN_URL` | `turn:your-coturn-host:3478` (comma-separate if you have more than one) |
| `TURN_SECRET` | the same `static-auth-secret` you set in coturn's config |

No coturn of your own yet? For testing, a free shared relay works (e.g. openrelay.metered.ca) — set:
| `TURN_URL` | `turn:openrelay.metered.ca:80` |
| `TURN_USER` / `TURN_PASS` | the free credentials from their site |

Note free/shared relays are rate-limited and not private in the sense of "nobody else routes through it" — for real use, run your own coturn.

## Privacy & anti-forensics features

| Feature | What it does | Limits, honestly |
|---|---|---|
| End-to-end encryption | Messages, photos, voice notes and call setup are encrypted with per-friend AES-256-GCM keys derived over ECDH. The server only ever sees ciphertext. | The per-friend key is fixed (not per-session), because a message must still be readable by a friend who was offline when it was sent — so there's no forward secrecy across the whole history the way Signal's ratchet gives you. |
| Call IP protection | When a TURN relay is configured (see above), calls are forced through it (`iceTransportPolicy: relay`) — your friend's app never learns your IP, and vice-versa. | Requires you to configure a relay. Without one, the app warns you and calls connect directly (IP visible to your call partner, as with ordinary WebRTC). |
| No IP logging | The server never writes a connection's IP address to any log or to disk. | Your hosting provider's own infrastructure (Railway, or any host) may still capture connection metadata at the network layer — that's outside any application's control, on any platform. |
| App Lock (PIN) | Your identity key is encrypted at rest on your device (PBKDF2-SHA256, 150,000 rounds → AES-256-GCM) using a key derived from your PIN. A forensic dump of local storage shows only salt+ciphertext — nothing readable without the PIN. The app re-locks itself a few seconds after you leave it. | This protects your *identity key*. It does not encrypt the local message/photo database at rest — see "Panic wipe" for how to handle that. |
| Panic wipe | Settings → *Erase this device now*, or tap the app logo 5× quickly on the welcome screen. Instantly deletes IndexedDB (all messages/photos), localStorage (identity, keys, settings) and caches — no confirmation step delay, no network round-trip. | Deletion here means the browser's storage APIs say the data is gone; it does not securely overwrite the underlying disk sectors — no web app can promise that. For real protection against a device already in someone else's hands, set an App Lock PIN *before* that happens. |
| Disappearing messages | Settings → *Disappearing messages*: new messages you send delete themselves — on both your device and your friend's — after 1 hour / 24 hours / 7 days. | Only affects messages sent after you turn it on; it's best-effort (relies on both apps being online at some point after expiry to actually run the deletion), not a cryptographic guarantee.|
| No accounts info | No phone number, email, or any real-world identifier is ever requested or stored. IDs are free-text handles you pick. | The operator of your Railway deployment can still see IDs and message timing/sizes (not content) — that's the same as any relay-based messenger. |

**What no app can promise:** if someone has your unlocked phone in their hands, no software fully defeats a determined forensic extraction of a running device. App Lock + Panic Wipe substantially raise the bar (encrypted-at-rest identity, instant deletion) but "full anonymity" against physical device access is not something any app — this one included — can guarantee. Set an App Lock PIN, and use Panic Wipe if you ever need to be sure.

## What was wrong before, and what fixes it

| Your problem | Cause | Now |
|---|---|---|
| Friend can find me but I show "offline" | Old app was peer‑to‑peer: you only "see" someone while **both** phones are connected at the same moment | The server knows who is online and pushes it live. Adding a friend shows the real status instantly. Offline shows "Last seen …" |
| They send a message and I never see it | Messages were lost when the other phone was not connected | Server keeps the (encrypted) message until you come back, then delivers it. Nothing is lost |
| Photos not sending properly | Big files through WebRTC data channels are fragile | Photos are encrypted on the phone, uploaded over HTTPS with a **progress ring**, downloaded with a progress ring (blurred preview first). Tap to retry / cancel |
| No ticks | — | WhatsApp style: 🕓 sending · ✓ sent to server (friend offline) · ✓✓ delivered · **blue ✓✓ read** |
| No send sound / loading | — | Soft "pop" on send, blip on receive, earlier messages load as you scroll up (spinner) |
| Friend limits | Old app tried to connect to every friend | One connection total. No limit on friends |
| Android download bar | — | Top bar with the file name, "Your device is Android", size and Download button |
| Call IP exposure | Direct WebRTC connects phones peer-to-peer | Optional TURN relay forces calls through your server instead — see above |
| Phone taken / forensics | Identity key stored in plain text | App Lock PIN encrypts it; Panic Wipe clears everything instantly |

## Good to know
* **Everyone must open the new version** — the old peer‑to‑peer build cannot talk to this one. Existing accounts (recovery key / saved key) keep working: the ID is registered on the server the first time they open it.
* IDs are first‑come. If someone already took your ID on the new server, the app asks you to pick another.
* No push notifications when the app is completely closed (that needs Firebase/Web‑Push). While the app is open or recently in the background, you get notifications and messages arrive instantly; when you open it, everything waiting is delivered.
* Health check for Railway: `/health`.

## Tests
`node test/server.test.js` (37 server checks), `node test/security.js` (11 App Lock / panic wipe checks), `node test/ttl.js` (3 disappearing-message checks) — all need only Node. `node test/e2e.js` and `node test/call.js` additionally need Playwright + Chromium (dev only, not needed for deployment).
