const CACHE='evolta-casa-v1';
const ASSETS=['/','/index.html','/manifest.webmanifest','/config/assumptions.yaml','/icon.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',e=>{
  let url;
  try { url = new URL(e.request.url); } catch { return; }
  if(url.origin!==location.origin) return;
  e.respondWith(fetch(e.request).then(r=>{const copy=r.clone(); caches.open(CACHE).then(c=>c.put(e.request,copy)); return r;}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/index.html'))));
});
