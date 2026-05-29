// cloudflare_recovery.js
// -----------------------------------------------------------------------------
// Self-healing watcher for Home Assistant (or any PWA / SPA) sitting behind
// Cloudflare Zero Trust / Cloudflare Access.
//
// Problem this solves:
//   When the CF_Authorization cookie issued by Cloudflare Access expires,
//   Home Assistant cannot recover on its own:
//     - Cross-origin (CORS) rules hide the 302 redirect from background fetches
//     - The WebSocket sees HTML instead of a 101 Switching Protocols handshake
//       and aborts without any way to surface the login URL
//     - The Service Worker keeps serving the cached UI shell, so a hard refresh
//       of the tab never even hits Cloudflare to trigger re-auth
//
//   The result: the app appears "loaded" but every interaction times out, and
//   no amount of clicking refresh inside the tab fixes it. The mobile app
//   (Home Assistant Companion) suffers the same fate because it embeds the
//   frontend in a WebView with the same Service Worker behavior.
//
// Two detection methods are configurable independently below:
//   1. Polling: every POLLING_INTERVAL_MS, runs the probe. Defensive baseline
//      that also catches the cold-start "stuck on Loading data" case where
//      hass.connection doesn't exist yet.
//   2. WebSocket hook: subscribes to HA's home-assistant-js-websocket
//      Connection events ('disconnected', 'reconnect-error'). Probes within
//      seconds of the live socket dropping, instead of waiting up to a minute
//      for the next polling tick.
//
// Both methods call the same checkCloudflareWall() probe, which is the only
// place that touches the network or makes recovery decisions:
//   1. Fetches the current page with a cache-busting query string + no-cache
//      headers, forcing the Service Worker to actually hit the network.
//   2. Uses `redirect: 'manual'` so a Cloudflare 302 surfaces as
//      `response.type === 'opaqueredirect'` instead of being swallowed by CORS.
//   3. As a fallback, sniffs the response body for the Cloudflare Access login
//      HTML markers ("cloudflareaccess.com" or "cf-access").
//   4. On detection: unregisters every Service Worker and calls
//      window.location.reload(). With the SW gone, the browser hits the
//      network natively, Cloudflare returns its real 302, and you land on the
//      Cloudflare Access login page. After login, you're back in HA.
//
// Second failure mode (added later) — WebSocket UPGRADE header stripped:
//   When the HTTP probe returns a clean 200 but the live WebSocket keeps
//   dying anyway, the upgrade itself is being mangled somewhere between the
//   browser and HA — usually cloudflared (default QUIC transport drops the
//   `Upgrade: websocket` header during QUIC↔HTTP/1.1 translation), but the
//   same symptom has also been observed transiently on HTTP/2 transport,
//   suggesting the bug isn't purely on the QUIC path. The origin sees a
//   plain GET and HA's aiohttp replies "No WebSocket UPGRADE hdr: None",
//   400. The browser surfaces this as code 1006 with no `open` event.
//
//   probeWebSocketHandshake() detects exactly this signature. It runs:
//     - on every HA WebSocket failure event (catches mid-session failures);
//     - on the polling tick when hass.connection is missing or disconnected
//       (catches the cold-start "stuck on Loading data" case, where there
//       is no Connection object for the WS hook to attach to).
//   The fix lives outside the browser, so the script does NOT reload — it
//   logs loudly to the console with a pointer to the README, throttled to
//   one message every 5 minutes so a reconnect loop doesn't spam.
// -----------------------------------------------------------------------------

// === Detection methods — enable either, both, or neither ===
const ENABLE_POLLING = true;             // Periodic probe every POLLING_INTERVAL_MS.
const ENABLE_WEBSOCKET_HOOK = true;      // Probe only when HA's WebSocket fails.
const ENABLE_WS_HANDSHAKE_PROBE = true;  // After a WS failure with a clean HTTP probe,
                                         // attempt a fresh WebSocket and detect the
                                         // "upgrade header stripped" failure mode
                                         // (see README, "Second failure mode").
const POLLING_INTERVAL_MS = 60000;
const WS_FAIL_DEBOUNCE_MS = 3000;        // Coalesce a flurry of reconnect failures into one probe.
const WS_HANDSHAKE_TIMEOUT_MS = 1500;    // Max wait for the diagnostic WS to do anything.
const WS_HANDSHAKE_STRIPPED_MS = 1000;   // Close-without-open under this is the stripped signature.
const WS_STRIPPED_LOG_THROTTLE_MS = 5 * 60 * 1000; // At most one stripped-log every 5 min.
const DEBUG = false;                     // Verbose console logging for testing.
// ===========================================================

const log = (...args) => DEBUG && console.log('[cloudflare_recovery]', ...args);

// Reasons that came from HA's WebSocket lifecycle (vs polling / page-load).
const isWsTriggeredReason = (reason) =>
    reason === 'ha-disconnected' || reason === 'ha-reconnect-error';

// "Silently broken" = the WebSocket-driven HA Connection that the rest of the
// frontend depends on is either missing or disconnected. Two distinct cases:
//   - hass.connection doesn't exist: HA bootstrapped enough to mount the
//     <home-assistant> element but the first WebSocket never succeeded, so
//     home-assistant-js-websocket never reached the point of assigning
//     hass.connection. This is the cold-start "stuck on Loading data" trap —
//     the user sees "Unable to connect to Home Assistant, retrying in N s".
//     The WebSocket hook can't help here because it has nothing to attach to.
//   - hass.connection exists but reports connected:false: HA bootstrapped
//     once, then the live socket died and reconnects are failing. The hook
//     would have caught this case too, but we double-check on polling for
//     belt-and-braces.
// Used to decide whether to run the handshake probe on a non-WS-triggered
// poll, since the HTTP probe alone can't tell us the WS path is dead.
function isHaWebSocketSilentlyBroken() {
    const ha = document.querySelector('home-assistant');
    if (!ha) return false; // Too early — even the frontend hasn't mounted yet.
    const conn = ha.hass && ha.hass.connection;
    if (!conn) return true;
    if (conn.connected === false) return true;
    return false;
}

// Decide whether to run the WebSocket handshake probe for this call to
// checkCloudflareWall. The probe opens a real WebSocket, which is cheap
// (~250–1000 ms when it works, faster when it fails) but not free, so we
// gate it: always run for explicit WS failure events; for periodic polling,
// only run when HA's own Connection looks stuck.
function shouldProbeHandshake(reason) {
    if (!ENABLE_WS_HANDSHAKE_PROBE) return false;
    if (isWsTriggeredReason(reason)) return true;
    // page-load fires before HA has had time to bootstrap; do not probe yet.
    if (reason === 'page-load') return false;
    return isHaWebSocketSilentlyBroken();
}

// Throttle the second-failure-mode error log so a reconnect loop doesn't spam.
let lastStrippedLogAt = 0;

// Open a fresh WebSocket and watch the handshake. The "upgrade stripped"
// signature is: closes with code 1006, wasClean: false, no `open` event ever
// fires, and the whole thing happens in under WS_HANDSHAKE_STRIPPED_MS.
// This corresponds to the origin returning a non-101 HTTP response (typically
// HA's aiohttp 400 'No WebSocket UPGRADE hdr: None') because the Upgrade
// header didn't survive the tunnel — most commonly seen with cloudflared
// using its default QUIC transport (--protocol=auto).
async function probeWebSocketHandshake() {
    return new Promise((resolve) => {
        const started = Date.now();
        let opened = false;
        let ws;
        try {
            ws = new WebSocket('wss://' + location.host + '/api/websocket');
        } catch (err) {
            resolve({ stripped: false, reason: 'constructor-threw', error: String(err) });
            return;
        }
        const timer = setTimeout(() => {
            try { ws.close(); } catch (_) {}
            resolve({ stripped: false, reason: 'timeout', elapsedMs: Date.now() - started });
        }, WS_HANDSHAKE_TIMEOUT_MS);
        ws.onopen = () => {
            opened = true;
            clearTimeout(timer);
            try { ws.close(); } catch (_) {}
            resolve({ stripped: false, reason: 'open', elapsedMs: Date.now() - started });
        };
        ws.onclose = (e) => {
            clearTimeout(timer);
            const elapsedMs = Date.now() - started;
            const stripped =
                !opened &&
                e.code === 1006 &&
                elapsedMs < WS_HANDSHAKE_STRIPPED_MS;
            resolve({
                stripped,
                reason: 'closed',
                code: e.code,
                wasClean: e.wasClean,
                elapsedMs
            });
        };
    });
}

async function checkCloudflareWall(reason = 'manual') {
    log('probe running, reason:', reason);
    try {
        // 1. Target the protected UI (not the API, which may have a bypass policy).
        // 2. Cache-buster + no-cache headers force the Service Worker to defer
        //    to the network instead of replaying its cached UI shell.
        const testUrl = window.location.pathname + '?_cb=' + Date.now();

        const response = await fetch(testUrl, {
            method: 'GET',
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            },
            redirect: 'manual' // crucial: stops CORS from masking the 302
        });

        let isCloudflareWall = false;

        // Condition A: Cloudflare issued a 302 to its auth domain.
        // With redirect:'manual', a cross-origin redirect surfaces as 'opaqueredirect'.
        if (response.type === 'opaqueredirect') {
            isCloudflareWall = true;
        }
        // Condition B: Cloudflare served the login HTML directly (200 or 403).
        else {
            const text = await response.text();
            const lowerText = text.toLowerCase();
            if (
                lowerText.includes('<html') &&
                (lowerText.includes('cloudflareaccess.com') ||
                 lowerText.includes('cf-access'))
            ) {
                isCloudflareWall = true;
            }
        }

        log('probe result:', { responseType: response.type, status: response.status, isCloudflareWall });

        if (isCloudflareWall) {
            console.warn(
                '[cloudflare_recovery] Cloudflare Access wall detected. ' +
                'Killing Service Worker and reloading to surface the login screen.'
            );

            // Kill every Service Worker so the next request actually hits the network.
            if ('serviceWorker' in navigator) {
                const registrations = await navigator.serviceWorker.getRegistrations();
                for (const registration of registrations) {
                    await registration.unregister();
                    console.log('[cloudflare_recovery] Service Worker unregistered.');
                }
            }

            // Native reload now bypasses the (gone) SW, hits Cloudflare, and
            // gracefully drops the user onto the Cloudflare Access login page.
            window.location.reload();
            return;
        }

        // No Cloudflare wall on HTTP — but the WebSocket itself may be broken
        // (the "upgrade stripped" case, typically caused by something between
        // the browser and the origin dropping the `Upgrade: websocket` header).
        // A reload won't fix that, but we want to surface it loudly in the
        // console so the user isn't left staring at a silent dead tab.
        //
        // We probe in two situations:
        //   - WS-triggered: HA's own Connection just fired disconnected /
        //     reconnect-error. Always probe.
        //   - Cold-start / silently-stuck: the periodic poll fires and
        //     hass.connection is missing or disconnected. The WS hook can't
        //     fire in this case (no Connection to attach to), so polling is
        //     the only path that catches it.
        if (shouldProbeHandshake(reason)) {
            const handshake = await probeWebSocketHandshake();
            log('handshake probe result:', handshake);
            if (handshake.stripped) {
                const now = Date.now();
                if (now - lastStrippedLogAt > WS_STRIPPED_LOG_THROTTLE_MS) {
                    lastStrippedLogAt = now;
                    console.error(
                        '[cloudflare_recovery] WebSocket upgrade appears to be ' +
                        'stripped between the browser and Home Assistant ' +
                        '(closed code 1006 in ' + handshake.elapsedMs + ' ms, no ' +
                        '`open` event). This is NOT the cookie-expiry case — ' +
                        'reloading will not fix it. First thing to try: set ' +
                        '`--protocol=http2` in the cloudflared add-on ' +
                        '`run_parameters` if you have not already (this is the ' +
                        'most common cause). If you are already on HTTP/2 and ' +
                        'still see this, the bug is likely in a layer above ' +
                        'cloudflared and may be intermittent — check Cloudflare ' +
                        'status and retry. See ' +
                        'https://github.com/mayerwin/HA-Cloudflare-Access-Recovery' +
                        '#second-failure-mode-websocket-upgrade-stripping'
                    );
                }
                return;
            }
        }
    } catch (error) {
        // Real network errors (offline, sleeping device, etc.) throw a TypeError.
        // We swallow them so the UI doesn't reload every time Wi-Fi blips.
        log('probe threw (treated as offline, no recovery):', error.message);
    }
}

// Expose for manual testing from the DevTools console:
//   checkCloudflareWall('test')          — run the full probe pipeline.
//   probeWebSocketHandshake().then(...)  — just check the WS upgrade path.
window.checkCloudflareWall = checkCloudflareWall;
window.probeWebSocketHandshake = probeWebSocketHandshake;

// One-shot probe on load — catches the cold-start case where the tab is opened
// with an already-expired CF cookie, before HA even attempts its first WebSocket.
if (ENABLE_POLLING || ENABLE_WEBSOCKET_HOOK) {
    checkCloudflareWall('page-load');
}

// Method 1: periodic polling. Safety net for any failure mode the hook misses,
// and the only path that fires on cold-start "stuck on Loading data" before
// hass.connection exists.
if (ENABLE_POLLING) {
    log('polling enabled, interval', POLLING_INTERVAL_MS, 'ms');
    setInterval(() => checkCloudflareWall('polling-tick'), POLLING_INTERVAL_MS);
}

// Method 2: event-driven probe on HA WebSocket failure.
//
// Subclassing the global WebSocket would NOT work here: home-assistant-js-websocket
// caches a reference to the original WebSocket constructor at its own module-load
// time, before extra_module_url scripts run, so any monkey-patch lands too late
// to intercept new connections.
//
// Instead, wait for HA's Connection object to be assigned and subscribe to its
// own events. `disconnected` fires when the live WebSocket dies; `reconnect-error`
// fires on each failed reconnect attempt. Either is debounced into a single
// probe — the probe itself disambiguates a real CF wall from a transient blip
// or an HA restart, so false positives are absorbed silently.
if (ENABLE_WEBSOCKET_HOOK) {
    log('WebSocket hook enabled, debounce', WS_FAIL_DEBOUNCE_MS, 'ms');
    let probeTimer = null;
    const scheduleProbe = (reason) => {
        if (probeTimer !== null) {
            log('probe already scheduled, ignoring trigger:', reason);
            return;
        }
        log('probe scheduled, reason:', reason);
        probeTimer = setTimeout(() => {
            probeTimer = null;
            checkCloudflareWall(reason);
        }, WS_FAIL_DEBOUNCE_MS);
    };

    const tryAttach = () => {
        const conn = document.querySelector('home-assistant')?.hass?.connection;
        if (!conn) return false;
        log('attached to HA connection');
        conn.addEventListener('disconnected', () => {
            log('HA connection: disconnected');
            scheduleProbe('ha-disconnected');
        });
        conn.addEventListener('reconnect-error', (_conn, err) => {
            log('HA connection: reconnect-error', err);
            scheduleProbe('ha-reconnect-error');
        });
        return true;
    };

    // hass.connection is assigned during HA bootstrap; poll for it briefly.
    let attempts = 0;
    const maxAttempts = 60;
    const attachInterval = setInterval(() => {
        if (tryAttach()) {
            clearInterval(attachInterval);
        } else if (++attempts >= maxAttempts) {
            clearInterval(attachInterval);
            log('gave up waiting for HA connection after', maxAttempts, 'attempts — hook inactive');
        }
    }, 1000);
}
