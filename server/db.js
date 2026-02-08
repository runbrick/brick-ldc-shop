/**
 * 使用 sql.js（纯 JS，无需 node-gyp 编译），兼容 better-sqlite3 的 prepare().run/get/all API
 */
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SQLITE_PATH || join(__dirname, '..', 'data', 'shop.db');

let SQL = null;
let db = null;

function save() {
  if (!db) return;
  try {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = db.export();
    writeFileSync(dbPath, Buffer.from(data));
  } catch (e) {
    console.warn('db save warning:', e.message);
  }
}

function createStmt(sql) {
  const stmt = db.prepare(sql);
  return {
    run(...params) {
      if (params.length) stmt.bind(params);
      stmt.run();
      stmt.free();
      save();
    },
    get(...params) {
      if (params.length) stmt.bind(params);
      const row = stmt.step() ? stmt.getAsObject() : undefined;
      stmt.free();
      return row;
    },
    all(...params) {
      if (params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
  };
}

const schema = `
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    card_content TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    order_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL UNIQUE,
    user_id INTEGER,
    username TEXT,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    amount REAL NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    epay_trade_no TEXT,
    contact TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    paid_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    linux_do_id TEXT UNIQUE,
    username TEXT NOT NULL,
    avatar_url TEXT,
    email TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no);
  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_cards_product ON cards(product_id);
  CREATE INDEX IF NOT EXISTS idx_cards_used ON cards(used);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    expire INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
`;

function migrate() {
  try {
    const infoProducts = db.exec("PRAGMA table_info(products)");
    const colsP = infoProducts[0] && infoProducts[0].values ? infoProducts[0].values : [];
    if (!colsP.some((r) => r[1] === 'cover_image')) db.run("ALTER TABLE products ADD COLUMN cover_image TEXT");
    if (!colsP.some((r) => r[1] === 'card_mode')) db.run("ALTER TABLE products ADD COLUMN card_mode INTEGER DEFAULT 0");
    const infoOrders = db.exec("PRAGMA table_info(orders)");
    const colsO = infoOrders[0] && infoOrders[0].values ? infoOrders[0].values : [];
    if (!colsO.some((r) => r[1] === 'delivered_cards')) db.run("ALTER TABLE orders ADD COLUMN delivered_cards TEXT");
    const infoUsers = db.exec("PRAGMA table_info(users)");
    const colsU = infoUsers[0] && infoUsers[0].values ? infoUsers[0].values : [];
    if (!colsU.some((r) => r[1] === 'is_admin')) db.run("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
    if (!colsU.some((r) => r[1] === 'refresh_token')) db.run("ALTER TABLE users ADD COLUMN refresh_token TEXT");
    if (!colsU.some((r) => r[1] === 'token_expires_at')) db.run("ALTER TABLE users ADD COLUMN token_expires_at TEXT");
    try {
      db.exec("SELECT 1 FROM sessions LIMIT 1");
    } catch (_) {
      db.run("CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, session TEXT NOT NULL, expire INTEGER NOT NULL)");
      db.run("CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)");
    }
  } catch (_) {}
}

const api = {
  prepare(sql) {
    if (!db) throw new Error('Database not initialized. Call await init() first.');
    return createStmt(sql);
  },
  getSetting(key) {
    const row = this.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  setSetting(key, value) {
    this.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''));
  },
};

export async function init() {
  if (db) return api;
  SQL = await initSqlJs();
  if (existsSync(dbPath)) {
    const buf = readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.exec(schema);
  migrate();
  save();
  return api;
}

export default api;
