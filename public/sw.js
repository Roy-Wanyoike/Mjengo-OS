/**
 * Service-worker kill switch.
 *
 * MjengoOS previously registered a PWA service worker. That feature was
 * removed from the platform; this no-op worker exists only so that any
 * browser still holding an old registration gets it cleanly uninstalled.
 * Browsers that never registered ignore this file entirely.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop every existing registration (including this one).
      const keys = await self.registration.unregister()
        ? ["__self__"]
        : [];
      void keys;
      // Also clear legacy caches, if any.
      if ("caches" in self) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
      await self.clients.claim();
    })()
  );
});

// No fetch handler: pass straight through to the network.
