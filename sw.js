/* Service worker: офлайн-работа и установка на телефон.
 *
 * Ничего никуда не отправляет — только кеширует. Обещание «данные не покидают браузер»
 * в силе: выгрузка пользователя сюда не попадает, кешируются лишь сама страница,
 * шрифты и библиотеки — всё своё, из /assets.
 *
 * При правках index.html поднимайте VERSION — иначе у вернувшихся пользователей
 * останется старая копия оболочки.
 *
 * v3: шрифты и библиотеки вендорнуты в /assets (раньше грузились с CDN). Теперь всё
 * same-origin — отдельная логика для CDN-хостов не нужна, её убрали. Смена версии
 * заставляет старый SW переустановиться и подчистить прежние кеши.
 */
const VERSION = 'v3';
const SHELL   = 'svetuchet-shell-' + VERSION;

const SHELL_URLS = [
  './', './index.html', './favicon.svg',
  './icon-192.png', './icon-512.png', './manifest.webmanifest',
  // критичное для работы офлайн: без библиотек приложение не считает, без CSS — без стилей
  './assets/fonts.css',
  './assets/lib/xlsx.full.min.js',
  './assets/lib/chart.umd.min.js',
];

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
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('svetuchet-') && n !== SHELL)
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

  /* Всё остальное — свои файлы (шрифты, библиотеки, иконки): кеш, потом сеть.
     Внешних ресурсов больше нет, всё вендорнуто в /assets. */
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
