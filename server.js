// WAVE — نسخهٔ پایدارسازی‌شدهٔ رلهٔ صوتی و مدیریت نوبت صحبت
// اجرا: node server.js | تنظیمات اختیاری: PORT, WAVE_CODE, WAVE_ADMIN, TURN_URLS, TURN_USER, TURN_PASS
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const MAX_TALK = 60_000, MAX_ROOM = 20, MAX_ROOMS = 10, MAX_ALL = 60;
const MAX_BODY = 64 * 1024, MAX_WS_FRAME = 4096;
const CODE = String(process.env.WAVE_CODE || '');
const ADMIN = String(process.env.WAVE_ADMIN || '');
const byId = new Map(), rooms = new Map(), banned = new Set(), ipRates = new Map(), accessSessions = new Map();
const safeEq = (a,b) => { const x=Buffer.from(String(a)), y=Buffer.from(String(b)); return x.length===y.length && crypto.timingSafeEqual(x,y); };
function cookieValue(req,name){const raw=String(req.headers.cookie||'');for(const part of raw.split(';')){const i=part.indexOf('=');if(i>0&&part.slice(0,i).trim()===name)return decodeURIComponent(part.slice(i+1).trim())}return ''}
function hasAccess(req,u){if(!CODE)return true;const header=String(req.headers['x-wave-code']||'');if(header&&safeEq(header,CODE))return true;const sid=cookieValue(req,'wave_access'),entry=accessSessions.get(sid);if(entry&&entry.expires>Date.now())return true;return false}
function issueAccessCookie(req,res){if(!CODE)return;const sid=crypto.randomBytes(32).toString('hex');accessSessions.set(sid,{expires:Date.now()+12*60*60*1000});for(const [k,v] of accessSessions)if(v.expires<=Date.now())accessSessions.delete(k);const secure=String(req.headers['x-forwarded-proto']||'').includes('https')?' Secure;':'';res.setHeader('Set-Cookie',`wave_access=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200;${secure}`)}
const clean = s => String(s || '').normalize('NFKC').replace(/[\u064A\u0649]/g,'ی').replace(/\u0643/g,'ک').replace(/[^\w\u0600-\u06FF-]/g,'').slice(0,20) || 'main';
const cleanName = s => String(s || 'کاربر').normalize('NFKC').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,24) || 'کاربر';
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
function rateLimit(key, limit=60, windowMs=60_000) {
  const now=Date.now(); let x=ipRates.get(key);
  if(!x || now-x.start>=windowMs) x={start:now,n:0};
  x.n++; ipRates.set(key,x);
  if(ipRates.size>5000) for(const [k,v] of ipRates) if(now-v.start>windowMs*2) ipRates.delete(k);
  return x.n<=limit;
}
function iceServers(){
  const list=[{urls:'stun:stun.l.google.com:19302'}];
  if(process.env.TURN_URLS) list.push({urls:process.env.TURN_URLS.split(',').map(x=>x.trim()).filter(Boolean),username:process.env.TURN_USER||'',credential:process.env.TURN_PASS||''});
  return list;
}
const send=(c,ev,d)=>{ if(!c || c.res.destroyed || c.res.writableEnded) return; try{c.res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`)}catch{} };
const all=(r,ev,d)=>r.m.forEach(c=>send(c,ev,d));
const fst=r=>({holder:r.floor,name:r.floor&&r.m.get(r.floor)?r.m.get(r.floor).name:null});
const room=n=>{if(!rooms.has(n))rooms.set(n,{n,m:new Map(),floor:null,t:null,sosQ:[]});return rooms.get(n)};
const uniq=(r,s)=>{const base=cleanName(s);let nm=base,k=2;const used=new Set([...r.m.values()].map(p=>p.name));while(used.has(nm))nm=(base.slice(0,Math.max(1,24-String(k).length-1))+' '+k++).slice(0,24);return nm};
function grant(r,c){ if(!c||!r.m.has(c.id))return false; r.floor=c.id; clearTimeout(r.t); r.t=setTimeout(()=>{const h=r.m.get(r.floor);if(h)send(h,'revoked',{});release(r,r.floor)},MAX_TALK); all(r,'floor',fst(r)); return true; }
function release(r,id){
  if(r.floor!==id)return;
  r.floor=null;clearTimeout(r.t);r.t=null;all(r,'floor',fst(r));
  while(r.sosQ.length){const nextId=r.sosQ.shift(),next=r.m.get(nextId);if(next){grant(r,next);send(next,'sosgrant',{});break}}
}
function removeClient(c){
  if(!c || c.closed)return; c.closed=true; clearInterval(c.ping);
  const r=c.room; if(c.ws && !c.ws.destroyed)try{c.ws.destroy()}catch{}
  r.m.delete(c.id);byId.delete(c.id);r.sosQ=r.sosQ.filter(id=>id!==c.id);
  release(r,c.id);all(r,'leave',{id:c.id});
  if(!r.m.size && r.n!=='main')rooms.delete(r.n);
}
function readBody(req){return new Promise((resolve,reject)=>{let b='',done=false;req.on('data',d=>{if(done)return;b+=d.toString('utf8');if(b.length>MAX_BODY){done=true;reject(Object.assign(new Error('body too large'),{status:413}));req.destroy()}});req.on('end',()=>{if(done)return;try{const x=JSON.parse(b||'{}');if(!x||typeof x!=='object'||Array.isArray(x))throw 0;resolve(x)}catch{reject(Object.assign(new Error('invalid json'),{status:400}))}});req.on('error',e=>{if(!done)reject(e)})})}
function json(res,status,obj){if(res.headersSent)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj))}
function text(res,status,msg=''){if(res.headersSent)return;res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(msg)}
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost'), ip=clientIp(req);
  if(!rateLimit(ip+':http',180,60_000))return text(res,429,'rate limited');
  if(req.method==='GET' && u.pathname==='/ping')return text(res,200,'ok');
  if(['GET /ice','GET /channels','GET /events'].includes(req.method+' '+u.pathname) && !hasAccess(req,u))return text(res,403,'invalid invite code');
  if(['GET /ice','GET /events'].includes(req.method+' '+u.pathname) && banned.has(String(u.searchParams.get('cid')||'')))return text(res,403,'banned');
  if(req.method==='GET' && u.pathname==='/ice'){issueAccessCookie(req,res);return json(res,200,iceServers())}
  if(req.method==='GET' && u.pathname==='/channels'){
    const list=[...new Set(['main',...rooms.keys()])].map(n=>({name:n,n:rooms.has(n)?rooms.get(n).m.size:0}));return json(res,200,list);
  }
  if(req.method==='GET' && u.pathname==='/events'){
    const n=clean(u.searchParams.get('ch')||'main');
    if(byId.size>=MAX_ALL || (!rooms.has(n)&&rooms.size>=MAX_ROOMS) || (rooms.has(n)&&rooms.get(n).m.size>=MAX_ROOM))return text(res,503,'room capacity reached');
    const r=room(n), cid=String(u.searchParams.get('cid')||'').slice(0,64);
    const c={id:crypto.randomBytes(12).toString('hex'),token:crypto.randomBytes(32).toString('hex'),name:uniq(r,u.searchParams.get('name')),cid,res,room:r,closed:false,badA:0,admin:false};
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
    res.write('retry: 5000\n\n');
    send(c,'hello',{id:c.id,token:c.token,name:c.name,peers:[...r.m.values()].map(p=>({id:p.id,name:p.name})),floor:fst(r)});
    r.m.set(c.id,c);byId.set(c.id,c);all(r,'join',{id:c.id,name:c.name});
    c.ping=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)try{res.write(': ping\n\n')}catch{}},15000);
    res.on('close',()=>removeClient(c));
    return;
  }
  if(req.method==='POST'){
    let b;try{b=await readBody(req)}catch(e){return text(res,e.status||400,e.status===413?'payload too large':'invalid json')}
    const c=byId.get(String(b.id||''));
    if(!c || c.closed || !safeEq(b.token||'',c.token))return json(res,401,{ok:false,error:'unauthorized'});
    const r=c.room;
    if(u.pathname==='/signal'){
      if(!rateLimit(c.id+':signal',120,10_000))return json(res,429,{ok:false});
      const t=r.m.get(String(b.to||'')); if(!t)return json(res,404,{ok:false});
      if(!b.data||typeof b.data!=='object'||JSON.stringify(b.data).length>20_000)return json(res,400,{ok:false});
      send(t,'signal',{from:c.id,data:b.data});return json(res,200,{ok:true});
    }
    if(u.pathname==='/announce'){if(!r.floor&&Date.now()-(c.lastA||0)>3000){c.lastA=Date.now();all(r,'announce',{kind:'power',name:c.name})}return json(res,200,{ok:true})}
    if(u.pathname==='/call'){const t=r.m.get(String(b.to||''));if(t&&t!==c&&Date.now()-(c.lastC||0)>3000){c.lastC=Date.now();send(t,'call',{name:c.name})}return json(res,200,{ok:true})}
    if(u.pathname==='/sos'){
      if(Date.now()-(c.lastS||0)>5000){c.lastS=Date.now();all(r,'sos',{name:c.name});if(!r.floor){grant(r,c);send(c,'sosgrant',{})}else if(r.floor!==c.id&&!r.sosQ.includes(c.id))r.sosQ.push(c.id)}
      return json(res,200,{ok:true,queued:r.sosQ.includes(c.id),granted:r.floor===c.id});
    }
    if(u.pathname==='/admin'){
      if(!ADMIN)return json(res,403,{ok:false,error:'admin disabled'});
      if(!rateLimit(ip+':admin',8,60_000)||c.badA>=5)return json(res,429,{ok:false});
      if(!safeEq(b.pass||'',ADMIN)){c.badA++;return json(res,403,{ok:false})}
      c.admin=true;c.adminAt=Date.now();return json(res,200,{ok:true});
    }
    if(u.pathname==='/kick'){
      if(!c.admin||Date.now()-(c.adminAt||0)>8*60*60*1000)return json(res,403,{ok:false});
      const t=byId.get(String(b.target||''));if(!t||t===c)return json(res,400,{ok:false});
      if(t.cid)banned.add(t.cid);send(t,'kicked',{});setTimeout(()=>{try{t.res.destroy()}catch{};if(t.ws)try{t.ws.destroy()}catch{}},100);return json(res,200,{ok:true});
    }
    if(u.pathname==='/unban'){if(!c.admin)return json(res,403,{ok:false});banned.clear();return json(res,200,{ok:true})}
    if(u.pathname==='/ptt'){
      if(b.action==='down'){
        if(r.floor===c.id)return json(res,200,{granted:true,holder:c.id});
        if(!r.floor){grant(r,c);return json(res,200,{granted:true,holder:c.id})}
        return json(res,200,{granted:false,holder:r.floor});
      }
      release(r,c.id);return json(res,200,{ok:true});
    }
    return json(res,404,{ok:false,error:'not found'});
  }
  if(req.method!=='GET')return text(res,405,'method not allowed');
  const files={'/':'index.html','/index.html':'index.html','/manifest.webmanifest':'manifest.webmanifest','/sw.js':'sw.js','/icon-192.png':'icon-192.png','/icon-512.png':'icon-512.png'};
  const name=files[u.pathname];if(!name)return text(res,404,'not found');
  const types={'index.html':'text/html; charset=utf-8','manifest.webmanifest':'application/manifest+json','sw.js':'text/javascript; charset=utf-8','icon-192.png':'image/png','icon-512.png':'image/png'};
  fs.readFile(path.join(__dirname,name),(err,data)=>{if(err)return text(res,404,'not found');res.writeHead(200,{'Content-Type':types[name],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(data)});
});

// WebSocket relay: masked client frames, strict frame limits, and holder-only audio relay.
const WSGUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(op,p){const n=p.length;if(n<126)return Buffer.concat([Buffer.from([0x80|op,n]),p]);if(n<=65535){const h=Buffer.alloc(4);h[0]=0x80|op;h[1]=126;h.writeUInt16BE(n,2);return Buffer.concat([h,p])}throw new Error('frame too large')}
server.on('upgrade',(req,sock)=>{
  const u=new URL(req.url,'http://localhost'),key=req.headers['sec-websocket-key'],c=byId.get(u.searchParams.get('id'));
  if(u.pathname!='/ws'||!c||c.closed||!safeEq(c.token,u.searchParams.get('token')||'')||!key||!rateLimit(clientIp(req)+':ws',30,60_000)){sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return sock.destroy()}
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+crypto.createHash('sha1').update(key+WSGUID).digest('base64')+'\r\n\r\n');
  if(c.ws&&c.ws!==sock)try{c.ws.destroy()}catch{};c.ws=sock;let buf=Buffer.alloc(0);
  sock.on('data',d=>{
    buf=Buffer.concat([buf,d]);if(buf.length>MAX_WS_FRAME+14)return sock.destroy();
    for(;;){if(buf.length<2)return;const b0=buf[0],b1=buf[1],op=b0&15,masked=!!(b1&128);if(!(b0&128)||!masked)return sock.destroy();let len=b1&127,off=2;
      if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);off=4}else if(len===127){return sock.destroy()}
      if(len>MAX_WS_FRAME)return sock.destroy();if(buf.length<off+4+len)return;const mask=buf.subarray(off,off+4);off+=4;const payload=Buffer.from(buf.subarray(off,off+len));for(let i=0;i<payload.length;i++)payload[i]^=mask[i&3];buf=buf.subarray(off+len);
      if(op===8){try{sock.end(frame(8,Buffer.alloc(0)))}catch{}return}
      if(op===9){try{sock.write(frame(10,payload))}catch{}continue}
      if(op===10)continue;
      if(op!==2)return sock.destroy();
      if(payload.length&&c.room.floor===c.id){for(const peer of c.room.m.values())if(peer!==c&&peer.ws&&!peer.ws.destroyed){try{peer.ws.write(frame(2,payload))}catch{try{peer.ws.destroy()}catch{}}}}
    }
  });
  sock.on('close',()=>{if(c.ws===sock)c.ws=null});sock.on('error',()=>{});
});
server.on('clientError',(_err,sock)=>{try{sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')}catch{}});
server.listen(PORT,()=>console.log(`WAVE stable relay listening on ${PORT}`));
