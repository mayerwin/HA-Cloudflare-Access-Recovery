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
// What this script does, every 60 seconds:
//   1. Fetches the current page with a cache-busting query string + no-cache
//      headers, forcing the Service Worker to actually hit the network.
//   2. Uses `redirect: 'manual'` so a Cloudflare 302 surfaces as
//      `response.type === 'opaqueredirect'` instead of being swallowed by CORS.
//   3. As a fallback, sniffs the response body for the Cloudflare Access login
//      HTML markers ("cloudflareaccess.com" or "cf-access").
//   4. On detection: unregisters every Service Worker and calls
//      `window.location.reload()`. With the SW gone, the browser hits the
//      network natively, Cloudflare returns its real 302, and you land on the
//      Cloudflare Access login page. After login, you're back in HA.
// -----------------------------------------------------------------------------

async function checkCloudflareWall() {
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
        }
    } catch (error) {
        // Real network errors (offline, sleeping device, etc.) throw a TypeError.
        // We swallow them so the UI doesn't reload every time Wi-Fi blips.
        // Uncomment for debugging:
        // console.debug('[cloudflare_recovery] benign network error:', error);
    }
}

// Run once on load, then every 60 seconds.
checkCloudflareWall();
setInterval(checkCloudflareWall, 60000);
