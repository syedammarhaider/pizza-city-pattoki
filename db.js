// db.js
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
const backupDir = path.join(__dirname, 'backups');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });

// PIZZA_CITY_DB env var overrides the database path (used by bench.js/tests).
const dbPath = process.env.PIZZA_CITY_DB
  ? path.resolve(process.env.PIZZA_CITY_DB)
  : path.join(dataDir, 'pizza_city.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'sized',
    price REAL NOT NULL DEFAULT 0,
    prices_json TEXT NOT NULL,
    description TEXT DEFAULT '',
    image_path TEXT DEFAULT '',
    allow_toppings INTEGER NOT NULL DEFAULT 1,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_menu_category ON menu_items(category);
  CREATE INDEX IF NOT EXISTS idx_menu_hidden ON menu_items(is_hidden);

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    order_number INTEGER,
    order_type TEXT NOT NULL DEFAULT 'takeaway',
    payment_method TEXT NOT NULL DEFAULT 'cash',
    subtotal REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    delivery_fee REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    items_json TEXT NOT NULL,
    customer_phone TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(date);
  CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(order_type);
  CREATE INDEX IF NOT EXISTS idx_orders_no ON orders(order_number);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Migration: day_no column for fast daily token numbers (added after v4).
const orderCols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
if (!orderCols.includes('day_no')) {
  db.exec('ALTER TABLE orders ADD COLUMN day_no INTEGER');
  const rows = db.prepare('SELECT id, data_json FROM orders WHERE day_no IS NULL').all();
  const upd = db.prepare('UPDATE orders SET day_no = ? WHERE id = ?');
  const backfill = db.transaction(rs => {
    for (const r of rs) {
      try { upd.run(JSON.parse(r.data_json).dayNo || 0, r.id); } catch (e) {}
    }
  });
  backfill(rows);
}

module.exports = { db };

