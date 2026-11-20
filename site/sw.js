// Market Pulse service worker: only handles notifications (no offline caching,
// so new app versions still load right away).
//
// A notification carries the message itself (encrypted end to end by Web Push).
// We keep a copy in the "mp-inbox" cache, so the app's 🔔 inbox shows it at once,
// even before the next data update has picked it up.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function bumpBadge(cache) {
  try {
    const old = await cache.match("badge");
    const n = (old ? Number(await old.text()) : 0) + 1;
    await cache.put("badge", new Response(String(n)));
    if (self.navigator.setAppBadge) await self.navigator.setAppBadge(n);
  } catch (e) { /* badges are optional */ }
}

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "Market Pulse", body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    // iPhones require a visible notification for every push, so this always comes first.
    await self.registration.showNotification(d.title || "Market Pulse", {
      body: d.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png",
      tag: d.id || undefined, data: { url: d.url || "#/inbox" },
    });
    const cache = await caches.open("mp-inbox");
    if (d.item && d.item.id) {
      await cache.put(`pushed/${encodeURIComponent(d.item.id)}`,
        new Response(JSON.stringify(d.item), { headers: { "content-type": "application/json" } }));
    }
    await bumpBadge(cache);
    for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) c.postMessage({ pushed: true });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const hash = (e.notification.data && e.notification.data.url) || "#/inbox";
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.length) {
      const w = wins[0];
      w.postMessage({ open: hash });
      return w.focus();
    }
    return self.clients.openWindow(new URL(`./${hash}`, self.registration.scope).href);
  })());
});
