// Service Worker ChatView Mobile
const CACHE_NAME = 'chatview-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

// Recevoir une notification push
self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'ChatView';
  const options = {
    body: data.body || 'Nouveau message',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
    tag: data.channelId || 'message',
    renotify: true,
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Clic sur la notification → ouvrir l'app
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list.length > 0) {
        return list[0].focus();
      }
      return clients.openWindow(e.notification.data?.url || '/');
    })
  );
});
