import { Router } from 'express';
import db from '../db.js';
import * as epay from '../services/epay.js';
import { markOrderRefundedAndRollback } from './api-pay.js';
import { logPayment } from '../services/payment-log.js';
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

// 支付日志（支付信息、回调、退款等）
router.get('/payment-logs', (req, res) => {
  const orderNo = (req.query.order_no || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  let list;
  let total;
  let totalPages;
  if (orderNo) {
    total = db.prepare('SELECT COUNT(*) as c FROM payment_logs WHERE order_no = ?').get(orderNo).c;
    totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const p = Math.min(page, totalPages);
    list = db.prepare(
      'SELECT * FROM payment_logs WHERE order_no = ? ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(orderNo, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    res.render('admin/payment-logs', {
      title: '支付日志',
      user: req.session.user,
      logs: list,
      pagination: { page: p, pageSize: PAGE_SIZE, total, totalPages },
      query: req.query,
    });
  } else {
    total = db.prepare('SELECT COUNT(*) as c FROM payment_logs').get().c;
    totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const p = Math.min(page, totalPages);
    list = db.prepare(
      'SELECT * FROM payment_logs ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(PAGE_SIZE, (p - 1) * PAGE_SIZE);
    res.render('admin/payment-logs', {
      title: '支付日志',
      user: req.session.user,
      logs: list,
      pagination: { page: p, pageSize: PAGE_SIZE, total, totalPages },
      query: req.query,
    });
  }
});

// 分类管理（二级：parent_id 为空为一级，非空为二级）
function getCategoryTree() {
  const all = db.prepare('SELECT * FROM categories ORDER BY sort DESC, name ASC').all();
  const roots = all.filter((c) => !c.parent_id);
  const byParent = {};
  all.forEach((c) => {
    const pid = c.parent_id || 0;
    if (!byParent[pid]) byParent[pid] = [];
    byParent[pid].push(c);
  });
  roots.forEach((r) => { r.children = byParent[r.id] || []; });
  return roots;
}

router.get('/categories', (req, res) => {
  const tree = getCategoryTree();
  res.render('admin/categories', { title: '分类管理', user: req.session.user, categoryTree: tree });
});

router.post('/categories', (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 32);
  const sort = Number(req.body.sort) || 0;
  const parentId = req.body.parent_id === '' || req.body.parent_id === undefined ? null : Number(req.body.parent_id);
  if (!name) return res.redirect('/admin/categories');
  try {
    db.prepare('INSERT INTO categories (name, sort, parent_id) VALUES (?, ?, ?)').run(name, sort, parentId || null);
  } catch (e) {
    if (!e.message || !e.message.includes('UNIQUE')) throw e;
  }
  res.redirect('/admin/categories');
});

router.post('/categories/:id', (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 32);
  const sort = Number(req.body.sort) || 0;
  const parentId = req.body.parent_id === '' || req.body.parent_id === undefined ? null : Number(req.body.parent_id);
  const id = req.params.id;
  if (!name) return res.redirect('/admin/categories');
  if (parentId === Number(id)) return res.redirect('/admin/categories');
  try {
    db.prepare('UPDATE categories SET name = ?, sort = ?, parent_id = ? WHERE id = ?').run(name, sort, parentId || null, id);
  } catch (e) {
    if (!e.message || !e.message.includes('UNIQUE')) throw e;
  }
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', (req, res) => {
  const id = req.params.id;
  const hasChildren = db.prepare('SELECT 1 FROM categories WHERE parent_id = ? LIMIT 1').get(id);
  if (hasChildren) return res.redirect('/admin/categories?err=has_children');
  db.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.redirect('/admin/categories');
});

const PAGE_SIZE = 20;

// 商品列表
router.get('/products', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const total = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(page, totalPages);
  const list = db.prepare('SELECT * FROM products ORDER BY sort DESC, id DESC LIMIT ? OFFSET ?')
    .all(PAGE_SIZE, (p - 1) * PAGE_SIZE);
  res.render('admin/products', {
    title: '商品管理',
    user: req.session.user,
    products: list,
    pagination: { page: p, pageSize: PAGE_SIZE, total, totalPages },
    query: req.query,
  });
});

router.get('/products/new', (req, res) => {
  const categoryTree = getCategoryTree();
  res.render('admin/product-form', { title: '新建商品', user: req.session.user, product: null, categoryTree });
});

router.get('/products/:id/edit', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/admin/products');
  const categoryTree = getCategoryTree();
  res.render('admin/product-form', { title: '编辑商品', user: req.session.user, product, categoryTree });
});

router.post('/products', uploadCover, (req, res) => {
  const { name, description, price, stock, sort, status, card_mode, category_id } = req.body;
  const cover = req.file ? getUploadUrl(req.file.filename) : '';
  const stockNum = Number(stock);
  const cardMode = card_mode === '1' ? 1 : 0;
  const catId = category_id ? Number(category_id) : null;
  db.prepare(
    `INSERT INTO products (name, description, price, stock, sort, status, cover_image, card_mode, category_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name || '未命名',
    description || '',
    Number(price) || 0,
    isNaN(stockNum) ? 0 : stockNum,
    Number(sort) || 0,
    status === '1' ? 1 : 0,
    cover,
    cardMode,
    catId
  );
  res.redirect('/admin/products');
});

router.post('/products/:id', uploadCover, (req, res) => {
  const { name, description, price, stock, sort, status, card_mode, category_id } = req.body;
  const cover = req.file ? getUploadUrl(req.file.filename) : null;
  const current = db.prepare('SELECT cover_image FROM products WHERE id = ?').get(req.params.id);
  const coverImage = cover !== null ? cover : (current && current.cover_image) || '';
  const stockNum = Number(stock);
  const cardMode = card_mode === '1' ? 1 : 0;
  const catId = category_id ? Number(category_id) : null;
  db.prepare(
    `UPDATE products SET name=?, description=?, price=?, stock=?, sort=?, status=?, cover_image=?, card_mode=?, category_id=?, updated_at=datetime('now')
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
    catId,
    req.params.id
  );
  res.redirect('/admin/products');
});

router.post('/products/:id/toggle-status', (req, res) => {
  const product = db.prepare('SELECT id, status FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/admin/products');
  const nextStatus = product.status === 1 ? 0 : 1;
  db.prepare('UPDATE products SET status = ?, updated_at = datetime("now") WHERE id = ?').run(nextStatus, req.params.id);
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
  const productId = req.params.id;
  for (const line of lines) {
    db.prepare('INSERT INTO cards (product_id, card_content) VALUES (?, ?)').run(productId, line.slice(0, 500));
  }
  db.prepare(
    'UPDATE products SET stock = (SELECT COUNT(*) FROM cards WHERE product_id = ? AND used = 0), updated_at = datetime("now") WHERE id = ?'
  ).run(productId, productId);
  res.redirect('/admin/products/' + productId + '/cards');
});

// 订单
router.get('/orders', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const total = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(page, totalPages);
  const list = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(PAGE_SIZE, (p - 1) * PAGE_SIZE);
  const pendingRefunds = db.prepare('SELECT * FROM refund_requests WHERE status = ?').all('pending');
  const byOrderId = {};
  pendingRefunds.forEach((r) => { byOrderId[r.order_id] = r; });
  list.forEach((o) => { o.refund_request = byOrderId[o.id] || null; });
  res.render('admin/orders', {
    title: '订单管理',
    user: req.session.user,
    orders: list,
    pagination: { page: p, pageSize: PAGE_SIZE, total, totalPages },
    query: req.query,
  });
});

// 用户管理
router.get('/users', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(page, totalPages);
  const list = db.prepare(`
    SELECT u.id, u.linux_do_id, u.username, u.avatar_url, u.email, u.created_at, u.is_admin,
    (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) as order_count
    FROM users u
    ORDER BY u.id DESC
    LIMIT ? OFFSET ?
  `).all(PAGE_SIZE, (p - 1) * PAGE_SIZE);
  res.render('admin/users', {
    title: '用户管理',
    user: req.session.user,
    users: list,
    pagination: { page: p, pageSize: PAGE_SIZE, total, totalPages },
    query: req.query,
  });
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

// 管理员直接退款（无申请时）
router.post('/orders/:id/refund', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = ?').get(req.params.id, 'paid');
  if (!order || !order.epay_trade_no) {
    return res.redirect('/admin/orders?error=refund');
  }
  const refundPayload = { trade_no: order.epay_trade_no, money: order.amount, order_no: order.order_no };
  try {
    const result = await epay.refund(order.epay_trade_no, order.amount);
    const msg = (result && result.msg) ? String(result.msg) : '';
    logPayment('refund_api', {
      orderId: order.id,
      orderNo: order.order_no,
      payload: { request: refundPayload, response: result },
      result: result && result.code === 1 ? 'success' : (msg.includes('已完成') || msg.includes('已退回') ? 'success' : 'fail'),
      message: msg || (result ? `code=${result.code}` : ''),
    });
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
    logPayment('refund_api', {
      orderId: order.id,
      orderNo: order.order_no,
      payload: { request: refundPayload },
      result: 'fail',
      message: e.message || '网络或接口异常',
    });
    return res.redirect('/admin/orders?error=refund&msg=' + encodeURIComponent(e.message || '网络或接口异常'));
  }
});

// 同意用户退款申请（执行退款并更新申请状态）
router.post('/orders/:id/refund-approve', async (req, res) => {
  const orderId = Number(req.params.id);
  const reqRow = db.prepare('SELECT * FROM refund_requests WHERE order_id = ? AND status = ?').get(orderId, 'pending');
  if (!reqRow) return res.redirect('/admin/orders?error=refund&msg=' + encodeURIComponent('未找到待处理的退款申请'));
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = ?').get(orderId, 'paid');
  if (!order || !order.epay_trade_no) {
    db.prepare('UPDATE refund_requests SET status = ?, processed_at = datetime("now"), note = ? WHERE id = ?').run('rejected', '订单状态不允许退款', reqRow.id);
    logPayment('refund_approve', {
      orderId: order?.id,
      orderNo: order?.order_no,
      payload: { refund_request_id: reqRow.id, action: 'approve' },
      result: 'fail',
      message: '订单状态不允许退款',
    });
    return res.redirect('/admin/orders?error=refund&msg=' + encodeURIComponent('订单状态不允许退款'));
  }
  const refundPayload = { trade_no: order.epay_trade_no, money: order.amount };
  try {
    const result = await epay.refund(order.epay_trade_no, order.amount);
    const msg = (result && result.msg) ? String(result.msg) : '';
    logPayment('refund_approve', {
      orderId: order.id,
      orderNo: order.order_no,
      payload: { request: refundPayload, response: result, refund_request_id: reqRow.id },
      result: result && result.code === 1 ? 'success' : (msg.includes('已完成') || msg.includes('已退回') ? 'success' : 'fail'),
      message: msg || (result ? `code=${result.code}` : ''),
    });
    if (result && result.code === 1) {
      markOrderRefundedAndRollback(order);
      db.prepare('UPDATE refund_requests SET status = ?, processed_at = datetime("now") WHERE id = ?').run('approved', reqRow.id);
      return res.redirect('/admin/orders?refund=ok');
    }
    if (msg.includes('已完成') || msg.includes('已退回')) {
      markOrderRefundedAndRollback(order);
      db.prepare('UPDATE refund_requests SET status = ?, processed_at = datetime("now") WHERE id = ?').run('approved', reqRow.id);
      return res.redirect('/admin/orders?refund=ok&synced=1');
    }
    return res.redirect('/admin/orders?error=refund&msg=' + encodeURIComponent(msg || 'refund_fail'));
  } catch (e) {
    console.error('Refund approve error:', e);
    logPayment('refund_approve', {
      orderId: order.id,
      orderNo: order.order_no,
      payload: { request: refundPayload, refund_request_id: reqRow.id },
      result: 'fail',
      message: e.message || '网络或接口异常',
    });
    return res.redirect('/admin/orders?error=refund&msg=' + encodeURIComponent(e.message || '网络或接口异常'));
  }
});

// 拒绝用户退款申请
router.post('/orders/:id/refund-reject', (req, res) => {
  const orderId = Number(req.params.id);
  const reqRow = db.prepare('SELECT * FROM refund_requests WHERE order_id = ? AND status = ?').get(orderId, 'pending');
  if (!reqRow) return res.redirect('/admin/orders?error=refund&msg=' + encodeURIComponent('未找到待处理的退款申请'));
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  db.prepare('UPDATE refund_requests SET status = ?, processed_at = datetime("now") WHERE id = ?').run('rejected', reqRow.id);
  logPayment('refund_reject', {
    orderId: order?.id,
    orderNo: order?.order_no,
    payload: { refund_request_id: reqRow.id, action: 'reject' },
    result: 'success',
    message: '管理员拒绝退款申请',
  });
  res.redirect('/admin/orders?refund_reject=ok');
});

export default router;
