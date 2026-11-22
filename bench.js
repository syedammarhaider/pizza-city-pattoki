'use strict';
/*
 * Pizza City POS - scale benchmark.
 *
 * Copies the live database to a throwaway bench DB, bulk-inserts synthetic
 * orders, then measures:
 *   1) how long/memory it takes to load ALL orders into memory (old design)
 *   2) how fast SQL reports are (new design)
 *
 * The live data/pizza_city.db is NEVER modified.
 *
 * Usage:  node bench.js [orders]     default 200000
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const N = Number(process.argv[2]) || 200000;
const DAYS = Math.ceil(N / 1000);              // simulate 1000 orders/day
const SRC = path.join(__dirname, 'data', 'pizza_city.db');
const DST = path.join(os.tmpdir(), 'pizza_city_bench.db');

function mb() { return Math.round(process.memoryUsage().rss / 1048576); }

console.log('Bench DB:', DST);
console.log('Orders to insert:', N, ' (~' + DAYS + ' days at 1000/day)\n');

// fresh copy of the real schema+data
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DST + ext); } catch (e) {} }
fs.copyFileSync(SRC, DST);
const db = new Database(DST);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = OFF');               // bench only: speed up bulk load
db.pragma('busy_timeout = 5000');

const cols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
const hasDayNo = cols.includes('day_no');

// ---------- 1) bulk insert synthetic orders ----------
const names = ['Ahmed', 'Bilal', 'Usman', 'Ali Raza', 'Hassan', 'Fatima', 'Sara', 'Zain'];
const phones = ['03001234567', '03219876543', '03335556677', '03441239876'];
const itemsPool = [
  { itemId: 'chicken-tikka', name: 'Chicken Tikka Pizza', size: 'L', qty: 1, unit: 950, toppings: 2, toppingUnit: 200, total: 1350 },
  { itemId: 'deal2', name: 'Deal 2', size: '', qty: 1, unit: 2050, toppings: 0, toppingUnit: 0, total: 2050 },
  { itemId: 'drink-15', name: 'Cold Drink 1.5 Ltr', size: '', qty: 2, unit: 180, toppings: 0, toppingUnit: 0, total: 360 }
];

function makeOrder(i) {
  const dayOffset = Math.floor(i / 1000);
  const d = new Date(Date.now() - dayOffset * 86400000);
  const date = d.toISOString().slice(0, 10);
  const no = 100000 + i;
  const dayNo = (i % 1000) + 1;
  const type = i % 10 === 0 ? 'delivery' : (i % 7 === 0 ? 'dinein' : 'takeaway');
  const pay = i % 5 === 0 ? 'card' : 'cash';
  const its = [itemsPool[i % 3]];
  if (i % 4 === 0) its.push(itemsPool[(i + 1) % 3]);
  const subtotal = its.reduce((s, x) => s + x.total, 0);
  const deliveryFee = type === 'delivery' ? 150 : 0;
  const total = subtotal + deliveryFee;
  const o = {
    id: 'bench' + no.toString(36) + i.toString(36), no, dayNo, date,
    createdAt: d.toISOString(), type, table: type === 'dinein' ? 'T' + (i % 12) : '',
    customer: { name: names[i % names.length], phone: phones[i % phones.length], address: 'Street ' + (i % 40) },
    distance: 0, items: its, subtotal,
    discount: { type: 'amount', value: 0, amount: 0 }, deliveryFee, taxPercent: 0, tax: 0, total,
    payment: { method: pay, received: pay === 'cash' ? total + 500 : 0, change: pay === 'cash' ? 500 : 0 },
    note: '', status: i % 97 === 0 ? 'void' : 'completed', voidReason: '', voidedAt: null
  };
  return o;
}

const insertCols = cols.filter(c => c !== 'id');
const placeholders = insertCols.map(() => '?').join(',');
const ins = db.prepare(
  'INSERT INTO orders (id,' + insertCols.join(',') + ') VALUES (?,' + placeholders + ')'
);

console.log('Inserting...');
let t0 = Date.now();
const tx = db.transaction(() => {
  for (let i = 0; i < N; i++) {
    const o = makeOrder(i);
    const itemsJson = JSON.stringify(o.items);
    const vals = {
      id: o.id, order_number: o.no, order_type: o.type, payment_method: o.payment.method,
      subtotal: o.subtotal, discount: o.discount.amount, delivery_fee: o.deliveryFee,
      total: o.total, items_json: itemsJson, customer_phone: o.customer.phone,
      note: '', status: o.status, date: o.date, created_at: o.createdAt, data_json: JSON.stringify(o)
    };
    if (hasDayNo) vals.day_no = o.dayNo;
    ins.run(...[o.id, ...insertCols.map(c => vals[c] ?? null)]);
  }
});
tx();
console.log('  inserted ' + N + ' orders in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('  db file size: ' + (fs.statSync(DST).size / 1048576).toFixed(1) + ' MB, rss: ' + mb() + ' MB\n');

// ---------- 2) OLD design: load everything into memory ----------
// (skipped for huge datasets - it would exhaust RAM, which is the point)
if (N <= 500000) {
console.log('--- OLD DESIGN: load all orders into JS memory ---');
global.gc && global.gc();
const rssBefore = mb();
t0 = Date.now();
const rows = db.prepare('SELECT data_json FROM orders').all();
const map = new Map();
const byDate = new Map();
for (const r of rows) {
  const o = JSON.parse(r.data_json);
  map.set(o.id, o);
  let s = byDate.get(o.date);
  if (!s) { s = new Set(); byDate.set(o.date, s); }
  s.add(o.id);
}
const loadMs = Date.now() - t0;
console.log('  loaded ' + map.size + ' orders in ' + (loadMs / 1000).toFixed(1) + 's');
console.log('  memory used by orders: ~' + (mb() - rssBefore) + ' MB (total rss ' + mb() + ' MB)');

// old-style report over last 30 days
t0 = Date.now();
const today = new Date();
const from = new Date(today.getTime() - 29 * 86400000).toISOString().slice(0, 10);
const to = today.toISOString().slice(0, 10);
let cnt = 0, sum = 0;
byDate.forEach((ids, date) => {
  if (date >= from && date <= to) ids.forEach(id => { const o = map.get(id); if (o && o.status === 'completed') { cnt++; sum += o.total; } });
});
console.log('  old report(30d): ' + (Date.now() - t0) + 'ms  orders=' + cnt + ' total=' + sum);
} else {
  console.log('--- OLD DESIGN: skipped (' + N + ' orders would need ~' + Math.round(N * 1.6 / 1024) + ' GB RAM) ---');
}

// ---------- 3) NEW design: pure SQL ----------
console.log('\n--- NEW DESIGN: SQL queries ---');
const t = (label, fn) => { const s = Date.now(); const r = fn(); console.log('  ' + label + ': ' + (Date.now() - s) + 'ms' + (r !== undefined ? ' -> ' + JSON.stringify(r).slice(0, 120) : '')); };

t('count all', () => db.prepare('SELECT COUNT(*) c FROM orders').get().c);
t('report 1 day (aggregates)', () => db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(total),0) t FROM orders WHERE date=? AND status='completed'`).get(to));
t('report 30 days (aggregates)', () => db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(total),0) t, COALESCE(SUM(subtotal),0) st, COALESCE(SUM(discount),0) d, COALESCE(SUM(delivery_fee),0) df FROM orders WHERE date BETWEEN ? AND ? AND status='completed'`).get(from, to));
t('byDay 30 days', () => db.prepare(`SELECT date, COUNT(*) c, SUM(total) t FROM orders WHERE date BETWEEN ? AND ? AND status='completed' GROUP BY date ORDER BY date DESC`).all(from, to).length + ' rows');
t('byPayment 30 days', () => db.prepare(`SELECT payment_method, COUNT(*) c, SUM(total) t FROM orders WHERE date BETWEEN ? AND ? AND status='completed' GROUP BY payment_method`).all(from, to));
t('top items 1 day (parse items_json)', () => {
  const rows2 = db.prepare(`SELECT items_json FROM orders WHERE date=? AND status='completed'`).all(to);
  const tops = {};
  for (const r of rows2) for (const i of JSON.parse(r.items_json)) { const k = i.name + (i.size ? ' (' + i.size + ')' : ''); (tops[k] = tops[k] || { qty: 0, amount: 0 }); tops[k].qty += i.qty; tops[k].amount += i.total; }
  return Object.keys(tops).length + ' items';
});
t('order list 1 day LIMIT 2000', () => db.prepare(`SELECT data_json FROM orders WHERE date BETWEEN ? AND ? ORDER BY order_number DESC LIMIT 2000`).all(to, to).length + ' rows');
t('order lookup by id', () => !!db.prepare('SELECT 1 x FROM orders WHERE id=?').get('bench1'));
t('next day_no', () => db.prepare('SELECT COALESCE(MAX(day_no),0)+1 n FROM orders WHERE date=?').get(to));

// ---------- 4) full-range worst case ----------
console.log('\n--- WORST CASE: report over ALL ' + DAYS + ' days ---');
t('aggregates only', () => db.prepare(`SELECT COUNT(*) c, SUM(total) t FROM orders WHERE status='completed'`).get());
t('top items (parse ' + N + ' rows, streamed)', () => {
  let n = 0;
  for (const r of db.prepare(`SELECT items_json FROM orders WHERE status='completed'`).iterate()) n += JSON.parse(r.items_json).length;
  return n + ' item lines';
});

console.log('\nFinal rss: ' + mb() + ' MB');
db.close();
