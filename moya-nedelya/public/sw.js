// Минимальный service worker: нужен, чтобы PWA считалась валидной
// и работала после установки на экран Домой. Не кэширует агрессивно —
// каждая правка кода должна доходить до тебя сразу, без залипания старой версии.
const CACHE = "moya-nedelya-v1";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Сеть в приоритете, кэш — только как офлайн-подстраховка
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
