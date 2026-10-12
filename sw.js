'use strict';
// Deliberately does not cache API, SSE, or audio traffic; WAVE requires a live server.
self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
