import { Router } from 'express';
import db from '../db.js';
import * as epay from '../services/epay.js';
import { requireLogin, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(requireLogin);
router.use(requireAdmin);

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

router.post('/products', (req, res) => {
  const { name, description, price, stock, sort, status } = req.body;
  db.prepare(
    `INSERT INTO products (name, description, price, stock, sort, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    name || '未命名',
    description || '',
    Number(price) || 0,
    Number(stock) || 0,
    Number(sort) || 0,
    status === '1' ? 1 : 0
  );
  res.redirect('/admin/products');
});

router.post('/products/:id', (req, res) => {
  const { name, description, price, stock, sort, status } = req.body;
  db.prepare(
    `UPDATE products SET name=?, description=?, price=?, stock=?, sort=?, status=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    name || '未命名',
    description || '',
    Number(price) || 0,
    Number(stock) || 0,
    Number(sort) || 0,
    status === '1' ? 1 : 0,
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

router.post('/orders/:id/refund', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = ?').get(req.params.id, 'paid');
  if (!order || !order.epay_trade_no) {
    return res.redirect('/admin/orders?error=refund');
  }
  try {
    const result = await epay.refund(order.epay_trade_no, order.amount);
    if (result.code === 1) {
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('refunded', order.id);
      const cards = db.prepare('SELECT id FROM cards WHERE order_id = ?').all(order.id);
      for (const c of cards) {
        db.prepare('UPDATE cards SET used = 0, order_id = NULL WHERE id = ?').run(c.id);
      }
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(cards.length, order.product_id);
    }
  } catch (e) {
    console.error('Refund error:', e);
  }
  res.redirect('/admin/orders');
});

export default router;
