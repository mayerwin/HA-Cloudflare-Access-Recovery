# Self-Healing Cloudflare Access Auth for Home Assistant

> ## ⚠ 2026-06-05 update — read this before the rest
>
> If you came here because your Home Assistant frontend silently freezes behind a Cloudflare Tunnel ("Unable to connect to Home Assistant", reloads don't help, mobile app still works) — **the actual root cause is most likely different from what the rest of this guide describes**. After a long debugging session on a setup with exactly that symptom, we traced it to:
>
> ### Cloudflare's mTLS + HTTP/3 + WebSocket combination is broken in Chromium browsers
>
> Specifically, if **all of the following are true** for your setup, this guide's `cloudflare_recovery.js` will not help you and the fix lives elsewhere:
>
> 1. You expose HA via Cloudflare Tunnel (with or without Cloudflare Access — even with Access fully disabled).
> 2. The hostname has **mTLS enabled** at Cloudflare (commonly: SSL/TLS → Client Certificates, "Hosts" includes your HA hostname — typically set up so the HA mobile Companion app can present a client cert).
> 3. **HTTP/3 is enabled at the Cloudflare zone level** (it is, by default).
> 4. You're using a **Chromium-family browser** (Chrome, Edge, Brave, Arc, Opera) — fresh incognito reproduces it cleanly.
>
> **Firefox is unaffected** because Firefox doesn't implement WebSocket-over-HTTP/3 (RFC 8441 Extended CONNECT); it falls back to HTTP/1.1 for the WS upgrade. **Existing browser sessions** with a warm HTTP/2 connection to your tunnel also appear unaffected (the bug only manifests on cold connections that negotiate HTTP/3 from the start).
>
> ### What's happening at the protocol level
>
> mTLS makes the Cloudflare edge send a TLS 1.3 `CertificateRequest` (message 13) during the handshake. Browsers without a client cert reply with an empty `Certificate` message — standard mTLS-optional behavior. This works perfectly over HTTP/1.1 and HTTP/2. Over HTTP/3 (QUIC), the combination of `CertificateRequest` + the WebSocket `Upgrade` (RFC 8441) breaks somewhere in CF's edge: HA's first WS server frame (`auth_required`) never reaches the browser correctly, and the browser closes the connection within ~300 ms during the auth phase. HA's logs show:
>
> ```
> Connected from <ip>
> Connection closed by client: Received close message during auth phase
> ```
>
> ### How to recognise it
>
> From any terminal with `curl`:
>
> ```bash
> # If this prints a "Request CERT" line, your hostname has mTLS enforced at CF:
> echo | curl -sSv --max-time 5 -o /dev/null https://YOUR-HA-HOSTNAME/ 2>&1 | grep "Request CERT"
> ```
>
> Combine that with: HTTP/3 ON at the zone (`dash.cloudflare.com → your zone → Network → HTTP/3 (with QUIC)`) and fresh Chrome incognito unable to complete the HA login WebSocket → this is your bug.
>
> ### The fix: split hostnames
>
> Cloudflare provides no way to disable HTTP/3 per-hostname on the free tier (we tried — Transform Rules stripping `Alt-Svc` don't help because CF also auto-publishes HTTPS DNS records (RFC 9460) advertising HTTP/3, which browsers read at DNS resolution time before any HTTP response).
>
> The clean workaround is to use **two hostnames** pointing at the same tunnel:
>
> | Hostname | mTLS | Purpose |
> |---|---|---|
> | `mobile-ha.example.com` | **ON** | HA mobile Companion app only |
> | `ha.example.com` | **OFF** | Web browser access |
>
> Setup steps:
>
> 1. **Identify your existing mTLS hostname** — Cloudflare dashboard → SSL/TLS → Client Certificates → "Hosts". Don't change this; the mobile app continues using it.
> 2. **Add a second public hostname** to your cloudflared tunnel (Zero Trust → Networks → Tunnels → your tunnel → Configure → Public Hostnames → add, e.g. `ha.example.com` pointing at `http://homeassistant:8123`). This second hostname is **not** added to the mTLS hosts list, so it has no `CertificateRequest` in its TLS handshake.
> 3. **Verify the new hostname has no mTLS:**
>    ```bash
>    echo | curl -sSv --max-time 5 -o /dev/null https://ha.example.com/ 2>&1 | grep "Request CERT" || echo "no mTLS — good"
>    ```
> 4. **Bookmark the new hostname** for browser use. Optionally set it as HA's External URL (Settings → System → General → External URL) so notifications, Google Assistant callbacks, etc. use it.
> 5. **HA Companion mobile app stays on the mTLS hostname** — no change needed in the mobile app config.
>
> HTTP/3 stays on zone-wide. Other subdomains keep HTTP/3. No performance regression anywhere.
>
> ### What we ruled out before finding mTLS as the trigger
>
> All of these were tested and innocent: HA SSL config (HTTP-internal vs HTTPS-internal), HA's OAuth `/auth/token` flow, cloudflared add-on version, cloudflared protocol (QUIC vs HTTP/2), tunnel mode (cert-based vs token-based managed), WAF custom rules, Cloudflare Access policies, Page Rules, Configuration Rules, WS compression (`permessage-deflate`), CF Workers proxying. The only thing that mattered was the per-hostname mTLS flag interacting with HTTP/3 zone-wide.
>
> ### About `cloudflare_recovery.js` in this repo
>
> This repo was originally created for a **different** Cloudflare problem: `CF_Authorization` cookie expiry causing the same user-visible symptom ("Unable to connect", reload doesn't help, mobile works). **We don't know whether that original problem still exists in current Cloudflare/HA versions** — it hasn't been re-tested since this mTLS+HTTP/3 discovery. The script and the detailed guide below are kept for reference. If you have the mTLS+HTTP/3 bug above, the script can detect a "stripped upgrade" signature in some cases but **cannot fix it from the browser** — the fix is the split-hostname approach above.
>
> ---

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

From then on, any stuck HA tab self-heals — usually within a few seconds, at worst within 60. Two independent detection paths run in parallel: an **event-driven hook** on HA's own WebSocket lifecycle that catches mid-session failures almost instantly, and a **60-second polling probe** as a safety net for cold-starts and edge cases where the WebSocket itself doesn't die. Both paths trigger the same cache-busting probe that detects the Cloudflare wall, unregisters the Service Worker, and reloads the tab. Because your Cloudflare Access SSO session cookie usually outlives the per-app `CF_Authorization`, you typically don't even see a login prompt — just a brief flash back to your dashboard.

**There is a second failure mode this script can only diagnose, not heal:** if your tunnel is on cloudflared's default `--protocol=auto` (QUIC), the `Upgrade: websocket` header sometimes gets dropped between Cloudflare's edge and your HA origin, and the dashboard appears frozen in exactly the same way. The HTTP probe stays green so the recovery reload doesn't trigger (correctly — there is no Cloudflare wall to recover from). The cure lives in cloudflared, not the browser: set `--protocol=http2` in the add-on's `run_parameters`. The script now detects this case and screams it loudly into the console with a pointer to [the section below](#second-failure-mode-websocket-upgrade-stripping). One‑line fix, included for completeness.

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

`cloudflare_recovery.js` is a small watcher that runs inside the HA frontend. The core probe — the only place that touches the network or decides to recover — does this:

1. Fires a `fetch()` at the current path with a cache-busting query string (`?_cb=<timestamp>`) plus `Cache-Control: no-cache` headers, forcing the Service Worker to actually hit the network instead of replaying its cached shell.
2. Uses `redirect: 'manual'` — this is the trick that makes the Cloudflare 302 observable as `response.type === 'opaqueredirect'` instead of being swallowed by CORS.
3. As a fallback, sniffs the response body for the Cloudflare Access HTML markers (`cloudflareaccess.com`, `cf-access`).
4. On detection: unregisters every Service Worker, then calls `window.location.reload()`. With the SW gone, the browser hits the network natively, Cloudflare returns its real 302, and the tab lands on the Cloudflare Access login page. Because your Cloudflare Access SSO session cookie is almost always still valid, you're bounced straight back to HA without typing anything.

If the device is simply offline, the `fetch` throws a `TypeError` that the script silently ignores — no gratuitous reloads when your Wi-Fi blips.

---

## Detection methods (and why there are two)

The probe above is fired by two independent triggers, each addressing a failure mode the other can't:

### Method 1 — Periodic polling (60 s default)
A `setInterval` runs the probe every `POLLING_INTERVAL_MS`. This is the original, simple approach. It catches **everything** eventually, including the worst case: a fresh tab opened with an expired CF cookie where HA gets stuck on the "Loading data" splash and `hass.connection` never even exists. It's also the only path that can fire when no specific event tells us anything is wrong (e.g. WebSocket alive but other requests being blocked).

The trade-off: up to a full minute of stuck-tab time before recovery starts.

### Method 2 — WebSocket event hook (event-driven, near-instant)
Subscribes to HA's own `home-assistant-js-websocket` Connection object — specifically the `disconnected` and `reconnect-error` events — and runs the probe within `WS_FAIL_DEBOUNCE_MS` (3 s default) of any failure. When the live WebSocket dies because Cloudflare started rejecting its handshake, the hook fires almost immediately, debounces a flurry of reconnect retries into a single probe, and recovery kicks in.

A natural question: *why not just subclass `window.WebSocket`?* That was the first attempt — but `home-assistant-js-websocket` captures a reference to the original `WebSocket` constructor at its own module-load time, which is before `extra_module_url` scripts execute. Any monkey-patch lands too late to intercept the connection. Subscribing to the higher-level Connection events is the only intercept point that works.

The hook has one limitation: it can only attach once `hass.connection` exists, which is *after* HA's frontend has bootstrapped. So it can't catch the cold-start "stuck on Loading data" case — that's what polling is for. The two methods are complementary, not redundant.

### Configuration

The top of `cloudflare_recovery.js` exposes both as flags:

```js
const ENABLE_POLLING = true;         // Periodic probe every POLLING_INTERVAL_MS.
const ENABLE_WEBSOCKET_HOOK = true;  // Probe only when HA's WebSocket fails.
const POLLING_INTERVAL_MS = 60000;
const WS_FAIL_DEBOUNCE_MS = 3000;    // Coalesce a flurry of reconnect failures into one probe.
const DEBUG = false;                 // Verbose console logging for testing.
```

Both methods enabled is the recommended default — they cover non-overlapping cases and the cost of running both is negligible. Disable polling if you're willing to trade cold-start coverage for zero idle traffic, or disable the hook if you want a maximally simple installation.

Setting `DEBUG = true` makes every step log to the console (probe runs, hook attachments, debounce decisions) — useful when validating the install, noisy in normal use.

---

## Second failure mode: WebSocket upgrade stripping

Everything described so far is about the **`CF_Authorization` cookie expiring** — a Cloudflare Access auth problem, fixable from the browser by reloading once Cloudflare can be reached again. There is a *second*, completely separate failure mode with the exact same user-visible symptom ("Unable to connect to Home Assistant", reloads don't help, mobile Companion still works), and it's not the cookie at all. It's the WebSocket upgrade itself being mangled before it reaches HA.

### How to recognise it

If you open the browser console while the dashboard is stuck and the recovery script is installed, you'll see, instead of the cookie-wall warning, a loud `console.error` along the lines of:

```
[cloudflare_recovery] WebSocket upgrade appears to be stripped between the
browser and Home Assistant (closed code 1006 in 264 ms, no `open` event).
This is NOT the cookie-expiry case — reloading will not fix it. Most common
cause: cloudflared on default --protocol=auto (QUIC). Fix: set
`--protocol=http2` in the cloudflared add-on `run_parameters`.
```

The signature on the network panel is just as distinct: every WebSocket attempt to `/api/websocket` shows up as a plain `GET` returning `HTTP 400`, with a `text/plain` response body that reads:

```
No WebSocket UPGRADE hdr: None
 Can "Upgrade" only to "WebSocket".
```

That message is generated by Home Assistant's aiohttp `WebSocketResponse` when a request lands on the WS endpoint without an `Upgrade: websocket` header. So somewhere between your browser sending the upgrade and HA reading it, the header is being dropped. The frontend then sees a non-101 response, the WebSocket aborts with `code: 1006, wasClean: false`, and the tab freezes — exactly the visual you remember from the cookie case.

### Why it happens

By default, `cloudflared` opens its edge connection over QUIC (`--protocol=auto`, which currently prefers QUIC). The browser's WebSocket request reaches Cloudflare's edge over HTTP/2 or HTTP/3, then has to get translated into the QUIC connection back to your home network, and then into HTTP/1.1 to your HA origin. That QUIC ↔ HTTP/1.1 translation step has had repeated regressions in cloudflared around the WebSocket-specific `Upgrade` header, and the symptom is exactly this one: the upgrade verb survives the trip but the upgrade *header* doesn't.

It's particularly nasty because:

- Plain HTTP requests through the same hostname work fine — the Cloudflare Access cookie validates, `/auth/providers`, `/`, `/api/`, etc. all return their expected statuses. So nothing looks broken at the auth layer.
- The recovery script's `?_cb=…` HTTP probe also returns a clean 200, so the cookie-wall detection correctly stays quiet. There is no Cloudflare wall — the cookie is valid.
- The mobile HA Companion app keeps working because it connects directly to HA over your trusted SSL cert and bypasses Cloudflare entirely.
- Hard-refreshing the tab occasionally appears to "fix" it — but only because the resulting reconnect happens to land on an HTTP/2 transport instead of QUIC. The same tab will silently break again the next time the underlying connection re-negotiates QUIC.

### The fix

Pin `cloudflared` to HTTP/2 transport for its edge link. In the [`homeassistant-apps/app-cloudflared`](https://github.com/homeassistant-apps/app-cloudflared) add-on, this goes through the `run_parameters` passthrough, since the add-on's schema doesn't have a dedicated key for it. Your add-on config ends up looking like this:

```yaml
external_hostname: ha.example.com
additional_hosts:
  - hostname: other.example.com
    service: http://192.168.1.10
run_parameters:
  - "--protocol=http2"
```

Save, restart the add-on. The browser-facing HTTP/3 stays on (that's the *zone* setting in Cloudflare's dashboard, not the tunnel one), so you don't lose HTTP/3 for the user-to-edge hop — only the edge-to-tunnel hop drops from QUIC to HTTP/2.

If you're running cloudflared directly (not via the HA add-on), the same flag goes on the command line as `--protocol http2`, or in the tunnel config file as:

```yaml
protocol: http2
```

After the restart, re-open HA in a fresh tab. The WebSocket should connect on the first try, the script's diagnostic error should not reappear, and you can move on with your life. Optionally [file the upstream bug](https://github.com/cloudflare/cloudflared/issues) and revisit `--protocol=auto` after the next cloudflared release.

### Why this script doesn't auto-heal it

A reload of the tab will not fix the upgrade stripping — the next reconnect will go back through the same broken path and die the same way. Worse, an auto-reload loop with no way out would actively get in your way while you tried to read the console message and find this README. So the script's policy is: detect the signature, log it loudly (throttled to one message every five minutes so a reconnect loop doesn't spam), and stop. The fix is genuinely a one-line change to your `cloudflared` add-on config — the script's job is to make sure you find that one line.

### When the probe runs (and why it has to look in two places)

The handshake probe is gated to two trigger paths, because each one catches a case the other can't:

1. **HA's own WebSocket lifecycle events (`disconnected`, `reconnect-error`).** Catches the mid-session case — HA bootstrapped fine, you used the dashboard for a while, and now the live socket has died. This path can't catch cold-start: if HA's *first* WebSocket attempt fails, `home-assistant-js-websocket` never assigns `hass.connection`, so there is no object to attach the listeners to.
2. **The 60-second polling tick, when `hass.connection` is missing or `connected: false`.** Catches the cold-start "stuck on Loading data" case the lifecycle hook can't see, plus belt-and-braces on mid-session failures the hook might somehow miss. Costs one extra WebSocket attempt per minute when something is wrong, zero when HA is healthy (the probe is gated on the silently-broken check).

If the probe fires from path 2, you'll see exactly the same `console.error` as from path 1 — the failure mode is identical, only the trigger is different.

### A useful manual test

You can confirm the path yourself from the browser console without waiting for a real failure:

```js
probeWebSocketHandshake().then(console.log)
```

A healthy tunnel gives you `{ stripped: false, reason: 'open', elapsedMs: ~50–500 }`. A broken (upgrade-stripped) tunnel gives you `{ stripped: true, reason: 'closed', code: 1006, wasClean: false, elapsedMs: < 1000 }`. The same handler runs internally when HA's WebSocket fires a `disconnected` or `reconnect-error` event and the HTTP probe came back clean.

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
   It should return `"function"`. If it returns `"undefined"`, the module isn't being loaded — double-check the `extra_module_url:` entry and clear the cache again. (Note: `extra_module_url` loads files as ES modules, which scope top-level declarations to the module — but `checkCloudflareWall` is deliberately re-exposed on `window` for exactly this test.)

### Test 2a — Polling is firing

1. In **DevTools → Network**, filter by `_cb=`.
2. Wait up to 60 seconds. You should see a new request every minute to your current path with a `?_cb=<timestamp>` query string.
3. While the session is valid, those requests return `200 OK` with the HA shell — and nothing else happens. That's the correct "quiet" behavior.

### Test 2b — The WebSocket hook is attached

Flip `DEBUG = true` at the top of the script (and restart HA to pick up the change). On the next page load, the Console should show:

```
[cloudflare_recovery] polling enabled, interval 60000 ms
[cloudflare_recovery] WebSocket hook enabled, debounce 3000 ms
[cloudflare_recovery] probe running, reason: page-load
[cloudflare_recovery] probe result: { ..., isCloudflareWall: false }
[cloudflare_recovery] attached to HA connection
```

That last line is the proof the hook found `hass.connection` and registered its listeners. You can also force a hook event manually from the console:

```js
document.querySelector('home-assistant').hass.connection.fireEvent('reconnect-error', new Error('test'));
```

You should immediately see `[cloudflare_recovery] HA connection: reconnect-error` followed by `probe scheduled` and `probe running`. The probe will return `isCloudflareWall: false` (because there's no actual wall) — that's the disambiguation working as designed.

Flip `DEBUG = false` again before normal use.

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

### Test 4 — Direct WebSocket handshake probe

This one stands alone: it has nothing to do with cookies and is the diagnostic for the [second failure mode](#second-failure-mode-websocket-upgrade-stripping). In the console:

```js
probeWebSocketHandshake().then(console.log)
```

On a healthy tunnel you should see:

```
{ stripped: false, reason: 'open', elapsedMs: 87 }
```

On a tunnel where the `Upgrade` header is being dropped (the cloudflared-on-QUIC case) you'll see:

```
{ stripped: true, reason: 'closed', code: 1006, wasClean: false, elapsedMs: 264 }
```

If you ever see the `stripped: true` shape during a real outage, jump straight to [the cloudflared fix](#the-fix) — no other section of this guide applies.

---

## Security notes

- The script only ever fetches its own origin (`window.location.pathname`). It never exposes cookies or tokens to a third party.
- Unregistering Service Workers is a local, reversible operation — HA will re-register its SW on the next successful load.
- The 60-second polling interval is conservative. With the event-driven WebSocket hook enabled (the default), mid-session expiry recovery already fires within seconds, so dropping the interval gives diminishing returns — but if you only want polling and a short session policy, `15000` (15 s) is reasonable. Much lower than that and you're making unnecessary network calls.

---

## License

MIT. Use, modify, share freely.
