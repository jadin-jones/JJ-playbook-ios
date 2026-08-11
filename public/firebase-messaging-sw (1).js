// Must sit at the ROOT of the deployed site: https://yoursite/firebase-messaging-sw.js
// This is the only thing that can raise a notification while the app is closed.
//
// Deliberately self-contained: no importScripts. Safari on iOS is unreliable
// about loading the Firebase compat SDK inside a service worker, and it isn't
// needed — getToken() only requires a registration, and an FCM push arrives
// here as a plain push event we can read ourselves.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (e) { payload = { notification: { body: event.data ? event.data.text() : '' } }; }

  const n = payload.notification || {};
  const d = payload.data || {};

  event.waitUntil(
    self.registration.showNotification(n.title || d.title || 'JJ Playbook', {
      body: n.body || d.body || '',
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      tag: 'jj-playbook',
      renotify: true,
      data: { url: d.url || n.click_action || '/' }
    })
  );
});

// Tapping the notification focuses the open app, or launches it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { try { c.navigate(url); } catch (e) {} return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
