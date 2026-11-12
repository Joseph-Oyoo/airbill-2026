/* AirBill - shared helpers and page shell (data lives on the server) */
(function () {
  'use strict';
  const KEY = 'airbill_v1';
  const H = 36e5, D = 24 * H, WINDOW = 48 * H; // "expiring soon" = within 48 hours

  const ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-7 7-7s7 3 7 7"/><path d="M17 4a4 4 0 010 8"/><path d="M22 21c0-3-2-5-4-6"/>',
    wifi: '<path d="M2 9a15 15 0 0120 0"/><path d="M5 13a10 10 0 0114 0"/><path d="M8.5 16.5a5 5 0 017 0"/><circle cx="12" cy="20" r="1"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    chat: '<path d="M21 12a8 8 0 01-11.6 7.1L3 21l1.9-5.4A8 8 0 1121 12z"/>',
    box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>',
    router: '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 17h.01M11 17h.01M8 14l-2-5M16 14l2-5"/>',
    wallet: '<path d="M3 7a2 2 0 012-2h14v4"/><path d="M3 7v11a2 2 0 002 2h16V9H5a2 2 0 01-2-2z"/><circle cx="17" cy="14.5" r="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    bank: '<path d="M3 10l9-6 9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18"/>',
    store: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9a2.5 2.5 0 005 0 2.5 2.5 0 006 0 2.5 2.5 0 005 0"/><path d="M5 12v8h14v-8"/>',
    hash: '<path d="M5 9h14M5 15h14M10 3L8 21M16 3l-2 18"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>'
  };
  const ic = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ''}</svg>`;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = p => p + Math.random().toString(36).slice(2, 9);
  const money = n => 'KES ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });
  const dt = iso => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dshort = iso => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

  /* ---------- server connection ---------- */
  const COLLS = ['plans', 'customers', 'subs', 'payments', 'messages', 'routers', 'payModes'];
  function emptyDB() { return { plans: [], customers: [], subs: [], payments: [], messages: [], routers: [], payModes: [], counter: 10000 }; }

  // Synchronous request: keeps every page working exactly as before (App.get / App.save stay synchronous).
  function xhr(method, url, body) {
    const x = new XMLHttpRequest();
    try {
      x.open(method, url, false);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(body === undefined ? null : JSON.stringify(body));
    } catch (e) { return { status: 0, data: null }; }
    let data = null; try { data = JSON.parse(x.responseText); } catch (e) { }
    return { status: x.status, data };
  }
  async function post(url, body) {
    let r;
    try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' }); }
    catch (e) { throw new Error('Cannot reach the server. Check that it is running.'); }
    let data = {}; try { data = await r.json(); } catch (e) { }
    if (!r.ok) throw new Error(data.error || 'Request failed (' + r.status + ')');
    return data;
  }

  /* ---------- storage (server database) ---------- */
  const snapOf = db => {
    const s = {};
    COLLS.forEach(c => { s[c] = {}; (db[c] || []).forEach(i => { s[c][i.id] = JSON.stringify(i); }); });
    return s;
  };
  function attach(db) { Object.defineProperty(db, '__snap', { value: snapOf(db), writable: true, enumerable: false }); return db; }

  function get() {
    const r = xhr('GET', '/api/db');
    if (r.status === 401) { toLogin(); return attach(emptyDB()); }
    if (r.status !== 200 || !r.data) { toast('Cannot reach the server', true); return attach(emptyDB()); }
    return attach(Object.assign(emptyDB(), r.data));
  }
  // Sends only what changed since get(), so two people working at once do not overwrite each other.
  function save(db) {
    const snap = db.__snap || snapOf(emptyDB()), delta = { upserts: {}, deletes: {}, counter: db.counter };
    COLLS.forEach(c => {
      const now = {};
      (db[c] || []).forEach(i => { now[i.id] = JSON.stringify(i); });
      delta.upserts[c] = (db[c] || []).filter(i => snap[c][i.id] !== now[i.id]);
      delta.deletes[c] = Object.keys(snap[c]).filter(id => !(id in now));
    });
    const r = xhr('POST', '/api/db/save', delta);
    if (r.status === 401) return toLogin();
    if (r.status !== 200) { toast((r.data && r.data.error) || 'Could not save - server not reachable', true); return false; }
    Object.defineProperty(db, '__snap', { value: snapOf(db), writable: true, enumerable: false });
    return true;
  }

  /* ---------- business logic ---------- */
  const durMs = p => (p.durationUnit === 'hours' ? H : p.durationUnit === 'months' ? 30 * D : D) * Number(p.durationValue || 1);
  const durLabel = p => `${p.durationValue} ${p.durationValue == 1 ? p.durationUnit.replace(/s$/, '') : p.durationUnit}`;
  const planOf = (db, id) => db.plans.find(p => p.id === id);
  const custOf = (db, id) => db.customers.find(c => c.id === id);
  const routerOf = (db, id) => db.routers.find(r => r.id === id);

  function currentSub(db, customerId) {
    const list = db.subs.filter(s => s.customerId === customerId);
    return list.length ? list.reduce((a, b) => (new Date(b.expiry) > new Date(a.expiry) ? b : a)) : null;
  }
  function statusOf(sub) {
    if (!sub) return { k: 'none', label: 'No package', cls: 'b-gray' };
    const left = new Date(sub.expiry) - Date.now();
    if (left <= 0) return { k: 'expired', label: 'Expired', cls: 'b-bad', left };
    if (left <= WINDOW) return { k: 'expiring', label: 'Expiring soon', cls: 'b-warn', left };
    return { k: 'active', label: 'Active', cls: 'b-ok', left };
  }
  function timeLeft(ms) {
    if (ms <= 0) return 'Expired';
    const d = Math.floor(ms / D), h = Math.floor((ms % D) / H), m = Math.floor((ms % H) / 60000);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  function modeSummary(m) {
    const f = m.fields || {};
    if (m.type === 'paybill') return `Paybill ${f.paybill}`;
    if (m.type === 'till') return `Till ${f.till}`;
    if (m.type === 'phone') return `Send money to ${f.phone}`;
    return `${f.bankName} A/C ${f.accNo}`;
  }
  function payHint(db) {
    const act = db.payModes.filter(m => m.status === 'Active').slice(0, 2).map(modeSummary);
    return act.length ? act.join(' or ') : 'our payment channels';
  }
  function addMessage(db, c, type, text) {
    const m = { id: uid('g'), customerId: c.id, phone: c.phone, type, text, date: new Date().toISOString() };
    db.messages.push(m); return m;
  }
  function activate(db, customerId, planId) {
    const plan = planOf(db, planId), c = custOf(db, customerId);
    const cur = currentSub(db, customerId);
    const running = cur && new Date(cur.expiry) > Date.now();
    const base = running ? new Date(cur.expiry).getTime() : Date.now();
    const sub = { id: uid('s'), customerId, planId, start: running ? cur.start : new Date().toISOString(), expiry: new Date(base + durMs(plan)).toISOString() };
    db.subs.push(sub); c.planId = planId;
    addMessage(db, c, 'subscribed', `Hi ${c.name.split(' ')[0]}, your ${plan.name} package (${money(plan.price)}) is now active until ${dt(sub.expiry)}. Account No: ${c.account}. Enjoy fast WiFi!`);
    return sub;
  }
  function sendReminder(db, customerId) {
    const c = custOf(db, customerId), sub = currentSub(db, customerId), plan = planOf(db, sub.planId);
    return addMessage(db, c, 'reminder', `Hi ${c.name.split(' ')[0]}, your ${plan.name} package ${new Date(sub.expiry) > Date.now() ? 'expires' : 'expired'} on ${dt(sub.expiry)}. To renew, pay ${payHint(db)} with Account No ${c.account}. Thank you.`);
  }

  /* ---------- UI helpers ---------- */
  function toast(msg, bad) {
    let w = document.querySelector('.toast-wrap');
    if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; document.body.appendChild(w); }
    const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg; w.appendChild(t);
    setTimeout(() => { t.style.opacity = 0; t.style.transition = '.3s'; setTimeout(() => t.remove(), 300); }, 3200);
  }
  const openModal = id => document.getElementById(id).classList.add('open');
  const closeModal = id => document.getElementById(id).classList.remove('open');
  function wireModals() {
    document.querySelectorAll('.modal').forEach(m => {
      m.addEventListener('mousedown', e => { if (e.target === m) m.classList.remove('open'); });
      m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => m.classList.remove('open')));
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')); });
  }
  function copy(text) {
    const done = () => toast('Copied to clipboard');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done); else done();
  }

  /* ---------- authentication (server sessions) ---------- */
  const PUBLIC = document.documentElement.hasAttribute('data-public');
  let me = undefined; // cached for this page load
  function current() {
    if (me === undefined) { const r = xhr('GET', '/api/me'); me = r.status === 200 && r.data ? r.data.user : null; }
    return me;
  }
  function hasUsers() { const r = xhr('GET', '/api/auth/status'); return !!(r.data && r.data.hasUsers); }
  async function register(data, remember) {
    const r = await post('/api/auth/register', { name: data.name, email: data.email, password: data.password, remember: !!remember });
    me = undefined; return r.user;
  }
  async function login(email, password, remember) {
    const r = await post('/api/auth/login', { email, password, remember: !!remember });
    me = undefined; return r.user;
  }
  function logout() { xhr('POST', '/api/auth/logout', {}); me = null; location.replace('login.html'); }

  // Guard: every page except the login page needs a signed-in user.
  function toLogin() {
    const here = location.pathname.split('/').pop() || 'index.html';
    location.replace('login.html?next=' + encodeURIComponent(here));
  }
  if (!PUBLIC && !current()) { document.documentElement.style.visibility = 'hidden'; toLogin(); }
  window.addEventListener('pageshow', e => { if (e.persisted && !PUBLIC) { me = undefined; if (!current()) toLogin(); } }); // Back button after sign-out

  const NAV = [
    ['Overview', [['index', 'Dashboard', 'home']]],
    ['Operations', [['subscribers', 'Subscribers', 'wifi'], ['customers', 'Customers', 'users'], ['payments', 'Payments', 'cash'], ['messages', 'Messages', 'chat']]],
    ['Setup', [['plans', 'Packages', 'box'], ['mikrotik', 'MikroTik Routers', 'router'], ['billing', 'Billing Setup', 'wallet']]]
  ];

  function shell(active, title, sub) {
    document.title = title + ' - AirBill';
    const me = current() || { name: 'Guest', email: '', role: '' };
    const sb = document.getElementById('sidebar');
    sb.innerHTML = `
      <a class="brand" href="index.html">
        <div class="brand-mark">${ic('wifi', 22)}</div>
        <div><div class="brand-name">AirBill</div><div class="brand-tag">WiFi Billing Suite</div></div>
      </a>
      <nav class="nav">${NAV.map(g => `<div class="nav-group">${g[0]}</div>` + g[1].map(i => `<a href="${i[0]}.html" class="${i[0] === active ? 'active' : ''}">${ic(i[2])}${i[1]}</a>`).join('')).join('')}</nav>
      <div class="side-foot">
        <div class="who" style="margin-bottom:12px"><div class="av" style="background:linear-gradient(135deg,var(--gold2),var(--goldd));color:var(--ink)">${esc(initials(me.name))}</div><div style="min-width:0"><div style="color:#fff;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(me.name)}</div><div style="font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(me.role)}${me.role ? ' &middot; ' : ''}${esc(me.email)}</div></div></div>
        <button id="logout" class="btn btn-sm" style="width:100%;justify-content:center;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);color:#e6ebf5;text-decoration:none;margin-top:0;font-size:13px;padding:9px">Sign out</button>
        <div style="margin-top:12px">Data is stored on the server.${me.role === 'Admin' ? '<br><button id="wipe">Clear all data</button>' : ''}</div>
      </div>`;
    const bd = document.createElement('div'); bd.className = 'backdrop'; document.body.appendChild(bd);
    const tb = document.getElementById('topbar');
    tb.innerHTML = `<button class="burger" id="burger" aria-label="Menu">${ic('menu', 20)}</button>
      <div><h1>${esc(title)}</h1><p>${esc(sub || '')}</p></div>
      <div class="top-right"><span class="date-chip">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span><div class="avatar" title="${esc(me.name)}">${esc(initials(me.name))}</div></div>`;
    const tog = () => { sb.classList.toggle('open'); bd.classList.toggle('open'); };
    document.getElementById('burger').onclick = tog; bd.onclick = tog;
    document.getElementById('logout').onclick = logout;
    const wipe = document.getElementById('wipe');
    if (wipe) wipe.onclick = () => {
      if (confirm('This permanently deletes ALL customers, packages, payments and settings on the server. Continue?')) {
        const r = xhr('POST', '/api/wipe', {});
        if (r.status === 200) location.reload(); else toast((r.data && r.data.error) || 'Could not clear data', true);
      }
    };
    wireModals();
  }

  window.App = { auth: { current, register, login, logout, hasUsers }, get, save, uid, esc, money, dt, dshort, initials, ic, durMs, durLabel, planOf, custOf, routerOf, currentSub, statusOf, timeLeft, modeSummary, payHint, addMessage, activate, sendReminder, toast, openModal, closeModal, copy, shell, H, D, WINDOW };
})();