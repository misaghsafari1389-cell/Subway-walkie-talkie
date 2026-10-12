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
const ADMIN = process.env.WAVE_ADMIN || '';                 // رمز مدیر (اگر خالی باشد، مدیریت غیرفعال است)
const banned = new Set();                                    // دستگاه‌های اخراج‌شده؛ با ری‌استارت سرور پاک می‌شود
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const byId = new Map(), rooms = new Map();
const clean = s => String(s || '').replace(/[^\w\u0600-\u06FF-]/g, '').slice(0, 20) || 'main';
const uniq = (r, s) => { let nm = String(s || 'کاربر').slice(0, 24), b = nm, k = 2; const t = new Set([...r.m.values()].map(p => p.name)); while (t.has(nm)) nm = b + ' ' + k++; return nm; };
const room = n => { if (!rooms.has(n)) rooms.set(n, { n, m: new Map(), floor: null, t: null }); return rooms.get(n); };
const send = (c, ev, d) => c.res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
const all = (r, ev, d) => r.m.forEach(c => send(c, ev, d));
const fst = r => ({ holder: r.floor, name: r.floor && r.m.get(r.floor) ? r.m.get(r.floor).name : null });
function grant(r, c) {
  r.floor = c.id; clearTimeout(r.t);
  r.t = setTimeout(() => { const h = r.m.get(r.floor); if (h) send(h, 'revoked', {}); release(r, r.floor); }, MAX_TALK);
  all(r, 'floor', fst(r));
}
function release(r, id) {
  if (r.floor !== id) return;
  r.floor = null; clearTimeout(r.t); all(r, 'floor', fst(r));
  const q = r.sosQ && r.m.get(r.sosQ); r.sosQ = null;       // اضطراری منتظر: نوبت بعدی مال اوست
  if (q) { grant(r, q); send(q, 'sosgrant', {}); }
}
const body = req => new Promise(ok => {
  let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); });
  req.on('end', () => { try { ok(JSON.parse(b)); } catch { ok({}); } });
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/ping') { res.writeHead(200); return res.end('ok'); }
  if (['/ice', '/channels', '/events'].includes(u.pathname) && !okCode(u)) { res.writeHead(403); return res.end(); }
  if (['/ice', '/events'].includes(u.pathname) && banned.has(u.searchParams.get('cid') || '')) { res.writeHead(403); return res.end('banned'); }
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
      name: uniq(r, u.searchParams.get('name')), cid: String(u.searchParams.get('cid') || '').slice(0, 32), res, room: r };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    send(c, 'hello', { id: c.id, token: c.token, name: c.name, peers: [...r.m.values()].map(p => ({ id: p.id, name: p.name })), floor: fst(r) });
    all(r, 'join', { id: c.id, name: c.name });
    r.m.set(c.id, c); byId.set(c.id, c);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping); if (c.ws) c.ws.destroy(); r.m.delete(c.id); byId.delete(c.id); release(r, c.id);
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
    if (u.pathname === '/announce') {                    // «پاور آن» برای همهٔ کانال (فقط وقتی موج آزاد است)
      if (!r.floor && Date.now() - (c.lastA || 0) > 3000) { c.lastA = Date.now(); all(r, 'announce', { kind: 'power', name: c.name }); }
      return res.end('{}');
    }
    if (u.pathname === '/call') {                         // زنگ هشدار به یک نفر
      const t = r.m.get(b.to);
      if (t && t !== c && Date.now() - (c.lastC || 0) > 3000) { c.lastC = Date.now(); send(t, 'call', { name: c.name }); }
      return res.end('{}');
    }
    if (u.pathname === '/sos') {                          // اضطراری: آژیر برای همه + نوبت اولویت‌دار
      if (Date.now() - (c.lastS || 0) > 5000) {
        c.lastS = Date.now(); all(r, 'sos', { name: c.name });
        if (!r.floor) { grant(r, c); send(c, 'sosgrant', {}); } else if (r.floor !== c.id) r.sosQ = c.id;
      }
      return res.end('{}');
    }
    if (u.pathname === '/admin') {
      c.badA = c.badA || 0;
      if (!ADMIN || c.badA >= 5 || !safeEq(b.pass || '', ADMIN)) { c.badA++; return res.end(JSON.stringify({ ok: false })); }
      c.admin = true; return res.end(JSON.stringify({ ok: true }));
    }
    if (u.pathname === '/kick') {                         // فقط مدیر؛ تا پایان همین جلسه (ری‌استارت سرور)
      const t = byId.get(b.target);
      if (!c.admin || !t || t === c) return res.end(JSON.stringify({ ok: false }));
      if (t.cid) banned.add(t.cid);
      try { send(t, 'kicked', {}); } catch {}
      setTimeout(() => { if (t.ws) t.ws.destroy(); t.res.destroy(); }, 200);
      return res.end(JSON.stringify({ ok: true }));
    }
    if (u.pathname === '/unban') { if (c.admin) banned.clear(); return res.end('{}'); }
    if (u.pathname === '/ptt') {
      if (b.action === 'down') {
        if (!r.floor) {
          grant(r, c);
          return res.end(JSON.stringify({ granted: true }));
        }
        return res.end(JSON.stringify({ granted: r.floor === c.id, holder: r.floor }));
      }
      release(r, c.id);
    }
    return res.end('{}');
  }
  const F = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/sw.js': ['sw.js', 'text/javascript'],
    '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'] }[u.pathname];
  if (!F) { res.writeHead(404); return res.end(); }
  fs.readFile(path.join(__dirname, F[0]), (e, d) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': F[1], 'Cache-Control': 'no-cache' }); res.end(d);
  });
});

// ---- رله صدا: WebSocket دستی. فقط فریم‌های دارندهٔ نوبت صحبت به بقیهٔ کانال می‌رسد ----
const WSGUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(op, p) {
  const n = p.length, h = n < 126 ? Buffer.from([0x80 | op, n]) : Buffer.from([0x80 | op, 126, n >> 8, n & 255]);
  return Buffer.concat([h, p]);
}
server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x'), key = req.headers['sec-websocket-key'];
  const c = byId.get(u.searchParams.get('id'));
  if (u.pathname !== '/ws' || !c || c.token !== u.searchParams.get('token') || !key) { sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return sock.destroy(); }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(key + WSGUID).digest('base64') + '\r\n\r\n');
  if (c.ws) c.ws.destroy();
  c.ws = sock;
  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (buf.length > 1 << 20) return sock.destroy();
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15, masked = buf[1] & 128; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let p = buf.subarray(off, off + len);
      if (masked) { const m = buf.subarray(off - 4, off), q = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) q[i] = p[i] ^ m[i & 3]; p = q; }
      buf = buf.subarray(off + len);
      if (op === 8) return sock.destroy();
      if (op === 9) sock.write(frame(10, p));
      if (op === 2 && p.length > 0 && p.length <= 4096 && c.room.floor === c.id)
        c.room.m.forEach(o => { if (o !== c && o.ws && !o.ws.destroyed) o.ws.write(frame(2, p)); });
    }
  });
  sock.on('close', () => { if (c.ws === sock) c.ws = null; });
  sock.on('error', () => {});
});
server.listen(PORT, () => console.log('WAVE v9 (audio relay) on port ' + PORT));
