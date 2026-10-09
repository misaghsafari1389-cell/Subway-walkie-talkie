// WAVE server — بدون نیاز به npm install. اجرا: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, MAX_TALK = 60000, MAX_USERS = 20;
const CODE = process.env.WAVE_CODE || '';               // کد دعوت (اگر خالی باشد، ورود آزاد است)
const okCode = u => !CODE || u.searchParams.get('code') === CODE;
function iceServers() {                                 // STUN رایگان + TURN اختیاری از متغیرهای محیطی
  const l = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URLS) l.push({ urls: process.env.TURN_URLS.split(',').map(x => x.trim()), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  return l;
}
const clients = new Map();
let floor = null, floorTimer = null;

const send = (c, ev, d) => c.res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
const all = (ev, d) => clients.forEach(c => send(c, ev, d));
const floorState = () => ({ holder: floor, name: floor && clients.get(floor) ? clients.get(floor).name : null });
function release(id) {
  if (floor === id) { floor = null; clearTimeout(floorTimer); all('floor', floorState()); }
}
const body = req => new Promise(r => {
  let b = '';
  req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); });
  req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } });
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/ping') { res.writeHead(200); return res.end('ok'); }
  if (u.pathname === '/ice') {
    if (!okCode(u)) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(iceServers()));
  }
  if (u.pathname === '/events') {
    if (!okCode(u)) { res.writeHead(403); return res.end(); }                       // اتصال زنده (SSE)
    if (clients.size >= MAX_USERS) { res.writeHead(503); return res.end(); }
    const c = {
      id: crypto.randomBytes(4).toString('hex'),
      token: crypto.randomBytes(12).toString('hex'),    // کلید مخفی هر کاربر
      name: (u.searchParams.get('name') || 'کاربر').slice(0, 20), res
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    send(c, 'hello', { id: c.id, token: c.token, peers: [...clients.values()].map(p => ({ id: p.id, name: p.name })), floor: floorState() });
    clients.forEach(p => send(p, 'join', { id: c.id, name: c.name }));
    clients.set(c.id, c);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {                              // بستن صفحه/قطع نت => آزاد شدن موج
      clearInterval(ping); clients.delete(c.id); release(c.id);
      all('leave', { id: c.id });
    });
    return;
  }

  if (req.method === 'POST') {
    const b = await body(req), c = clients.get(b.id);
    if (!c || c.token !== b.token) { res.writeHead(401); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (u.pathname === '/signal') {                      // رد و بدل پیام‌های WebRTC
      const t = clients.get(b.to);
      if (t) send(t, 'signal', { from: c.id, data: b.data });
      return res.end('{}');
    }
    if (u.pathname === '/ptt') {                         // مدیریت نوبت صحبت (سمت سرور)
      if (b.action === 'down') {
        if (!floor) {
          floor = c.id;
          floorTimer = setTimeout(() => { const h = clients.get(floor); if (h) send(h, 'revoked', {}); release(floor); }, MAX_TALK);
          all('floor', floorState());
          return res.end(JSON.stringify({ granted: true }));
        }
        return res.end(JSON.stringify({ granted: floor === c.id, holder: floor }));
      }
      release(c.id);
    }
    return res.end('{}');
  }

  fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
    if (e) { res.writeHead(404); return res.end('index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(d);
  });
}).listen(PORT, () => console.log('WAVE running: http://localhost:' + PORT));
