const C='wave-v4';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['/icon-192.png','/icon-512.png'])));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url); if(r.method!=='GET'||u.origin!==location.origin)return;
  if(r.mode==='navigate'){e.respondWith(fetch(r).then(x=>{const y=x.clone();caches.open(C).then(c=>c.put('/',y));return x}).catch(()=>caches.match('/')));return}
  if(u.pathname.startsWith('/icon'))e.respondWith(caches.match(r).then(x=>x||fetch(r)));
});
