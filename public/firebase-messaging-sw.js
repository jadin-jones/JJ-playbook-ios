self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = {}; }
  var n = payload.notification || {};
  var d = payload.data || {};
  event.waitUntil(
    self.registration.showNotification(n.title || d.title || 'JJ Playbook', {
      body: n.body || d.body || '',
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      tag: 'jj-playbook',
      data: { url: d.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if ('focus' in list[i]) return list[i].focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
