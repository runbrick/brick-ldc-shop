import { Router } from 'express';
import db from '../db.js';
import * as epay from '../services/epay.js';
import { requireLogin, requireAdmin } from '../middleware/auth.js';
import { uploadSingle, uploadCover, uploadBackground, getUploadUrl } from '../middleware/upload.js';

const router = Router();
router.use(requireLogin);
router.use(requireAdmin);

router.get('/settings', (req, res) => {
  const get = (k) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value || '';
  res.render('admin/settings', {
    title: '设置',
    user: req.session.user,
    siteName: get('site_name'),
    siteFooterText: get('site_footer_text'),
    siteBackground: get('site_background'),
  });
});

router.post('/settings', uploadBackground, (req, res) => {
  const siteName = (req.body.site_name || '').trim().slice(0, 64);
  const siteFooterText = (req.body.site_footer_text || '').trim();
  const currentBg = (db.prepare('SELECT value FROM settings WHERE key = ?').get('site_background') || {}).value || '';
  const siteBackground = req.file ? getUploadUrl(req.file.filename) : currentBg;
  db.setSetting('site_name', siteName);
  db.setSetting('site_footer_text', siteFooterText.slice(0, 4096));
  db.setSetting('site_background', siteBackground);
  res.redirect('/admin/settings?ok=1');
});

router.post('/upload/image', uploadSingle, (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: '未选择文件' });
  res.json({ ok: true, url: getUploadUrl(req.file.filename) });
});

router.get('/', (req, res) => {
  const stats = {
    products: db.prepare('SELECT COUNT(*) as c FROM products').get().c,
    orders: db.prepare('SELECT COUNT(*) as c FROM orders').get().c,
    paidOrders: db.prepare('SELECT COUNT(*) as c FROM orders WHERE status = ?').get('paid').c,
    totalAmount: db.prepare('SELECT COALESCE(SUM(amount), 0) as s FROM orders WHERE status = ?').get('paid').s,
  };
  res.render('admin/dashboard', { title: '后台首页', user: req.session.user, stats });
});

// 商品列表
router.get('/products', (req, res) => {
  const list = db.prepare('SELECT * FROM products ORDER BY sort DESC, id DESC').all();
  res.render('admin/products', { title: '商品管理', user: req.session.user, products: list });
});

router.get('/products/new', (req, res) => {
  res.render('admin/product-form', { title: '新建商品', user: req.session.user, product: null });
});

router.get('/products/:id/edit', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/admin/products');
  res.render('admin/product-form', { title: '编辑商品', user: req.session.user, product });
});

router.post('/products', uploadCover, (req, res) => {
  const { name, description, price, stock, sort, status, card_mode } = req.body;
  const cover = req.file ? getUploadUrl(req.file.filename) : '';
  const stockNum = Number(stock);
  const cardMode = card_mode === '1' ? 1 : 0;
  db.prepare(
    `INSERT INTO products (name, description, price, stock, sort, status, cover_image, card_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name || '未命名',
    description || '',
    Number(price) || 0,
    isNaN(stockNum) ? 0 : stockNum,
    Number(sort) || 0,
    status === '1' ? 1 : 0,
    cover,
    cardMode
  );
  res.redirect('/admin/products');
});

router.post('/products/:id', uploadCover, (req, res) => {
  const { name, description, price, stock, sort, status, card_mode } = req.body;
  const cover = req.file ? getUploadUrl(req.file.filename) : null;
  const current = db.prepare('SELECT cover_image FROM products WHERE id = ?').get(req.params.id);
  const coverImage = cover !== null ? cover : (current && current.cover_image) || '';
  const stockNum = Number(stock);
  const cardMode = card_mode === '1' ? 1 : 0;
  db.prepare(
    `UPDATE products SET name=?, description=?, price=?, stock=?, sort=?, status=?, cover_image=?, card_mode=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    name || '未命名',
    description || '',
    Number(price) || 0,
    isNaN(stockNum) ? 0 : stockNum,
    Number(sort) || 0,
    status === '1' ? 1 : 0,
    coverImage,
    cardMode,
    req.params.id
  );
  res.redirect('/admin/products');
});

router.post('/products/:id/delete', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.redirect('/admin/products');
});

// 卡密
router.get('/products/:id/cards', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/admin/products');
  const cards = db.prepare(
    'SELECT * FROM cards WHERE product_id = ? ORDER BY used, id DESC LIMIT 500'
  ).all(req.params.id);
  res.render('admin/cards', { title: '卡密管理', user: req.session.user, product, cards });
});

router.post('/products/:id/cards', (req, res) => {
  const content = (req.body.content || '').trim();
  if (!content) return res.redirect('/admin/products/' + req.params.id + '/cards');
  const lines = content.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const ins = db.prepare('INSERT INTO cards (product_id, card_content) VALUES (?, ?)');
  for (const line of lines) {
    ins.run(req.params.id, line.slice(0, 500));
  }
  db.prepare(
    'UPDATE products SET stock = (SELECT COUNT(*) FROM cards WHERE product_id = ? AND used = 0), updated_at = datetime("now") WHERE id = ?'
  ).run(req.params.id, req.params.id);
  res.redirect('/admin/products/' + req.params.id + '/cards');
});

// 订单
router.get('/orders', (req, res) => {
  const list = db.prepare(
    'SELECT * FROM orders ORDER BY id DESC LIMIT 200'
  ).all();
  res.render('admin/orders', { title: '订单管理', user: req.session.user, orders: list, query: req.query });
});

// 用户管理
router.get('/users', (req, res) => {
  const list = db.prepare(`
    SELECT u.id, u.linux_do_id, u.username, u.avatar_url, u.email, u.created_at, u.is_admin,
    (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) as order_count
    FROM users u
    ORDER BY u.id DESC
    LIMIT 500
  `).all();
  res.render('admin/users', { title: '用户管理', user: req.session.user, users: list, query: req.query });
});

router.post('/users/:id/admin', (req, res) => {
  const targetId = Number(req.params.id);
  const currentUserId = req.session.user?.id;
  if (targetId === currentUserId) {
    return res.redirect('/admin/users?error=self');
  }
  const row = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(targetId);
  if (!row) return res.redirect('/admin/users?error=notfound');
  const nextAdmin = row.is_admin === 1 ? 0 : 1;
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(nextAdmin, targetId);
  res.redirect('/admin/users?ok=1');
});

function markOrderRefundedAndRollback(order) {
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('refunded', order.id);
  const cards = db.prepare('SELECT id FROM cards WHERE order_id = ?').all(order.id);
  if (cards.length > 0) {
    for (const c of cards) {
      db.prepare('UPDATE cards SET used = 0, order_id = NULL WHERE id = ?').run(c.id);
    }
    const product = db.prepare('SELECT stock FROM products WHERE id = ?').get(order.product_id);
    if (product && product.stock >= 0) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(cards.length, order.product_id);
    }
  }
}

router.post('/orders/:id/refund', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = ?').get(req.params.id, 'paid');
  if (!order || !order.epay_trade_no) {
    return res.redirect('/admin/orders?error=refund');
  }
  try {
    const result = await epay.refund(order.epay_trade_no, order.amount);
    const msg = (result && result.msg) ? String(result.msg) : '';
    if (result && result.code === 1) {
      markOrderRefundedAndRollback(order);
      return res.redirect('/admin/orders?refund=ok');
    }
    if (msg.includes('已完成') || msg.includes('已退回')) {
      markOrderRefundedAndRollback(order);
      return res.redirect('/admin/orders?refund=ok&synced=1');
    }
    return res.redirect('/admin/orders?error=refund&msg=' + encodeURIComponent(msg || 'refund_fail'));
  } catch (e) {
    console.error('Refund error:', e);
    return res.redirect('/admin/orders?error=refund&msg=' + encodeURIComponent(e.message || '网络或接口异常'));
  }
});

export default router;
