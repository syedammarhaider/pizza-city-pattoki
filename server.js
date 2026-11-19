'use strict';
/*
 * Pizza City POS - Local offline server
 * Developer: Syed Ammar Haider | 03214499478
 *
 * Data is stored permanently in the "data" folder:
 *   data/menu.json      - menu items
 *   data/settings.json  - shop settings + admin password (hashed)
 *   data/orders.jsonl   - every order (append-only, never deleted)
 *   data/meta.json      - order number counter
 *   data/images/        - item pictures
 * Automatic backups go to "backups" folder.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const IMG = path.join(DATA, 'images');
const BACKUPS = path.join(ROOT, 'backups');
const F_MENU = path.join(DATA, 'menu.json');
const F_SETTINGS = path.join(DATA, 'settings.json');
const F_ORDERS = path.join(DATA, 'orders.jsonl');
const F_META = path.join(DATA, 'meta.json');

const CREDIT = { name: 'Ammar', phone: '03214499478' };
const SIZES = ['S', 'M', 'L'];
const CURRENCY = 'Rs.';
const DEFAULT_PASSWORD = 'adminpizzacity';   // always works (forgot-password fallback)
const TOKEN_TTL = 15 * 60 * 1000;            // server-side safety net; the screen locks after 3 idle minutes

/* -------------------- Config -------------------- */
function loadConfig() {
  const def = { port: 3000, host: '127.0.0.1', keepBackupDays: 3650 };
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const envPort = Number(process.env.PIZZA_CITY_PORT);
    return {
      port: Number.isInteger(envPort) && envPort > 0 && envPort < 65536
        ? envPort
        : (Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : def.port),
      host: typeof c.host === 'string' && c.host ? c.host : def.host,
      keepBackupDays: Number.isInteger(c.keepBackupDays) && c.keepBackupDays > 0 ? c.keepBackupDays : def.keepBackupDays
    };
  } catch (e) { return def; }
}
const CONFIG = loadConfig();

/* -------------------- File helpers -------------------- */
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch (x) {}
      console.error('WARNING: could not read ' + path.basename(file));
    }
    return fallback;
  }
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function writeJSON(file, obj) { writeAtomic(file, JSON.stringify(obj, null, 2)); }

function appendLine(file, line) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, line + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

const pad = n => String(n).padStart(2, '0');
function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00')); }

/* -------------------- Defaults -------------------- */
function defaultSettings() {
  return {
    shopName: 'Pizza City',
    tagline: 'Dine In • Take Away • Free Home Delivery',
    address: 'Lahore Adda Pattoki',
    phones: ['0301-3596331', '0316-3540348'],
    currency: CURRENCY,
    taxPercent: 0,
    deliveryFee: 0,
    toppingPrices: { S: 100, M: 150, L: 200 },
    // Optional lines (check boxes in Settings) - shown on receipt and header
    showTagline: true,
    showAddress: true,
    showPhones: true,
    showFooter: true,
    receiptWidth: 80,
    receiptFooter: 'Thank you for choosing Pizza City! Please visit again.',
    autoPrint: true,
    pinHash: '',     // custom admin password (hashed). Empty = default password
    pinSalt: ''
  };
}

function item(id, name, category, prices, extra) {
  const base = {
    id, name, category, type: 'sized',
    prices: { S: 0, M: 0, L: 0 }, price: 0,
    description: '', image: '', allowToppings: true, active: true
  };
  if (Array.isArray(prices)) base.prices = { S: prices[0], M: prices[1], L: prices[2] };
  return Object.assign(base, extra || {});
}

function deal(n, price, lines) {
  return item('deal' + n, 'Deal ' + n, 'Deals', null, {
    type: 'single', price, description: lines.join('\n'), allowToppings: false
  });
}

function defaultMenu() {
  const items = [
    deal(1, 1400, ['1 Large Pizza', '1 Small Pizza', '1 Cold Drink (1.5 Ltr.)']),
    deal(2, 2050, ['2 Large Pizzas', '1 Cold Drink (1.5 Ltr.)']),
    deal(3, 2700, ['2 Large Pizza', '1 Medium Pizza', '1 Cold Drink (1.5 Ltr.)']),
    deal(4, 4000, ['4 Large Pizza', '2 Cold Drink (1.5 Ltr.)']),
    deal(5, 1900, ['5 Small Pizza', '1 Cold Drink (1.5 Ltr.)']),
    deal(6, 4200, ['1 Large Cheese Stuffer', '1 Large Kabab Stuffer', '1 Loaded Special', '2 Cold Drink (1.5 Ltr.)']),
    deal(7, 1450, ['2 Medium Pizza', '1 Cold Drink (1 Ltr.)']),
    deal(8, 2500, ['1 Large Pizza', '2 Medium Pizza', '1 Cold Drink (1 Ltr.)'])
  ];

  // Regular pizzas
  [['chicken-tikka', 'Chicken Tikka Pizza'], ['chicken-achari', 'Chicken Achari Pizza'],
   ['chicken-fajita', 'Chicken Fajita Pizza'], ['peri-peri', 'Peri Peri Pizza'],
   ['chicken-tandori', 'Chicken Tandori Pizza'], ['chicken-supreme', 'Chicken Supreme Pizza'],
   ['cheese-lover', 'Cheese Lover Pizza'], ['vegetable', 'Vegetable Pizza']
  ].forEach(p => items.push(item(p[0], p[1], 'Pizzas', [350, 650, 950])));

  // Premium
  [['city-special', 'City Special Pizza'], ['italian', 'Italian Pizza'],
   ['malai-boti', 'Malai Boti Pizza'], ['kabab-behari', 'Kabab Behari Pizza'],
   ['bbq', 'Bar B.Q. Pizza']
  ].forEach(p => items.push(item(p[0], p[1], 'Premium Pizzas', [450, 750, 1100])));

  // Stuffed
  [['kabab-stuffer', 'Kabab Stuffer Pizza'], ['cheese-stuffer', 'Cheese Stuffer Pizza'],
   ['crown-crust', 'Crown Crust Pizza']
  ].forEach(p => items.push(item(p[0], p[1], 'Stuffed Pizzas', [550, 850, 1300])));

  items.push(item('loaded', 'Special Loaded Pizza', 'Specials', [0, 850, 1300]));
  items.push(item('lazania', 'Chicken Lazania Pizza', 'Specials', [550, 850, 1300]));

  // Drinks / bottles
  items.push(item('drink-15', 'Cold Drink 1.5 Ltr', 'Drinks', null, { type: 'single', price: 180, allowToppings: false }));
  items.push(item('drink-1', 'Cold Drink 1 Ltr', 'Drinks', null, { type: 'single', price: 120, allowToppings: false }));
  items.push(item('drink-500', 'Cold Drink 500 ml', 'Drinks', null, { type: 'single', price: 80, allowToppings: false }));
  items.push(item('water', 'Mineral Water', 'Drinks', null, { type: 'single', price: 50, allowToppings: false }));

  return {
    categories: ['Deals', 'Pizzas', 'Premium Pizzas', 'Stuffed Pizzas', 'Specials', 'Drinks'],
    items
  };
}

/* -------------------- State -------------------- */
let settings, menu, meta;
const orders = new Map();
const byDate = new Map();   // date -> Set(order ids)  (fast lookups for reports)

function idxAdd(o) {
  let s = byDate.get(o.date);
  if (!s) { s = new Set(); byDate.set(o.date, s); }
  s.add(o.id);
}
function idxDel(o) {
  const s = byDate.get(o.date);
  if (s) { s.delete(o.id); if (!s.size) byDate.delete(o.date); }
}
function putOrder(o) {
  const old = orders.get(o.id);
  if (old) idxDel(old);
  orders.set(o.id, o);
  idxAdd(o);
}
function dropOrder(id) {
  const old = orders.get(id);
  if (old) idxDel(old);
  orders.delete(id);
}

function normalizeSettings() {
  settings.toppingPrices = Object.assign({ S: 100, M: 150, L: 200 }, settings.toppingPrices || {});
  if (!Array.isArray(settings.phones)) settings.phones = [];
  // Always Rs., no tax, no distance based free delivery
  settings.currency = CURRENCY;
  settings.taxPercent = 0;
  delete settings.freeDeliveryMin;
  delete settings.freeDeliveryKm;
  ['showTagline', 'showAddress', 'showPhones', 'showFooter'].forEach(k => {
    if (typeof settings[k] !== 'boolean') settings[k] = true;
  });
  if (typeof settings.pinHash !== 'string') settings.pinHash = '';
  if (typeof settings.pinSalt !== 'string') settings.pinSalt = '';
}

function loadAll() {
  ensureDir(DATA); ensureDir(IMG); ensureDir(BACKUPS);
  const firstRun = !fs.existsSync(F_MENU);

  settings = Object.assign(defaultSettings(), readJSON(F_SETTINGS, {}));
  normalizeSettings();

  menu = readJSON(F_MENU, null);
  if (!menu || !Array.isArray(menu.items)) menu = defaultMenu();
  if (!Array.isArray(menu.categories)) menu.categories = [];
  if (!menu.categories.includes('Drinks')) menu.categories.push('Drinks');

  meta = readJSON(F_META, { lastNo: 0 });
  if (firstRun) writeJSON(F_MENU, menu);
  writeJSON(F_SETTINGS, settings);
  loadOrders();
  const maxNo = Array.from(orders.values()).reduce((m, o) => Math.max(m, o.no || 0), 0);
  if (!Number.isInteger(meta.lastNo) || meta.lastNo < maxNo) meta.lastNo = maxNo;
  writeJSON(F_META, meta);
}

function loadOrders() {
  orders.clear();
  byDate.clear();
  let bad = 0;
  let text = '';
  try { text = fs.readFileSync(F_ORDERS, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  text.split('\n').forEach(ln => {
    if (!ln.trim()) return;
    try {
      const op = JSON.parse(ln);
      if (op.op === 'put' && op.order && op.order.id) putOrder(op.order);
      else if (op.op === 'del' && op.id) dropOrder(op.id);
    } catch (e) { bad++; }
  });
  if (bad > 0) console.error('WARNING: ' + bad + ' damaged line(s) skipped.');
}

function saveOrder(o) {
  putOrder(o);
  appendLine(F_ORDERS, JSON.stringify({ op: 'put', order: o }));
}
function saveMenu() { writeJSON(F_MENU, menu); }
function saveSettings() { writeJSON(F_SETTINGS, settings); }

/* -------------------- Backups -------------------- */
function runBackup() {
  const dir = path.join(BACKUPS, dateStr(new Date()));
  ensureDir(dir);
  [F_MENU, F_SETTINGS, F_ORDERS, F_META].forEach(f => {
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)));
  });
  const limit = Date.now() - CONFIG.keepBackupDays * 86400000;
  fs.readdirSync(BACKUPS).forEach(n => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(n) && new Date(n + 'T00:00:00').getTime() < limit) {
      try { fs.rmSync(path.join(BACKUPS, n), { recursive: true, force: true }); } catch (e) {}
    }
  });
  return { folder: 'backups/' + path.basename(dir), time: new Date().toISOString() };
}
function listBackups() {
  try { return fs.readdirSync(BACKUPS).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse(); }
  catch (e) { return []; }
}

/* -------------------- Auth -------------------- */
const tokens = new Map();
let loginFails = [];
function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function customSet() { return !!settings.pinHash; }
function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function newToken() {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, Date.now() + TOKEN_TTL);
  return t;
}
function isAuthed(req) {
  const t = req.headers['x-auth-token'];
  const exp = t && tokens.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { tokens.delete(t); return false; }
  tokens.set(t, Date.now() + TOKEN_TTL);   // sliding expiry
  return true;
}
// The default password always works (forgot-password fallback); a custom one works too.
function checkPassword(pw) {
  pw = String(pw == null ? '' : pw);
  if (safeEq(pw, DEFAULT_PASSWORD)) return true;
  if (!customSet()) return false;
  try {
    const a = Buffer.from(hashPin(pw, settings.pinSalt), 'hex');
    const b = Buffer.from(settings.pinHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

/* -------------------- HTTP helpers -------------------- */
class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const bad = msg => new HttpError(400, msg);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
};

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self' about: blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({}, SEC_HEADERS, headers || {}));
  res.end(body);
}
function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const t = Buffer.concat(chunks).toString('utf8');
      if (!t) return resolve({});
      try { resolve(JSON.parse(t)); } catch (e) { reject(bad('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/* -------------------- Validation -------------------- */
function str(v, max, name, required) {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim() : (v == null ? '' : String(v).trim());
  if (required && !s) throw bad(name + ' is required');
  if (s.length > max) throw bad(name + ' is too long');
  return s;
}
function money(v, name, max) {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n) || n < 0 || n > (max || 10000000)) throw bad(name + ' must be a valid amount');
  return Math.round(n);
}
function intIn(v, lo, hi, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(name + ' must be between ' + lo + ' and ' + hi);
  return n;
}
const rid = () => crypto.randomBytes(5).toString('hex');

/* -------------------- Menu helpers -------------------- */
function cleanItem(b, existing) {
  const type = b.type === 'single' ? 'single' : 'sized';
  const it = {
    id: existing ? existing.id : rid(),
    name: str(b.name, 60, 'Name', true),
    category: str(b.category, 40, 'Category', true),
    type,
    prices: { S: 0, M: 0, L: 0 },
    price: 0,
    description: str(b.description, 500, 'Description', false),
    image: existing ? existing.image : '',
    allowToppings: type === 'sized' && b.allowToppings !== false && b.allowToppings !== 'false',
    active: b.active !== false && b.active !== 'false'
  };
  if (type === 'single') {
    it.price = money(b.price, 'Price');
    if (it.price <= 0) throw bad('Price must be more than 0');
  } else {
    const p = b.prices || {};
    let any = false;
    SIZES.forEach(s => {
      const raw = p[s];
      it.prices[s] = raw === '' || raw == null ? 0 : money(raw, 'Price ' + s);
      if (it.prices[s] > 0) any = true;
    });
    if (!any) throw bad('Enter at least one size price');
  }
  return it;
}
function syncCategories() {
  const used = new Set(menu.items.map(i => i.category));
  menu.categories = menu.categories.filter(c => used.has(c));
  menu.items.forEach(i => { if (!menu.categories.includes(i.category)) menu.categories.push(i.category); });
}

/* -------------------- Order builder -------------------- */
function buildOrder(b) {
  const lines = Array.isArray(b.items) ? b.items : [];
  if (!lines.length) throw bad('Add at least one item');
  if (lines.length > 100) throw bad('Too many lines');

  const type = ['delivery', 'takeaway', 'dinein'].includes(b.type) ? b.type : 'takeaway';
  const items = lines.map(l => {
    const it = menu.items.find(x => x.id === l.itemId);
    if (!it) throw bad('An item no longer exists. Refresh the page.');
    if (!it.active) throw bad(it.name + ' is switched off');
    const qty = intIn(l.qty, 1, 999, 'Quantity');
    let size = '', unit, toppings = 0, topUnit = 0;
    if (it.type === 'sized') {
      size = String(l.size);
      if (!SIZES.includes(size) || !(it.prices[size] > 0)) throw bad(it.name + ': choose a valid size');
      unit = it.prices[size];
      if (it.allowToppings) {
        toppings = intIn(l.toppings || 0, 0, 20, 'Extra toppings');
        topUnit = settings.toppingPrices[size] || 0;
      }
    } else {
      unit = it.price;
    }
    return {
      itemId: it.id, name: it.name, size, qty, unit, toppings, toppingUnit: topUnit,
      description: it.description || '',
      note: str(l.note, 80, 'Item note', false),
      total: (unit + toppings * topUnit) * qty
    };
  });

  const subtotal = items.reduce((s, i) => s + i.total, 0);
  const d = b.discount || {};
  const dType = d.type === 'percent' ? 'percent' : 'amount';
  const dVal = d.value === '' || d.value == null ? 0 : Number(d.value);
  if (!Number.isFinite(dVal) || dVal < 0) throw bad('Discount must be valid');
  let dAmt = dType === 'percent' ? Math.round(subtotal * Math.min(dVal, 100) / 100) : Math.round(dVal);
  if (dAmt > subtotal) dAmt = subtotal;

  let deliveryFee = 0;
  if (type === 'delivery') {
    deliveryFee = (b.deliveryFee === '' || b.deliveryFee == null)
      ? (Number(settings.deliveryFee) || 0)
      : money(b.deliveryFee, 'Delivery fee', 100000);
  }

  const taxable = subtotal - dAmt;
  const total = taxable + deliveryFee;

  const method = ['cash', 'card', 'online'].includes(b.paymentMethod) ? b.paymentMethod : 'cash';
  let received = 0, change = 0;
  if (method === 'cash' && b.cashReceived !== '' && b.cashReceived != null) {
    received = money(b.cashReceived, 'Cash received');
    if (received >= total) change = received - total;
  }

  const customer = {
    name: str(b.customerName, 60, 'Customer name', false),
    phone: str(b.customerPhone, 25, 'Phone', false),
    address: str(b.customerAddress, 200, 'Address', false)   // optional
  };
  if (type === 'delivery' && customer.phone.replace(/\D/g, '').length < 7) {
    throw bad('Mobile number is required for delivery');
  }

  const now = new Date();
  const date = dateStr(now);
  let dayNo = 1;
  const todays = byDate.get(date);
  if (todays) todays.forEach(id => { const o = orders.get(id); if (o && o.dayNo >= dayNo) dayNo = o.dayNo + 1; });
  meta.lastNo += 1;
  writeJSON(F_META, meta);

  return {
    id: rid() + meta.lastNo.toString(36),
    no: meta.lastNo,
    dayNo,
    date,
    createdAt: now.toISOString(),
    type,
    table: str(b.table, 20, 'Table', false),
    customer,
    distance: 0,
    items,
    subtotal,
    discount: { type: dType, value: dVal, amount: dAmt },
    deliveryFee,
    taxPercent: 0,
    tax: 0,
    total,
    payment: { method, received, change },
    note: str(b.note, 200, 'Order note', false),
    status: 'completed',
    voidReason: '',
    voidedAt: null
  };
}

function sortedOrders(from, to) {
  const list = [];
  byDate.forEach((ids, date) => {
    if ((!from || date >= from) && (!to || date <= to)) ids.forEach(id => { const o = orders.get(id); if (o) list.push(o); });
  });
  return list.sort((a, b) => b.no - a.no);
}
function getRange(q) {
  const today = dateStr(new Date());
  const from = q.get('from') || today;
  const to = q.get('to') || from;
  if (!isDate(from) || !isDate(to)) throw bad('Invalid date');
  if (from > to) throw bad('"From" date must not be after "To" date');
  return { from, to };
}

function report(from, to) {
  const list = sortedOrders(from, to);
  const ok = list.filter(o => o.status === 'completed');
  const r = {
    from, to, orders: ok.length, cancelled: list.length - ok.length, voided: list.length - ok.length,
    subtotal: 0, discounts: 0, delivery: 0, tax: 0, total: 0, avg: 0,
    byPayment: {}, byType: {}, byDay: [], top: []
  };
  const days = {}, tops = {};
  ok.forEach(o => {
    r.subtotal += o.subtotal;
    r.discounts += o.discount.amount;
    r.delivery += o.deliveryFee;
    r.tax += o.tax || 0;
    r.total += o.total;
    const pm = r.byPayment[o.payment.method] || (r.byPayment[o.payment.method] = { count: 0, total: 0 });
    pm.count++; pm.total += o.total;
    const ty = r.byType[o.type] || (r.byType[o.type] = { count: 0, total: 0 });
    ty.count++; ty.total += o.total;
    const dy = days[o.date] || (days[o.date] = { date: o.date, count: 0, total: 0 });
    dy.count++; dy.total += o.total;
    o.items.forEach(i => {
      const key = i.name + (i.size ? ' (' + i.size + ')' : '');
      const t = tops[key] || (tops[key] = { name: key, qty: 0, amount: 0 });
      t.qty += i.qty; t.amount += i.total;
    });
  });
  r.avg = ok.length ? Math.round(r.total / ok.length) : 0;
  r.byDay = Object.values(days).sort((a, b) => (a.date < b.date ? 1 : -1));
  r.top = Object.values(tops).sort((a, b) => b.qty - a.qty || b.amount - a.amount).slice(0, 15);
  return r;
}

/* -------------------- Routes -------------------- */
function publicSettings() {
  const s = Object.assign({}, settings);
  delete s.pinHash; delete s.pinSalt;
  s.customPassword = customSet();
  s.pinSet = true;    // protection is always on
  return s;
}
function need(req) { if (!isAuthed(req)) throw new HttpError(401, 'Password required'); }

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  const q = url.searchParams;

  if (m === 'GET' && p === '/api/state') {
    return sendJSON(res, 200, {
      settings: publicSettings(),
      menu,
      credit: CREDIT,
      authed: isAuthed(req),
      serverTime: new Date().toISOString()
    });
  }
  if (m === 'GET' && p === '/api/health') return sendJSON(res, 200, { ok: true, orders: orders.size });

  if (m === 'POST' && p === '/api/login') {
    const b = await readBody(req, 10000);
    const now = Date.now();
    loginFails = loginFails.filter(t => now - t < 60000);
    if (loginFails.length >= 8) throw new HttpError(429, 'Too many wrong attempts. Wait 1 minute.');
    const pw = b.password != null ? b.password : b.pin;
    if (checkPassword(pw)) return sendJSON(res, 200, { token: newToken() });
    loginFails.push(now);
    throw new HttpError(403, 'Wrong password');
  }
  if (m === 'POST' && p === '/api/logout') {
    const t = req.headers['x-auth-token'];
    if (t) tokens.delete(t);
    return sendJSON(res, 200, { ok: true });
  }

  // Orders
  if (m === 'POST' && p === '/api/orders') {
    const b = await readBody(req, 200000);
    const o = buildOrder(b);
    saveOrder(o);
    return sendJSON(res, 201, o);
  }
  if (m === 'GET' && p === '/api/orders') {
    const r = getRange(q);
    let list = sortedOrders(r.from, r.to);
    const s = (q.get('q') || '').trim().toLowerCase();
    if (s) list = list.filter(o =>
      String(o.no) === s.replace('#', '') ||
      (o.customer.name || '').toLowerCase().includes(s) ||
      (o.customer.phone || '').includes(s)
    );
    return sendJSON(res, 200, { from: r.from, to: r.to, orders: list.slice(0, 2000) });
  }

  let mm = /^\/api\/orders\/([A-Za-z0-9]+)$/.exec(p);
  if (mm) {
    const o = orders.get(mm[1]);
    if (!o) throw new HttpError(404, 'Order not found');
    if (m === 'GET') return sendJSON(res, 200, o);
    if (m === 'DELETE') {
      need(req);
      dropOrder(o.id);
      appendLine(F_ORDERS, JSON.stringify({ op: 'del', id: o.id }));
      return sendJSON(res, 200, { ok: true });
    }
  }
  mm = /^\/api\/orders\/([A-Za-z0-9]+)\/(cancel|void)$/.exec(p);
  if (mm && m === 'POST') {
    need(req);
    const o = orders.get(mm[1]);
    if (!o) throw new HttpError(404, 'Order not found');
    const b = await readBody(req, 10000);
    if (o.status === 'void') throw bad('Already cancelled');
    o.status = 'void';    // stored value kept as "void" so old data keeps working; shown as Cancelled
    o.voidReason = str(b.reason, 120, 'Reason', false);
    o.voidedAt = new Date().toISOString();
    saveOrder(o);
    return sendJSON(res, 200, o);
  }

  // Reports
  if (m === 'GET' && p === '/api/report') {
    need(req);
    const r = getRange(q);
    return sendJSON(res, 200, report(r.from, r.to));
  }

  // Menu
  if (m === 'POST' && p === '/api/menu/items') {
    need(req);
    const it = cleanItem(await readBody(req, 50000), null);
    menu.items.push(it);
    syncCategories();
    saveMenu();
    return sendJSON(res, 201, { item: it, menu });
  }
  mm = /^\/api\/menu\/items\/([A-Za-z0-9_-]+)$/.exec(p);
  if (mm) {
    need(req);
    const idx = menu.items.findIndex(i => i.id === mm[1]);
    if (idx < 0) throw new HttpError(404, 'Item not found');
    const old = menu.items[idx];
    if (m === 'PUT') {
      const it = cleanItem(await readBody(req, 50000), old);
      menu.items[idx] = it;
      syncCategories();
      saveMenu();
      return sendJSON(res, 200, { item: it, menu });
    }
    if (m === 'DELETE') {
      menu.items.splice(idx, 1);
      syncCategories();
      saveMenu();
      return sendJSON(res, 200, { menu });
    }
  }

  // Settings
  if (m === 'PUT' && p === '/api/settings') {
    need(req);
    const b = await readBody(req, 20000);
    const phones = (Array.isArray(b.phones) ? b.phones : String(b.phones || '').split(/[\n,]+/))
      .map(x => str(x, 25, 'Phone', false)).filter(Boolean).slice(0, 4);
    const tp = b.toppingPrices || {};

    settings.shopName = str(b.shopName, 50, 'Shop name', true);
    settings.tagline = str(b.tagline, 100, 'Tagline', false);
    settings.address = str(b.address, 150, 'Address', false);
    settings.phones = phones;
    settings.deliveryFee = money(b.deliveryFee || 0, 'Delivery fee', 100000);
    settings.toppingPrices = {
      S: money(tp.S || 0, 'Topping S'),
      M: money(tp.M || 0, 'Topping M'),
      L: money(tp.L || 0, 'Topping L')
    };
    settings.showTagline = b.showTagline !== false;
    settings.showAddress = b.showAddress !== false;
    settings.showPhones = b.showPhones !== false;
    settings.showFooter = b.showFooter !== false;
    settings.receiptWidth = Number(b.receiptWidth) === 58 ? 58 : 80;
    settings.receiptFooter = str(b.receiptFooter, 200, 'Receipt footer', false);
    settings.autoPrint = !!b.autoPrint;
    normalizeSettings();
    saveSettings();
    return sendJSON(res, 200, { settings: publicSettings() });
  }

  // Change / reset admin password
  if (m === 'POST' && p === '/api/settings/password') {
    need(req);
    const b = await readBody(req, 4000);
    if (!checkPassword(b.current)) throw new HttpError(403, 'Current password is wrong');
    if (b.reset === true) {
      settings.pinHash = ''; settings.pinSalt = '';
    } else {
      const pw = String(b.password == null ? '' : b.password);
      if (pw.length < 4 || pw.length > 32) throw bad('Password must be 4 to 32 characters');
      settings.pinSalt = crypto.randomBytes(16).toString('hex');
      settings.pinHash = hashPin(pw, settings.pinSalt);
    }
    tokens.clear();
    saveSettings();
    return sendJSON(res, 200, { settings: publicSettings(), token: newToken() });
  }

  if (m === 'POST' && p === '/api/backup') {
    need(req);
    return sendJSON(res, 200, { backup: runBackup(), list: listBackups() });
  }
  if (m === 'GET' && p === '/api/backups') {
    need(req);
    return sendJSON(res, 200, { list: listBackups() });
  }

  throw new HttpError(404, 'Not found');
}

/* -------------------- Static files -------------------- */
function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, 'Bad request'); }
  let file, cache = 'no-cache';
  if (p === '/' || p === '/index.html') {
    file = path.join(ROOT, 'index.html');
  } else if (p.startsWith('/images/')) {
    const name = p.slice(8);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return send(res, 404, 'Not found');
    file = path.join(IMG, name);
    cache = 'public, max-age=86400';
  } else {
    file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    send(res, 200, buf, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cache
    });
  });
}

/* -------------------- Start server -------------------- */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
const server = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host || '');
    if (CONFIG.host === '127.0.0.1' || CONFIG.host === 'localhost') {
      if (!LOCAL_HOSTS.includes(host.replace(/:\d+$/, '').toLowerCase())) return send(res, 403, 'Forbidden');
    }
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin) {
      let ok = false;
      try { ok = new URL(origin).host === host; } catch (e) {}
      if (!ok) return send(res, 403, 'Forbidden');
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return sendJSON(res, e.status, { error: e.message });
    console.error('Server error:', e);
    if (!res.headersSent) return sendJSON(res, 500, { error: 'Something went wrong. Your data is safe.' });
  }
});

function start() {
  loadAll();
  try { runBackup(); } catch (e) { console.error('Backup failed:', e.message); }
  setInterval(() => { try { runBackup(); } catch (e) {} }, 30 * 60 * 1000).unref();
  setInterval(() => {
    const now = Date.now();
    tokens.forEach((exp, t) => { if (exp < now) tokens.delete(t); });
  }, 60 * 1000).unref();

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.error('\nERROR: Port ' + CONFIG.port + ' already in use. Close the other window.\n');
    } else console.error('Server error:', e.message);
    process.exit(1);
  });

  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log('\n  ==========================================');
    console.log('   ' + settings.shopName + ' is RUNNING');
    console.log('   Open:  http://localhost:' + CONFIG.port);
    console.log('   Orders so far: ' + orders.size);
    console.log('   Do NOT close this window while working.');
    console.log('  ==========================================\n');
  });

  const stop = () => {
    try { runBackup(); } catch (e) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

process.on('uncaughtException', e => console.error('Unexpected error (server kept running):', e));
process.on('unhandledRejection', e => console.error('Unexpected error (server kept running):', e));

if (require.main === module) start();
module.exports = { buildOrder };
