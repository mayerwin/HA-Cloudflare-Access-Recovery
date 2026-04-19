# Self-Healing Cloudflare Access Auth for Home Assistant

**A drop-in JavaScript module that lets the Home Assistant web frontend — in any browser, on desktop or mobile — gracefully recover when the Cloudflare Access `CF_Authorization` cookie expires.**

---

## TL;DR

If your Home Assistant frontend silently freezes after a few days or weeks behind Cloudflare Tunnel + Cloudflare Access (error message "Unable to connect to Home Assistant", while automations still fire on the server), you're hitting an expired `CF_Authorization` cookie. HA can't self-recover because of a three-way trap: CORS hides the auth redirect, WebSockets can't read an HTML login page, and the Service Worker keeps serving the cached UI shell so the tab never hits the network.

**Fix it in three steps:**

1. Drop [`cloudflare_recovery.js`](cloudflare_recovery.js) into `<ha-config>/www/`.
2. Add to `configuration.yaml`:
   ```yaml
   frontend:
     extra_module_url:
       - /local/cloudflare_recovery.js
   ```
3. Restart HA, then do one "Empty Cache and Hard Reload" in each browser you use.

From then on, any stuck HA tab self-heals within 60 seconds — a cache-busting probe detects the Cloudflare wall, unregisters the Service Worker, and reloads the tab. Because your Cloudflare Access SSO session cookie usually outlives the per-app `CF_Authorization`, you typically don't even see a login prompt — just a brief flash back to your dashboard.

Read on for the full story, the failure modes, and how to verify it's working.

---

## The problem, in detail

If you put your Home Assistant instance behind a Cloudflare Tunnel (`cloudflared`) with Cloudflare Zero Trust / Cloudflare Access in front for authentication — a very common and recommended setup — you've probably hit this: every few hours or days, the UI stops updating, entities go stale, automations still fire on the server but the frontend is dead. Every browser you have open on the HA URL eventually goes silent: desktop or mobile, Chrome, Edge, Safari, Firefox, Brave, Arc, doesn't matter. (The HA Companion mobile app is unaffected if it connects directly via a trusted SSL certificate, bypassing the Cloudflare Access layer.)

You hit refresh in the stuck tab. Nothing. You close and reopen it. Nothing — the Service Worker just serves the cached shell again. You can't even guess the Cloudflare login URL to navigate to, because Cloudflare generates a per-request signed URL you have no way to reconstruct.

The only manual workaround is a minor contortion: open your HA URL in an **Incognito / Private window**. Because incognito has no cookies, Cloudflare immediately redirects the tab to its per-request signed login URL (`https://<yourteam>.cloudflareaccess.com/cdn-cgi/access/login/...`). Copy that URL from the incognito address bar **before authenticating**, then paste it into the stuck non-incognito window. Because your regular profile still has a valid Cloudflare Access SSO session cookie (even though the per-app `CF_Authorization` is expired), Cloudflare silently issues a fresh cookie and bounces you straight back to HA — no credentials re-entered.

That works, but it's ridiculous. Nobody should have to open an incognito window to get their smart-home dashboard back.

This repo automates the whole thing, in about 80 lines of JavaScript.

---

## Whose problem is this to solve?

Strictly speaking, this is a gap in the `cloudflared` / Cloudflare Tunnel side of the stack — the Home Assistant add-on that proxies your instance through a Cloudflare Tunnel with Access in front. A watcher like this one belongs in (or shipped alongside) that add-on, because it's the piece that *opted you in* to an auth layer the frontend doesn't know about. Ideal outcome: the `cloudflared` HA add-on installs a small recovery module by default when Cloudflare Access is in use.

Home Assistant core *could* also ship a built-in recovery module. It has the standing to — they shipped the Service Worker, they own the frontend. But it's reasonable for HA core to defer to the integration/add-on owner here, since a generic "detect any reverse-proxy auth wall" heuristic is harder to get right than a Cloudflare-specific one.

Either way, until one of them picks it up, drop this script in and your frontend self-heals.

---

## Why Home Assistant can't fix this without help

Three independent browser-security behaviors, consistent across every modern browser, make HA blind to Cloudflare's expiry:

### 1. CORS hides the 302 redirect
Home Assistant is a Single Page Application. Once the shell is loaded, all real data flows over background `fetch()` / XHR calls. When your `CF_Authorization` cookie expires, Cloudflare responds to those background calls with a `302 Redirect` to `https://<yourteam>.cloudflareaccess.com/cdn-cgi/...`.

But that redirect is **cross-origin**, so the browser's CORS rules strip the redirect URL before the HA script can see it. All HA's JS receives is a generic `TypeError: Failed to fetch`. It has no idea a login page exists.

### 2. WebSockets don't speak HTML
HA's live updates run over WebSockets, which require a very specific `101 Switching Protocols` handshake. When Cloudflare intercepts the upgrade request and returns its login HTML instead, the WebSocket client sees "this isn't a handshake" and aborts instantly. There is no hook to detect "hey, a login page is sitting in front of me."

### 3. The Service Worker keeps you trapped
HA installs a Service Worker so the UI loads instantly, even offline. When you type your HA URL into the address bar, the browser **never asks the network** — the Service Worker serves the cached UI shell directly from disk. The shell loads, the background WebSockets die against the Cloudflare wall, and nothing in the main browser tab ever hits the network to trigger a redirect to the login page.

So the page looks alive but is completely deaf to the auth layer. Hitting refresh just re-serves the cached shell.

---

## The fix, in detail

`cloudflare_recovery.js` is a small watcher that runs inside the HA frontend. Every 60 seconds it:

1. Fires a `fetch()` at the current path with a cache-busting query string (`?_cb=<timestamp>`) plus `Cache-Control: no-cache` headers, forcing the Service Worker to actually hit the network instead of replaying its cached shell.
2. Uses `redirect: 'manual'` — this is the trick that makes the Cloudflare 302 observable as `response.type === 'opaqueredirect'` instead of being swallowed by CORS.
3. As a fallback, sniffs the response body for the Cloudflare Access HTML markers (`cloudflareaccess.com`, `cf-access`).
4. On detection: unregisters every Service Worker, then calls `window.location.reload()`. With the SW gone, the browser hits the network natively, Cloudflare returns its real 302, and the tab lands on the Cloudflare Access login page. Because your Cloudflare Access SSO session cookie is almost always still valid, you're bounced straight back to HA without typing anything.

If the device is simply offline, the `fetch` throws a `TypeError` that the script silently ignores — no gratuitous reloads when your Wi-Fi blips.

---

## Installation

### Step 1 — Drop the script into your HA `www/` directory

Copy `cloudflare_recovery.js` into `<config>/www/` on your Home Assistant instance. (The `www/` folder maps to the `/local/` URL path in HA.)

If you don't already have a `www/` folder, create it:

```bash
mkdir -p /config/www
```

### Step 2 — Register it as a frontend extra module

Add the script as an extra module in your `configuration.yaml`:

```yaml
frontend:
  extra_module_url:
    - /local/cloudflare_recovery.js
```

### Step 3 — Restart Home Assistant, then hard-reload the browser

After HA restarts, do a full "Empty Cache and Hard Reload" in every browser (desktop *and* mobile) you use with HA. The exact label differs per browser, but they all expose it:

- **Chromium-based (Chrome, Edge, Brave, Arc, Opera) on desktop:** open DevTools → right-click the reload button → **Empty Cache and Hard Reload**.
- **Firefox on desktop:** `Ctrl+Shift+Delete` → clear "Cached Web Content" scoped to Today, then reload.
- **Safari on desktop:** enable Develop menu (Preferences → Advanced), then **Develop → Empty Caches**, then reload.
- **Mobile browsers:** clear site data for your HA domain in the browser's site-settings / privacy panel (e.g. Chrome mobile: `chrome://settings/siteData`; Safari on iOS: Settings → Safari → Advanced → Website Data). Then reopen HA.

This is a one-time step — once the new frontend shell is in place, the module loads on every subsequent visit.

---

## How to test it's actually working

Three things worth verifying. The steps below use Chromium DevTools (Chrome, Edge, Brave, Arc) because they're the most common setup, but Firefox and Safari have equivalents for every step.

### Test 1 — The script is loaded

1. Open HA in your browser.
2. Open **DevTools → Sources → Page** and look under your HA host → `local/` → `cloudflare_recovery.js`. You should see the file listed.
3. In **DevTools → Console**, run:
   ```js
   typeof checkCloudflareWall
   ```
   It should return `"function"`. If it returns `"undefined"`, the module isn't being loaded — double-check the `extra_module_url:` entry and clear the cache again.

### Test 2 — It's actually polling

1. In **DevTools → Network**, filter by `_cb=`.
2. Wait up to 60 seconds. You should see a new request every minute to your current path with a `?_cb=<timestamp>` query string.
3. While the session is valid, those requests return `200 OK` with the HA shell — and nothing else happens. That's the correct "quiet" behavior.

### Test 3 — Force a Cloudflare expiry and watch the self-heal

This is the important one. You want to simulate the exact condition that trapped you originally.

**Easiest method — delete the cookie manually:**

1. Open HA in your browser.
2. **DevTools → Application → Storage → Cookies → `https://<your-ha-domain>`** (or the equivalent storage inspector in Firefox / Safari).
3. Find `CF_Authorization` and delete it. (If there are other `CF_*` cookies scoped to your HA domain, like `CF_AppSession`, delete those too to be thorough. Leave the cookies on `*.cloudflareaccess.com` intact — those are your SSO session and are what lets you re-enter without typing credentials.)
4. **Don't touch the tab.** Just wait.
5. Within 60 seconds you should see:
   - A `Cloudflare Access wall detected...` warning in the Console.
   - `Service Worker unregistered.` log lines.
   - The tab reloading on its own.
   - The tab briefly flashing through Cloudflare's login flow and landing back on your HA dashboard, fully connected, with no credentials prompt.

**Stricter method — revoke from the Cloudflare dashboard:**

1. Go to **Cloudflare Zero Trust → Access → Users**, find yourself, and revoke active sessions.
2. Return to the HA tab without touching it.
3. Same outcome, except this time you *will* be asked to re-authenticate, because you killed the SSO session too. After login, HA comes back on its own.

**What to do if Test 3 fails:**

- If the `?_cb=` fetches from Test 2 return `200 OK` even after you've deleted the cookie, your HA path is bypassing Cloudflare Access (check your Access policies — you may have an unintended "Bypass" rule for the root).
- If the console shows `TypeError: Failed to fetch` and no detection, your browser is enforcing CORS before `redirect: 'manual'` can surface the redirect — usually means Cloudflare is sending a CORS preflight failure rather than a 302. Verify in **DevTools → Network** what status Cloudflare actually returns for an expired session.
- If the reload happens but just lands back on a dead HA shell, a Service Worker is being re-registered before the reload. Confirm that `registrations.length > 0` before unregister, and that no other SW is scoped to the same path.

---

## Security notes

- The script only ever fetches its own origin (`window.location.pathname`). It never exposes cookies or tokens to a third party.
- Unregistering Service Workers is a local, reversible operation — HA will re-register its SW on the next successful load.
- The 60-second interval is conservative. If your Cloudflare Access session policy is short (say, 15 minutes) and you care about minimizing the visible gap, you can drop it to `15000` (15 seconds). Much lower than that and you're making unnecessary network calls.

---

## License

MIT. Use, modify, share freely.
