// WAVE v2 — چند کانال، هر کانال موج و نوبت صحبت جدا. بدون npm install.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, MAX_TALK = 60000, MAX_ROOM = 20, MAX_ROOMS = 10, MAX_ALL = 60;
const CODE = process.env.WAVE_CODE || '';
const okCode = u => !CODE || u.searchParams.get('code') === CODE;
function iceServers() {
  const l = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URLS) l.push({ urls: process.env.TURN_URLS.split(',').map(x => x.trim()), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  return l;
}
const byId = new Map(), rooms = new Map();
const clean = s => String(s || '').replace(/[^\w\u0600-\u06FF-]/g, '').slice(0, 20) || 'main';
const room = n => { if (!rooms.has(n)) rooms.set(n, { n, m: new Map(), floor: null, t: null }); return rooms.get(n); };
const send = (c, ev, d) => c.res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
const all = (r, ev, d) => r.m.forEach(c => send(c, ev, d));
const fst = r => ({ holder: r.floor, name: r.floor && r.m.get(r.floor) ? r.m.get(r.floor).name : null });
function release(r, id) { if (r.floor === id) { r.floor = null; clearTimeout(r.t); all(r, 'floor', fst(r)); } }
const body = req => new Promise(ok => {
  let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); });
  req.on('end', () => { try { ok(JSON.parse(b)); } catch { ok({}); } });
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/ping') { res.writeHead(200); return res.end('ok'); }
  if (['/ice', '/channels', '/events'].includes(u.pathname) && !okCode(u)) { res.writeHead(403); return res.end(); }
  if (u.pathname === '/ice') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(iceServers())); }
  if (u.pathname === '/channels') {
    const l = [...new Set(['main', ...rooms.keys()])].map(n => ({ name: n, n: rooms.has(n) ? rooms.get(n).m.size : 0 }));
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(l));
  }
  if (u.pathname === '/events') {
    const n = clean(u.searchParams.get('ch') || 'main');
    if (byId.size >= MAX_ALL || (!rooms.has(n) && rooms.size >= MAX_ROOMS) || (rooms.has(n) && rooms.get(n).m.size >= MAX_ROOM)) { res.writeHead(503); return res.end(); }
    const r = room(n);
    const c = { id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(12).toString('hex'),
      name: (u.searchParams.get('name') || 'کاربر').slice(0, 20), res, room: r };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    send(c, 'hello', { id: c.id, token: c.token, peers: [...r.m.values()].map(p => ({ id: p.id, name: p.name })), floor: fst(r) });
    all(r, 'join', { id: c.id, name: c.name });
    r.m.set(c.id, c); byId.set(c.id, c);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping); r.m.delete(c.id); byId.delete(c.id); release(r, c.id);
      all(r, 'leave', { id: c.id });
      if (!r.m.size && n !== 'main') rooms.delete(n);
    });
    return;
  }
  if (req.method === 'POST') {
    const b = await body(req), c = byId.get(b.id);
    if (!c || c.token !== b.token) { res.writeHead(401); return res.end('{}'); }
    const r = c.room;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (u.pathname === '/signal') { const t = r.m.get(b.to); if (t) send(t, 'signal', { from: c.id, data: b.data }); return res.end('{}'); }
    if (u.pathname === '/ptt') {
      if (b.action === 'down') {
        if (!r.floor) {
          r.floor = c.id;
          r.t = setTimeout(() => { const h = r.m.get(r.floor); if (h) send(h, 'revoked', {}); release(r, r.floor); }, MAX_TALK);
          all(r, 'floor', fst(r));
          return res.end(JSON.stringify({ granted: true }));
        }
        return res.end(JSON.stringify({ granted: r.floor === c.id, holder: r.floor }));
      }
      release(r, c.id);
    }
    return res.end('{}');
  }
  fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
    if (e) { res.writeHead(404); return res.end('index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
  });
}).listen(PORT, () => console.log('WAVE v2 on port ' + PORT));
