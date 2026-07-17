/* Service worker: офлайн-работа и установка на телефон.
 *
 * Ничего никуда не отправляет — только кеширует. Обещание «данные не покидают браузер»
 * в силе: выгрузка пользователя сюда не попадает, кешируются лишь сама страница
 * и библиотеки с CDN.
 *
 * При правках index.html поднимайте VERSION — иначе у вернувшихся пользователей
 * останется старая копия оболочки.
 */
const VERSION = 'v1';
const SHELL   = 'svetuchet-shell-' + VERSION;
const RUNTIME = 'svetuchet-cdn-' + VERSION;

const SHELL_URLS = [
  './', './index.html', './favicon.svg',
  './icon-192.png', './icon-512.png', './manifest.webmanifest',
];

/* Версии зафиксированы прямо в URL (chart.js@4.4.4 и т.п.), поэтому содержимое
   неизменно и его можно держать в кеше сколь угодно долго. */
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // по одному, а не addAll: один недоступный файл не должен рушить всю установку
    await Promise.all(SHELL_URLS.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [SHELL, RUNTIME];
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('svetuchet-') && !keep.includes(n))
                           .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* Страница: сначала сеть, чтобы правки доезжали сразу; офлайн — из кеша. */
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(SHELL);
        c.put('./index.html', fresh.clone());
        return fresh;
      } catch (_) {
        return (await caches.match('./index.html')) || new Response(
          'Нет сети, а сохранённой копии не нашлось. Откройте страницу онлайн хотя бы раз.',
          {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
      }
    })());
    return;
  }

  /* Библиотеки и шрифты с CDN: сначала кеш — они неизменны. */
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        // opaque (шрифты, стили без CORS) кладём тоже: статус не прочесть, но отдать можно
        if (res.ok || res.type === 'opaque') (await caches.open(RUNTIME)).put(req, res.clone());
        return res;
      } catch (_) {
        return new Response('', {status: 504});
      }
    })());
    return;
  }

  /* Свои файлы: кеш, потом сеть. */
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
        return res;
      } catch (_) {
        return new Response('', {status: 504});
      }
    })());
  }
});
