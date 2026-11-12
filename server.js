'use strict';
/* AirBill server - Node.js 22.5+ with built-in SQLite. No npm install needed. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), net = require('net'), tls = require('tls');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const MPESA_SECRET = process.env.MPESA_SECRET || '';   // set this to enable the M-Pesa callback URL
const H = 36e5, D = 24 * H, WINDOW = 48 * H;
// SMS via Africa's Talking (use AT_USERNAME=sandbox for testing)
const AT_USER = process.env.AT_USERNAME || '', AT_KEY = process.env.AT_API_KEY || '', AT_FROM = process.env.AT_SENDER_ID || '';
const SMS_ON = !!(AT_USER && AT_KEY);
const AT_URL = process.env.AT_URL || (AT_USER === 'sandbox' ? 'https://api.sandbox.africastalking.com/version1/messaging' : 'https://api.africastalking.com/version1/messaging');
const AUTO_REMINDERS = process.env.AUTO_REMINDERS === '1';
const MT_ON = process.env.MIKROTIK_SYNC === '1';   // automatic MikroTik sync (manual Test/Sync buttons always work)

/* ---------- database ---------- */
const db = new DatabaseSync(path.join(ROOT, 'airbill.db'));
const TABLES = { // collection -> [table, unique-key function]
  plans: ['plans', null], customers: ['customers', c => c.account], subs: ['subs', null],
  payments: ['payments', p => p.mpesaId], messages: ['messages', null], routers: ['routers', null], payModes: ['pay_modes', null]
};
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL,role TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS sms_log(message_id TEXT PRIMARY KEY,status TEXT NOT NULL,detail TEXT,attempts INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL);`);
for (const [t] of Object.values(TABLES)) db.exec(`CREATE TABLE IF NOT EXISTS ${t}(id TEXT PRIMARY KEY,k TEXT,data TEXT NOT NULL)`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_k ON customers(k); CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_k ON payments(k);');

const getMeta = (k, d) => { const r = db.prepare('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : d; };
const setMeta = (k, v) => db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));

function loadDb() {
  const out = { counter: Number(getMeta('counter', 10000)), _rev: Number(getMeta('rev', 0)) };
  for (const [name, [t]] of Object.entries(TABLES)) out[name] = db.prepare(`SELECT data FROM ${t} ORDER BY rowid`).all().map(r => JSON.parse(r.data));
  const st = new Map(db.prepare('SELECT message_id,status FROM sms_log').all().map(r => [r.message_id, r.status]));
  out.messages.forEach(m => { if (st.has(m.id)) m.sms = st.get(m.id); });
  return out;
}
function saveDb(d) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [name, [t, key]] of Object.entries(TABLES)) {
      db.exec(`DELETE FROM ${t}`);
      const ins = db.prepare(`INSERT INTO ${t}(id,k,data) VALUES(?,?,?)`);
      for (const item of d[name]) ins.run(String(item.id), key ? String(key(item)) : null, JSON.stringify(item, (k, v) => (k === 'sms' ? undefined : v)));
    }
    setMeta('counter', Number(d.counter) || 10000);
    setMeta('rev', Number(getMeta('rev', 0)) + 1);
    db.exec('COMMIT');
    if (MT_ON) scheduleSync();
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) { } throw e; }
}
const validDb = d => d && typeof d === 'object' && Object.keys(TABLES).every(n => Array.isArray(d[n]) && d[n].every(i => i && typeof i === 'object' && i.id));

/* ---------- auth ---------- */
const uid = p => p + crypto.randomBytes(5).toString('hex');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex'))));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const pub = u => u && ({ id: u.id, name: u.name, email: u.email, role: u.role });
const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;

function cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function sessionUser(req) {
  const t = cookies(req).sid; if (!t) return null;
  const r = db.prepare('SELECT u.*, s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(sha(t));
  if (!r) return null;
  if (r.expires < Date.now()) { db.prepare('DELETE FROM sessions WHERE token=?').run(sha(t)); return null; }
  return r;
}
function startSession(req, res, user, remember) {
  const t = crypto.randomBytes(32).toString('hex'), life = remember ? 30 * D : 12 * H;
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(sha(t), user.id, Date.now() + life);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/${secure}${remember ? '; Max-Age=' + Math.floor(life / 1000) : ''}`);
}
const tries = new Map(); // simple login rate limit: 10 tries / 10 min / IP
function throttled(ip) {
  const now = Date.now(), a = (tries.get(ip) || []).filter(t => now - t < 6e5);
  tries.set(ip, a); return a.length >= 10;
}

/* ---------- M-Pesa (Daraja C2B) ---------- */
const durMs = p => (p.durationUnit === 'hours' ? H : p.durationUnit === 'months' ? 30 * D : D) * Number(p.durationValue || 1);
const money = n => 'KES ' + Number(n || 0).toLocaleString('en-KE');
const dt = iso => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function mpesaPayment(b) {
  const d = loadDb();
  const mpesaId = String(b.TransID || '').toUpperCase(), amount = Number(b.TransAmount), acc = String(b.BillRefNumber || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(mpesaId) || !(amount > 0)) return;
  if (d.payments.some(p => p.mpesaId === mpesaId)) return;            // duplicate callback
  const c = d.customers.find(x => x.account === acc);
  const pay = { id: uid('y'), mpesaId, amount, account: acc, customerId: c ? c.id : null, phone: String(b.MSISDN || ''), planId: c ? c.planId : null, date: new Date().toISOString() };
  d.payments.push(pay);
  const plan = c && d.plans.find(p => p.id === c.planId);
  if (c && plan && amount >= Number(plan.price)) {
    const cur = d.subs.filter(s => s.customerId === c.id).sort((a, z) => new Date(z.expiry) - new Date(a.expiry))[0];
    const running = cur && new Date(cur.expiry) > Date.now();
    const base = running ? new Date(cur.expiry).getTime() : Date.now();
    const sub = { id: uid('s'), customerId: c.id, planId: plan.id, start: running ? cur.start : new Date().toISOString(), expiry: new Date(base + durMs(plan)).toISOString() };
    d.subs.push(sub);
    d.messages.push({ id: uid('g'), customerId: c.id, phone: c.phone, type: 'subscribed', date: new Date().toISOString(),
      text: `Hi ${c.name.split(' ')[0]}, your ${plan.name} package (${money(plan.price)}) is now active until ${dt(sub.expiry)}. Account No: ${c.account}. Enjoy fast WiFi!` });
  }
  saveDb(d);
}

/* ---------- SMS (Africa's Talking) ---------- */
function normPhone(p) {
  const x = String(p || '').replace(/[\s-]/g, '');
  if (/^\+?254[17]\d{8}$/.test(x)) return '+' + x.replace(/^\+/, '');
  if (/^0[17]\d{8}$/.test(x)) return '+254' + x.slice(1);
  return null;
}
async function sendSms(to, text) {
  try {
    const form = new URLSearchParams({ username: AT_USER, to, message: text });
    if (AT_FROM) form.set('from', AT_FROM);
    const r = await fetch(AT_URL, { method: 'POST', headers: { apiKey: AT_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(15000) });
    const raw = await r.text(); let d = {}; try { d = JSON.parse(raw); } catch (e) { }
    const rec = d.SMSMessageData && d.SMSMessageData.Recipients && d.SMSMessageData.Recipients[0];
    if (rec && [100, 101, 102].includes(rec.statusCode)) return { ok: true, detail: rec.status + (rec.cost ? ' ' + rec.cost : '') };
    return { ok: false, detail: rec ? rec.status : (d.SMSMessageData && d.SMSMessageData.Message) || ('HTTP ' + r.status + ' ' + raw.slice(0, 120)) };
  } catch (e) { return { ok: false, detail: 'Network error: ' + e.message }; }
}
const logSms = (id, status, detail, attempts) => db.prepare(
  'INSERT INTO sms_log(message_id,status,detail,attempts,updated) VALUES(?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET status=excluded.status,detail=excluded.detail,attempts=excluded.attempts,updated=excluded.updated'
).run(id, status, detail, attempts, Date.now());

let smsBusy = false;
async function smsTick() {
  if (!SMS_ON || smsBusy) return;
  smsBusy = true;
  try {
    const since = Number(getMeta('sms_since', 0));
    const rows = db.prepare(`SELECT m.id,m.data,COALESCE(l.attempts,0) n FROM messages m LEFT JOIN sms_log l ON l.message_id=m.id
      WHERE l.message_id IS NULL OR (l.status='failed' AND l.attempts<3 AND l.updated<?) LIMIT 20`).all(Date.now() - 60000);
    for (const r of rows) {
      const m = JSON.parse(r.data), t = new Date(m.date).getTime();
      if (t < since || Date.now() - t > D) { logSms(r.id, 'skipped', 'Older than SMS start or 24h', 3); continue; }
      const to = normPhone(m.phone);
      if (!to) { logSms(r.id, 'failed', 'Invalid phone number', 3); continue; }
      const res = await sendSms(to, m.text);
      logSms(r.id, res.ok ? 'sent' : 'failed', res.detail, r.n + 1);
      console.log(`SMS ${res.ok ? 'sent' : 'FAILED'} to ${to}: ${res.detail}`);
    }
  } catch (e) { console.error('sms', e.message); }
  smsBusy = false;
}

/* ---------- automatic expiry reminders (AUTO_REMINDERS=1) ---------- */
function autoReminders() {
  try {
    const d = loadDb(); let added = 0;
    const act = d.payModes.filter(m => m.status === 'Active').slice(0, 2).map(m => {
      const f = m.fields || {};
      return m.type === 'paybill' ? `Paybill ${f.paybill}` : m.type === 'till' ? `Till ${f.till}` : m.type === 'phone' ? `Send money to ${f.phone}` : `${f.bankName} A/C ${f.accNo}`;
    });
    const hint = act.length ? act.join(' or ') : 'our payment channels';
    for (const c of d.customers) {
      const sub = d.subs.filter(s => s.customerId === c.id).sort((a, z) => new Date(z.expiry) - new Date(a.expiry))[0];
      if (!sub) continue;
      const left = new Date(sub.expiry) - Date.now(), plan = d.plans.find(p => p.id === sub.planId);
      if (!plan || left > WINDOW || left <= -D) continue;
      if (d.messages.some(m => m.customerId === c.id && m.type === 'reminder' && Date.now() - new Date(m.date) < 12 * H)) continue;
      d.messages.push({ id: uid('g'), customerId: c.id, phone: c.phone, type: 'reminder', date: new Date().toISOString(),
        text: `Hi ${c.name.split(' ')[0]}, your ${plan.name} package ${left > 0 ? 'expires' : 'expired'} on ${dt(sub.expiry)}. To renew, pay ${hint} with Account No ${c.account}. Thank you.` });
      added++;
    }
    if (added) { saveDb(d); console.log(`Auto reminders queued: ${added}`); }
  } catch (e) { console.error('reminders', e.message); }
}

/* ---------- MikroTik (RouterOS API, no dependencies) ---------- */
function rosEnc(w) {
  const b = Buffer.from(w, 'utf8'), l = b.length; let h;
  if (l < 0x80) h = Buffer.from([l]);
  else if (l < 0x4000) h = Buffer.from([(l >> 8) | 0x80, l & 255]);
  else if (l < 0x200000) h = Buffer.from([(l >> 16) | 0xC0, (l >> 8) & 255, l & 255]);
  else h = Buffer.from([0xE0 | (l >> 24), (l >> 16) & 255, (l >> 8) & 255, l & 255]);
  return Buffer.concat([h, b]);
}
class Ros {
  constructor(r) { this.r = r; this.buf = Buffer.alloc(0); this.words = []; this.pending = null; this.dead = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const { host, port, ssl } = this.r;
      const s = this.s = ssl ? tls.connect({ host, port, rejectUnauthorized: false }) : net.connect({ host, port });
      s.setTimeout(15000, () => s.destroy(new Error('Connection timed out')));
      s.once(ssl ? 'secureConnect' : 'connect', resolve);
      s.on('error', e => { this.dead = e; if (this.pending) this.pending.rej(e); reject(e); });
      s.on('close', () => { this.dead = this.dead || new Error('Router closed the connection'); if (this.pending) this.pending.rej(this.dead); });
      s.on('data', d => this.onData(d));
    });
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf; if (!b.length) return;
      const b0 = b[0]; let n, len;
      if (b0 < 0x80) { n = 1; len = b0; }
      else if (b0 < 0xC0) { n = 2; if (b.length < 2) return; len = ((b0 & 0x3F) << 8) | b[1]; }
      else if (b0 < 0xE0) { n = 3; if (b.length < 3) return; len = ((b0 & 0x1F) << 16) | (b[1] << 8) | b[2]; }
      else if (b0 < 0xF0) { n = 4; if (b.length < 4) return; len = ((b0 & 0x0F) << 24) | (b[1] << 16) | (b[2] << 8) | b[3]; }
      else { n = 5; if (b.length < 5) return; len = b.readUInt32BE(1); }
      if (b.length < n + len) return;
      const w = b.slice(n, n + len).toString('utf8'); this.buf = b.slice(n + len);
      if (len === 0) { const ws = this.words; this.words = []; this.sentence(ws); } else this.words.push(w);
    }
  }
  sentence(ws) {
    const p = this.pending; if (!p || !ws.length) return;
    const attrs = {};
    ws.slice(1).forEach(w => { if (w[0] === '=') { const i = w.indexOf('=', 1); attrs[w.slice(1, i)] = w.slice(i + 1); } });
    if (ws[0] === '!re') p.rows.push(attrs);
    else if (ws[0] === '!trap') p.trap = attrs.message || 'Router error';
    else if (ws[0] === '!fatal') { this.pending = null; p.rej(new Error(ws[1] || 'Router closed the connection')); }
    else if (ws[0] === '!done') { this.pending = null; p.trap ? p.rej(new Error(p.trap)) : p.res(p.rows); }
  }
  run(words) {
    return new Promise((res, rej) => {
      if (this.dead) return rej(this.dead);
      this.pending = { res, rej, rows: [], trap: null };
      this.s.write(Buffer.concat([...words.map(rosEnc), Buffer.from([0])]));
    });
  }
  async login() { await this.run(['/login', '=name=' + this.r.user, '=password=' + this.r.pass]); }
  close() { try { this.s.destroy(); } catch (e) { } }
}
const mtStatus = {}; // router id -> { at, ok, message }

async function syncRouter(r, d) {
  const ros = new Ros(r);
  await ros.connect();
  try {
    await ros.login();
    const hs = await ros.run(['/ip/hotspot/user/print']).catch(() => []);
    const ppp = await ros.run(['/ppp/secret/print']).catch(() => []);
    const sum = { created: 0, enabled: 0, disabled: 0, kicked: 0, updated: 0, skipped: [] };
    const kick = async (hotspot, name) => {
      const act = await ros.run(hotspot ? ['/ip/hotspot/active/print', '?user=' + name] : ['/ppp/active/print', '?name=' + name]);
      for (const a of act) { await ros.run([hotspot ? '/ip/hotspot/active/remove' : '/ppp/active/remove', '=.id=' + a['.id']]); sum.kicked++; }
    };
    const known = new Set();
    for (const c of d.customers.filter(x => x.routerId === r.id)) {
      if (!c.username) continue;
      const hotspot = c.connType !== 'PPPoE', menu = hotspot ? '/ip/hotspot/user' : '/ppp/secret';
      known.add((hotspot ? 'h:' : 'p:') + c.username);
      const sub = d.subs.filter(s => s.customerId === c.id).sort((a, z) => new Date(z.expiry) - new Date(a.expiry))[0];
      const on = !!sub && new Date(sub.expiry) > Date.now();
      const plan = d.plans.find(p => p.id === (sub ? sub.planId : c.planId));
      const profile = plan && plan.profile ? plan.profile : '';
      const ex = (hotspot ? hs : ppp).find(x => x.name === c.username);
      if (!ex) {
        if (on) {
          const w = [menu + '/add', '=name=' + c.username, '=password=' + (c.password || ''), '=comment=airbill'];
          if (profile) w.push('=profile=' + profile);
          if (!hotspot) w.push('=service=pppoe');
          await ros.run(w); sum.created++;
        }
        continue;
      }
      if (ex.comment !== 'airbill') { sum.skipped.push(c.username); continue; }  // never touch users AirBill did not create
      const isOff = ex.disabled === 'true', set = ['=.id=' + ex['.id']];
      if (on && isOff) { set.push('=disabled=no'); sum.enabled++; }
      if (!on && !isOff) { set.push('=disabled=yes'); sum.disabled++; }
      if (on && profile && ex.profile !== profile) set.push('=profile=' + profile);
      if (c.password && ex.password !== undefined && ex.password !== c.password) set.push('=password=' + c.password);
      if (set.length > 1) { await ros.run([menu + '/set', ...set]); if (!set.some(x => x.startsWith('=disabled='))) sum.updated++; }
      if (!on) await kick(hotspot, c.username);
    }
    // users AirBill created for customers that no longer exist here: switch off
    for (const [hotspot, list] of [[true, hs], [false, ppp]]) {
      for (const u of list) {
        if (u.comment === 'airbill' && !known.has((hotspot ? 'h:' : 'p:') + u.name) && u.disabled !== 'true') {
          await ros.run([(hotspot ? '/ip/hotspot/user' : '/ppp/secret') + '/set', '=.id=' + u['.id'], '=disabled=yes']);
          await kick(hotspot, u.name); sum.disabled++;
        }
      }
    }
    const bits = ['created', 'enabled', 'disabled', 'updated', 'kicked'].filter(k => sum[k]).map(k => `${sum[k]} ${k}`);
    return (bits.length ? bits.join(', ') : 'Already in sync') + (sum.skipped.length ? `. Skipped (not created by AirBill): ${sum.skipped.join(', ')}` : '');
  } finally { ros.close(); }
}
let mtBusy = false, mtTimer = null;
async function syncAll() {
  if (mtBusy) return; mtBusy = true;
  try {
    const d = loadDb();
    for (const r of d.routers.filter(x => x.status === 'Active')) {
      try { const m = await syncRouter(r, d); mtStatus[r.id] = { at: Date.now(), ok: true, message: m }; if (m !== 'Already in sync') console.log(`MikroTik ${r.name}: ${m}`); }
      catch (e) { mtStatus[r.id] = { at: Date.now(), ok: false, message: e.message }; console.error(`MikroTik ${r.name}: ${e.message}`); }
    }
  } catch (e) { console.error('mikrotik', e.message); }
  mtBusy = false;
}
function scheduleSync() { clearTimeout(mtTimer); mtTimer = setTimeout(syncAll, 3000); }  // a payment/save triggers a sync within seconds

/* ---------- http helpers ---------- */
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function body(req) {
  return new Promise((res, rej) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 8e6) { rej(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { rej(new Error('Invalid JSON')); } });
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, p) {
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, path.normalize(decodeURIComponent(p)));
  const ext = path.extname(f).toLowerCase();
  if (!f.startsWith(ROOT + path.sep) || !TYPES[ext] || path.basename(f) === 'server.js' || !fs.existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[ext], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
  fs.createReadStream(f).pipe(res);
}

/* ---------- routes ---------- */
async function api(req, res, p) {
  const m = req.method, ip = req.socket.remoteAddress;

  // M-Pesa callbacks (Safaricom cannot log in, so the secret is part of the URL)
  let mm = p.match(/^\/api\/(?:mpesa|pay)\/(confirmation|validation)\/(.+)$/);
  if (mm && m === 'POST') {
    const ok = MPESA_SECRET && mm[2].length === MPESA_SECRET.length && crypto.timingSafeEqual(Buffer.from(mm[2]), Buffer.from(MPESA_SECRET));
    if (!ok) return send(res, 403, { error: 'Forbidden' });
    if (mm[1] === 'confirmation') { try { mpesaPayment(await body(req)); } catch (e) { console.error('mpesa', e.message); } }
    return send(res, 200, { ResultCode: 0, ResultDesc: 'Accepted' });
  }

  if (p === '/api/health') return send(res, 200, { ok: true });
  if (p === '/api/auth/me' && m === 'GET') return send(res, 200, { user: pub(sessionUser(req)), hasUsers: userCount() > 0 });

  if (p === '/api/auth/register' && m === 'POST') {
    if (userCount() > 0) return send(res, 403, { error: 'Registration is closed. Ask your administrator to add you.' });
    const b = await body(req), name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    if (name.length < 2) return send(res, 400, { error: 'Enter your full name.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
    if (pw.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const u = { id: uid('u'), name, email, salt, hash: await scrypt(pw, salt), role: 'Admin', created: new Date().toISOString() };
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(u.id, u.name, u.email, u.salt, u.hash, u.role, u.created);
    startSession(req, res, u, !!b.remember);
    return send(res, 200, { user: pub(u) });
  }

  if (p === '/api/auth/login' && m === 'POST') {
    if (throttled(ip)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const b = await body(req), email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    if (!email || !pw) return send(res, 400, { error: 'Enter your email and password.' });
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const hash = await scrypt(pw, u ? u.salt : 'x'.repeat(32));        // same work whether or not the user exists
    if (!u || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.hash))) { tries.get(ip).push(Date.now()); return send(res, 401, { error: 'Incorrect email or password.' }); }
    startSession(req, res, u, !!b.remember);
    return send(res, 200, { user: pub(u) });
  }

  if (p === '/api/auth/logout' && m === 'POST') {
    const t = cookies(req).sid; if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(sha(t));
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  // everything below needs a signed-in user
  const me = sessionUser(req);
  if (!me) return send(res, 401, { error: 'Not signed in' });

  if (p === '/api/db' && m === 'GET') return send(res, 200, loadDb());
  if (p === '/api/db' && m === 'POST') {
    const d = await body(req);
    if (!validDb(d)) return send(res, 400, { error: 'Invalid data' });
    if (Number(d._rev) !== Number(getMeta('rev', 0))) return send(res, 409, { error: 'Data changed elsewhere. Reloading.' });
    try { saveDb(d); } catch (e) { return send(res, 400, { error: 'Could not save: ' + e.message }); }
    return send(res, 200, { ok: true, _rev: Number(getMeta('rev', 0)) });
  }

  mm = p.match(/^\/api\/routers\/([\w-]+)\/(test|sync)$/);
  if (mm && m === 'POST') {
    if (me.role !== 'Admin') return send(res, 403, { error: 'Admins only' });
    const d = loadDb(), r = d.routers.find(x => x.id === mm[1]);
    if (!r) return send(res, 404, { error: 'Router not found' });
    try {
      if (mm[2] === 'test') {
        const ros = new Ros(r); await ros.connect();
        try { await ros.login(); const id = await ros.run(['/system/identity/print']); return send(res, 200, { message: `Connected to "${(id[0] || {}).name || r.name}"` }); } finally { ros.close(); }
      }
      const msg = await syncRouter(r, d); mtStatus[r.id] = { at: Date.now(), ok: true, message: msg };
      return send(res, 200, { message: 'Synced: ' + msg });
    } catch (e) { return send(res, 502, { error: 'Router: ' + (e.message || 'connection failed') }); }
  }
  if (p === '/api/routers/status' && m === 'GET') return send(res, 200, { autoSync: MT_ON, status: mtStatus });
  if (p === '/api/sms' && m === 'GET') {
    if (me.role !== 'Admin') return send(res, 403, { error: 'Admins only' });
    return send(res, 200, { enabled: SMS_ON, sandbox: AT_USER === 'sandbox', autoReminders: AUTO_REMINDERS,
      recent: db.prepare('SELECT message_id,status,detail,attempts,updated FROM sms_log ORDER BY updated DESC LIMIT 20').all() });
  }
  if (p === '/api/sms/test' && m === 'POST') {
    if (me.role !== 'Admin') return send(res, 403, { error: 'Admins only' });
    if (!SMS_ON) return send(res, 400, { error: 'SMS is not configured. Set AT_USERNAME and AT_API_KEY.' });
    const to = normPhone((await body(req)).to);
    if (!to) return send(res, 400, { error: 'Enter a valid Kenyan phone number.' });
    const r = await sendSms(to, 'AirBill test message. SMS sending is working.');
    return send(res, r.ok ? 200 : 502, r.ok ? { ok: true, detail: r.detail } : { error: r.detail });
  }

  // staff accounts (Admin only)
  if (p.startsWith('/api/users')) {
    if (me.role !== 'Admin') return send(res, 403, { error: 'Admins only' });
    if (p === '/api/users' && m === 'GET') return send(res, 200, { users: db.prepare('SELECT id,name,email,role,created FROM users ORDER BY created').all(), me: me.id });
    if (p === '/api/users' && m === 'POST') {
      const b = await body(req), name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || ''), role = b.role === 'Admin' ? 'Admin' : 'Staff';
      if (name.length < 2) return send(res, 400, { error: 'Enter the full name.' });
      if (!/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
      if (pw.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return send(res, 400, { error: 'That email already has an account.' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(uid('u'), name, email, salt, await scrypt(pw, salt), role, new Date().toISOString());
      return send(res, 200, { ok: true });
    }
    mm = p.match(/^\/api\/users\/([\w-]+)$/);
    if (mm && m === 'DELETE') {
      if (mm[1] === me.id) return send(res, 400, { error: 'You cannot delete your own account.' });
      db.prepare('DELETE FROM users WHERE id=?').run(mm[1]);
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/')) return await api(req, res, p);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, p);
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'Server error' }); }
}).listen(PORT, () => {
  console.log(`AirBill running: http://localhost:${PORT}`);
  if (!MPESA_SECRET) console.log('M-Pesa callback disabled (set MPESA_SECRET to enable).');
  if (SMS_ON) {
    if (!getMeta('sms_since', '')) setMeta('sms_since', Date.now());   // never text old history
    console.log(`SMS enabled (${AT_USER === 'sandbox' ? 'sandbox' : 'live'}).`);
    setInterval(smsTick, 10000);
  } else console.log('SMS disabled (set AT_USERNAME and AT_API_KEY to enable).');
  if (MT_ON) { console.log('MikroTik auto-sync on.'); setTimeout(syncAll, 5000); setInterval(syncAll, 60000); }
  else console.log('MikroTik auto-sync off (set MIKROTIK_SYNC=1 to enable).');
  if (AUTO_REMINDERS) { console.log('Automatic expiry reminders on.'); setTimeout(autoReminders, 5000); setInterval(autoReminders, 15 * 60 * 1000); }
});