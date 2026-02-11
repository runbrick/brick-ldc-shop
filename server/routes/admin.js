import { Router } from 'express';
import db from '../db.js';
import * as epay from '../services/epay.js';
import { markOrderRefundedAndRollback } from './api-pay.js';
import { logPayment } from '../services/payment-log.js';
import { requireLogin, requireAdmin } from '../middleware/auth.js';
import { parseId, sanitizeOrderNo } from '../middleware/security.js';
import { uploadSingle, uploadCover, uploadBackground, getUploadUrl, uploadSettings } from '../middleware/upload.js';
import pinyin from 'pinyin';

const router = Router();
router.use(requireLogin);
router.use(requireAdmin);

router.get('/settings', (req, res) => {
  const get = (k) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value || '';
  res.render('admin/settings', {
    title: '设置',
    user: req.session.user,
    siteName: get('site_name'),
    homeSubtitle: get('home_subtitle'),
    siteFooterText: get('site_footer_text'),
    siteBackground: get('site_background'),
    footerCol1: get('footer_col1'),
    // footerCol2 removed
    footerCol3: get('footer_col3'),
    footerCol4: get('footer_col4'),
    paymentQR: get('payment_qr'),
    checkinPoints: get('checkin_points') || '10',
    pointsRatio: get('points_ratio') || '100',
    inventoryWarning: get('inventory_warning') || '5',
    // footerLinks removed
  });
});

router.post('/settings', uploadSettings, (req, res) => {
  const siteName = (req.body.site_name || '').trim().slice(0, 64);
  const homeSubtitle = (req.body.home_subtitle || '').trim().slice(0, 128);
  const siteFooterText = (req.body.site_footer_text || '').trim();
  
  const currentBg = (db.prepare('SELECT value FROM settings WHERE key = ?').get('site_background') || {}).value || '';
  const siteBackground = (req.files && req.files['site_background_image']) ? getUploadUrl(req.files['site_background_image'][0].filename) : currentBg;

  const currentQR = (db.prepare('SELECT value FROM settings WHERE key = ?').get('payment_qr') || {}).value || '';
  const paymentQR = (req.files && req.files['payment_qr_image']) ? getUploadUrl(req.files['payment_qr_image'][0].filename) : currentQR;

  const footerCol1 = (req.body.footer_col1 || '').trim();
  // const footerCol2 = (req.body.footer_col2 || '').trim();
  const footerCol3 = (req.body.footer_col3 || '').trim();
  const footerCol4 = (req.body.footer_col4 || '').trim();
  // const footerLinks = (req.body.footer_links || '').trim();

  const checkinPoints = (req.body.checkin_points || '10').trim();
  const pointsRatio = (req.body.points_ratio || '100').trim();
  const inventoryWarning = (req.body.inventory_warning || '5').trim();

  db.setSetting('site_name', siteName);
  db.setSetting('home_subtitle', homeSubtitle);
  db.setSetting('site_footer_text', siteFooterText.slice(0, 4096));
  db.setSetting('site_background', siteBackground);
  db.setSetting('footer_col1', footerCol1);
  // db.setSetting('footer_col2', footerCol2);
  db.setSetting('footer_col3', footerCol3);
  db.setSetting('footer_col4', footerCol4);
  db.setSetting('payment_qr', paymentQR);
  // db.setSetting('footer_links', footerLinks);
  db.setSetting('checkin_points', checkinPoints);
  db.setSetting('points_ratio', pointsRatio);
  db.setSetting('inventory_warning', inventoryWarning);
  res.redirect('/admin/settings?ok=1');
});

router.post('/upload/image', uploadSingle, (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: '未选择文件' });
  res.json({ ok: true, url: getUploadUrl(req.file.filename) });
});

router.get('/', (req, res) => {
  const warningThreshold = parseInt(db.getSetting('inventory_warning')) || 5;
  const stats = {
    products: db.prepare('SELECT COUNT(*) as c FROM products').get().c,
    orders: db.prepare('SELECT COUNT(*) as c FROM orders').get().c,
    paidOrders: db.prepare('SELECT COUNT(*) as c FROM orders WHERE status = ?').get('paid').c,
    totalAmount: db.prepare('SELECT COALESCE(SUM(amount), 0) as s FROM orders WHERE status = ?').get('paid').s,
    lowStock: db.prepare('SELECT COUNT(*) as c FROM products WHERE stock >= 0 AND stock <= ?').get(warningThreshold).c,
  };
  res.render('admin/dashboard', { title: '后台首页', user: req.session.user, stats });
});

// 签到记录
router.get('/checkins', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const PAGE_SIZE = 20;
  
  const total = db.prepare('SELECT COUNT(*) as c FROM checkin_logs').get().c;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  
  const logs = db.prepare(`
    SELECT l.*, u.username, u.avatar_url 
    FROM checkin_logs l 
    LEFT JOIN users u ON l.user_id = u.id 
    ORDER BY l.created_at DESC 
    LIMIT ? OFFSET ?
  `).all(PAGE_SIZE, (page - 1) * PAGE_SIZE);

  res.render('admin/checkins', {
    title: '签到记录',
    user: req.session.user,
    logs,
    pagination: { page, pageSize: PAGE_SIZE, total, totalPages }
  });
});

// 数据导出
router.get('/export', (req, res) => {
  const type = req.query.type || 'json';
  const table = req.query.table || 'all';

  if (type === 'sql') {
    // 导出整个数据库文件
    try {
      const data = db.export();
      res.setHeader('Content-Type', 'application/x-sqlite3');
      res.setHeader('Content-Disposition', 'attachment; filename=shop_backup_' + new Date().toISOString().split('T')[0] + '.db');
      return res.send(Buffer.from(data));
    } catch (e) {
      console.error('SQL export error:', e);
      return res.status(500).send('Export failed');
    }
  }

  // 导出 JSON
  const tables = table === 'all' 
    ? ['products', 'categories', 'orders', 'users', 'cards', 'settings', 'links', 'announcements'] 
    : [table];
  
  const result = {};
  try {
    for (const t of tables) {
      result[t] = db.prepare(`SELECT * FROM ${t}`).all();
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=shop_export_${table}_${new Date().toISOString().split('T')[0]}.json`);
    res.json(result);
  } catch (e) {
    console.error('JSON export error:', e);
    res.status(500).json({ ok: false, message: '导出失败: ' + e.message });
  }
});

// 用户管理
router.get('/users', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const keyword = (req.query.keyword || '').trim();
  let list;
  let total;

  if (keyword) {
    const search = `%${keyword}%`;
    total = db.prepare('SELECT COUNT(*) as c FROM users WHERE username LIKE ? OR id = ? OR email LIKE ?').get(search, parseInt(keyword) || -1, search).c;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const p = Math.min(page, totalPages);
    list = db.prepare(`
      SELECT u.*, 
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) as order_count,
      (SELECT COALESCE(SUM(amount), 0) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') as total_spent
      FROM users u
      WHERE u.username LIKE ? OR u.id = ? OR u.email LIKE ?
      ORDER BY u.id DESC
      LIMIT ? OFFSET ?
    `).all(search, parseInt(keyword) || -1, search, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    
    res.render('admin/users', {
      title: '用户管理',
      user: req.session.user,
      users: list,
      pagination: { page: p, pageSize: PAGE_SIZE, total, totalPages },
      query: req.query,
    });
  } else {
    total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const p = Math.min(page, totalPages);
    list = db.prepare(`
      SELECT u.*, 
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) as order_count,
      (SELECT COALESCE(SUM(amount), 0) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') as total_spent
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
  }
});

router.post('/users/:id/update-points', (req, res) => {
  const id = parseId(req.params.id);
  const points = parseInt(req.body.points, 10);
  if (id != null && !isNaN(points)) {
    db.prepare('UPDATE users SET points = ?, updated_at = datetime("now") WHERE id = ?').run(points, id);
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/toggle-ban', (req, res) => {
  const id = parseId(req.params.id);
  if (id != null) {
    const user = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(id);
    if (user) {
      const next = user.is_banned === 1 ? 0 : 1;
      db.prepare('UPDATE users SET is_banned = ?, updated_at = datetime("now") WHERE id = ?').run(next, id);
    }
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/toggle-admin', (req, res) => {
  const id = parseId(req.params.id);
  if (id != null) {
    const currentUserId = req.session.user?.id;
    if (id === currentUserId) {
      return res.redirect('/admin/users?error=self');
    }
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(id);
    if (user) {
      const next = user.is_admin === 1 ? 0 : 1;
      db.prepare('UPDATE users SET is_admin = ?, updated_at = datetime("now") WHERE id = ?').run(next, id);
    }
  }
  res.redirect('/admin/users');
});

// 支付日志（支付信息、回调、退款等）
router.get('/payment-logs', (req, res) => {
  const orderNo = sanitizeOrderNo(req.query.order_no);
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
  const id = parseId(req.params.id);
  if (id == null) return res.redirect('/admin/categories');
  const name = (req.body.name || '').trim().slice(0, 32);
  const sort = Number(req.body.sort) || 0;
  const parentId = req.body.parent_id === '' || req.body.parent_id === undefined ? null : Number(req.body.parent_id);
  if (!name) return res.redirect('/admin/categories');
  if (parentId === id) return res.redirect('/admin/categories');
  try {
    db.prepare('UPDATE categories SET name = ?, sort = ?, parent_id = ? WHERE id = ?').run(name, sort, parentId || null, id);
  } catch (e) {
    if (!e.message || !e.message.includes('UNIQUE')) throw e;
  }
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.redirect('/admin/categories');
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
  const id = parseId(req.params.id);
  if (id == null) return res.redirect('/admin/products');
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) return res.redirect('/admin/products');
  const categoryTree = getCategoryTree();
  res.render('admin/product-form', { title: '编辑商品', user: req.session.user, product, categoryTree });
});

router.post('/products', uploadCover, (req, res) => {
  const { name, description, price, stock, sort, status, card_mode, category_id, slug, original_price, purchase_limit, is_hot } = req.body;
  const cover = req.file ? getUploadUrl(req.file.filename) : '';
  const cardMode = card_mode === '1' ? 1 : 0;
  const stockNum = cardMode === 1 ? -1 : Number(stock);
  const catId = category_id ? Number(category_id) : null;
  const originalPrice = original_price ? Number(original_price) : null;
  const purchaseLimit = Number(purchase_limit) || 0;
  const isHot = is_hot === '1' ? 1 : 0;
  
  let finalSlug = (slug || '').trim();
  if (!finalSlug && name) {
    try {
      finalSlug = pinyin.default(name, { style: pinyin.STYLE_NORMAL }).flat().join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    } catch (e) {
      console.error('Slug generation error:', e);
    }
  }
  if (!finalSlug) finalSlug = null;

  try {
    db.prepare(
      `INSERT INTO products (name, description, price, original_price, stock, purchase_limit, is_hot, sort, status, cover_image, card_mode, category_id, slug)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name || '未命名',
      description || '',
      Number(price) || 0,
      originalPrice,
      isNaN(stockNum) ? 0 : stockNum,
      purchaseLimit,
      isHot,
      Number(sort) || 0,
      status === '1' ? 1 : 0,
      cover,
      cardMode,
      catId,
      finalSlug
    );
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed: products.slug')) {
        return res.redirect('/admin/products/new?error=slug_duplicate');
    }
    throw e;
  }
  res.redirect('/admin/products');
});

router.post('/products/:id', uploadCover, (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.redirect('/admin/products');
  
  const { name, description, price, stock, sort, status, card_mode, category_id, slug, original_price, purchase_limit, is_hot } = req.body;
  const coverImage = req.file ? getUploadUrl(req.file.filename) : db.prepare('SELECT cover_image FROM products WHERE id = ?').get(id)?.cover_image;
  const cardMode = card_mode === '1' ? 1 : 0;
  const stockNum = cardMode === 1 ? -1 : Number(stock);
  const catId = category_id ? Number(category_id) : null;
  const originalPrice = original_price ? Number(original_price) : null;
  const purchaseLimit = Number(purchase_limit) || 0;
  const isHot = is_hot === '1' ? 1 : 0;

  let finalSlug = (slug || '').trim();
  if (!finalSlug && name) {
    try {
      finalSlug = pinyin.default(name, { style: pinyin.STYLE_NORMAL }).flat().join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    } catch (e) {
      console.error('Slug generation error:', e);
    }
  }
  if (!finalSlug) finalSlug = null;

  try {
    db.prepare(
        `UPDATE products SET name=?, description=?, price=?, original_price=?, stock=?, purchase_limit=?, is_hot=?, sort=?, status=?, cover_image=?, card_mode=?, category_id=?, slug=?, updated_at=datetime('now')
         WHERE id=?`
      ).run(
        name || '未命名',
        description || '',
        Number(price) || 0,
        originalPrice,
        isNaN(stockNum) ? 0 : stockNum,
        purchaseLimit,
        isHot,
        Number(sort) || 0,
        status === '1' ? 1 : 0,
        coverImage,
        cardMode,
        catId,
        finalSlug,
        id
      );
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed: products.slug')) {
        return res.redirect('/admin/products/' + id + '/edit?error=slug_duplicate');
    }
    throw e;
  }
  res.redirect('/admin/products');
});

router.post('/products/:id/toggle-status', (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.redirect('/admin/products');
  const product = db.prepare('SELECT id, status FROM products WHERE id = ?').get(id);
  if (!product) return res.redirect('/admin/products');
  const nextStatus = product.status === 1 ? 0 : 1;
  db.prepare('UPDATE products SET status = ?, updated_at = datetime("now") WHERE id = ?').run(nextStatus, id);
  res.redirect('/admin/products');
});

router.post('/products/:id/delete', (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.redirect('/admin/products');
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  res.redirect('/admin/products');
});

// 卡密
router.get('/products/:id/cards', (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.redirect('/admin/products');
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) return res.redirect('/admin/products');
  const cards = db.prepare(
    'SELECT * FROM cards WHERE product_id = ? ORDER BY used, id DESC LIMIT 500'
  ).all(id);
  res.render('admin/cards', { title: '卡密管理', user: req.session.user, product, cards });
});

router.post('/products/:id/cards', (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.redirect('/admin/products');
  const content = (req.body.content || '').trim();
  if (!content) return res.redirect('/admin/products/' + id + '/cards');
  const lines = content.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const productId = id;
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

// 管理员直接退款（无申请时）
router.post('/orders/:id/refund', async (req, res) => {
  const orderId = parseId(req.params.id);
  if (orderId == null) return res.redirect('/admin/orders?error=refund');
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = ?').get(orderId, 'paid');
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

// 评价管理
router.get('/reviews', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const total = db.prepare('SELECT COUNT(*) as c FROM reviews').get().c;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(page, totalPages);
  
  const reviews = db.prepare(`
    SELECT r.*, u.username, p.name as product_name, o.order_no
    FROM reviews r
    JOIN users u ON r.user_id = u.id
    JOIN products p ON r.product_id = p.id
    JOIN orders o ON r.order_id = o.id
    ORDER BY r.id DESC
    LIMIT ? OFFSET ?
  `).all(PAGE_SIZE, (p - 1) * PAGE_SIZE);

  res.render('admin/reviews', {
    title: '评价管理',
    user: req.session.user,
    reviews,
    pagination: { page: p, pageSize: PAGE_SIZE, total, totalPages },
    query: req.query,
  });
});

router.post('/reviews/:id/toggle-hide', (req, res) => {
  const id = parseId(req.params.id);
  if (id != null) {
    const review = db.prepare('SELECT is_hidden FROM reviews WHERE id = ?').get(id);
    if (review) {
      const next = review.is_hidden === 1 ? 0 : 1;
      db.prepare('UPDATE reviews SET is_hidden = ? WHERE id = ?').run(next, id);
    }
  }
  res.redirect('/admin/reviews');
});

router.post('/reviews/:id/delete', (req, res) => {
  const id = parseId(req.params.id);
  if (id != null) {
    db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
  }
  res.redirect('/admin/reviews');
});

// 销售统计
router.get('/stats', (req, res) => {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const stats = {
    today: db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as amount FROM orders WHERE status = 'paid' AND created_at >= ?").get(today + ' 00:00:00'),
    last7: db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as amount FROM orders WHERE status = 'paid' AND created_at >= ?").get(last7Days + ' 00:00:00'),
    last30: db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as amount FROM orders WHERE status = 'paid' AND created_at >= ?").get(last30Days + ' 00:00:00'),
    total: db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as amount FROM orders WHERE status = 'paid'").get(),
  };

  // 热门商品排行
  const topProducts = db.prepare(`
    SELECT p.name, SUM(o.quantity) as total_sold, SUM(o.amount) as total_amount
    FROM orders o
    JOIN products p ON o.product_id = p.id
    WHERE o.status = 'paid'
    GROUP BY o.product_id
    ORDER BY total_sold DESC
    LIMIT 10
  `).all();

  // 最近 15 天每日销售趋势
  const dailyTrend = [];
  for (let i = 14; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const row = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as amount FROM orders WHERE status = 'paid' AND created_at LIKE ?").get(d + '%');
    dailyTrend.push({ date: d, count: row.count, amount: row.amount });
  }

  res.render('admin/stats', {
    title: '销售统计',
    user: req.session.user,
    stats,
    topProducts,
    dailyTrend,
  });
});

// 导出订单数据 (CSV)
router.get('/orders/export', (req, res) => {
  const orders = db.prepare(`
    SELECT o.order_no, o.username, o.product_name, o.amount, o.quantity, o.status, o.created_at, o.epay_trade_no
    FROM orders o
    ORDER BY o.id DESC
  `).all();

  let csv = '\ufeff订单号,用户名,商品名,金额,数量,状态,创建时间,交易流水号\n';
  orders.forEach(o => {
    csv += `${o.order_no},${o.username || '游客'},${o.product_name},${o.amount},${o.quantity},${o.status},${o.created_at},${o.epay_trade_no || ''}\n`;
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=orders_' + Date.now() + '.csv');
  res.send(csv);
});

// 同意用户退款申请（执行退款并更新申请状态）
router.post('/orders/:id/refund-approve', async (req, res) => {
  const orderId = parseId(req.params.id);
  if (orderId == null) return res.redirect('/admin/orders?error=refund');
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
  const orderId = parseId(req.params.id);
  if (orderId == null) return res.redirect('/admin/orders?error=refund');
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

// 友情链接管理
router.get('/links', (req, res) => {
  const links = db.prepare('SELECT * FROM links ORDER BY sort DESC, id ASC').all();
  res.render('admin/links', { title: '友情链接管理', user: req.session.user, links });
});

router.post('/links', (req, res) => {
  const name = (req.body.name || '').trim();
  const url = (req.body.url || '').trim();
  if (!name || !url) return res.redirect('/admin/links?error=missing_fields');
  
  const logo_url = (req.body.logo_url || '').trim();
  const description = (req.body.description || '').trim();
  const sort = Number(req.body.sort) || 0;
  const is_active = Number(req.body.is_active) || 0;

  db.prepare(`
    INSERT INTO links (name, url, logo_url, description, sort, is_active)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, url, logo_url, description, sort, is_active);
  
  res.redirect('/admin/links');
});

router.post('/links/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.redirect('/admin/links');
  
  const name = (req.body.name || '').trim();
  const url = (req.body.url || '').trim();
  if (!name || !url) return res.redirect('/admin/links?error=missing_fields');

  const logo_url = (req.body.logo_url || '').trim();
  const description = (req.body.description || '').trim();
  const sort = Number(req.body.sort) || 0;
  const is_active = Number(req.body.is_active) || 0;

  db.prepare(`
    UPDATE links SET name=?, url=?, logo_url=?, description=?, sort=?, is_active=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name, url, logo_url, description, sort, is_active, id);

  res.redirect('/admin/links');
});

router.post('/links/:id/delete', (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.redirect('/admin/links');
  db.prepare('DELETE FROM links WHERE id = ?').run(id);
  res.redirect('/admin/links');
});

// 公告管理
router.get('/announcements', (req, res) => {
  const announcements = db.prepare('SELECT * FROM announcements ORDER BY sort DESC, id DESC').all();
  res.render('admin/announcements', { title: '公告管理', user: req.session.user, announcements });
});

router.post('/announcements', (req, res) => {
  const content = (req.body.content || '').trim();
  if (!content) return res.redirect('/admin/announcements?error=missing_content');
  
  const title = (req.body.title || '').trim();
  const sort = Number(req.body.sort) || 0;
  const is_active = Number(req.body.is_active) || 0;

  db.prepare(`
    INSERT INTO announcements (title, content, sort, is_active)
    VALUES (?, ?, ?, ?)
  `).run(title, content, sort, is_active);
  
  res.redirect('/admin/announcements');
});

router.post('/announcements/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.redirect('/admin/announcements');
  
  const content = (req.body.content || '').trim();
  if (!content) return res.redirect('/admin/announcements?error=missing_content');

  const title = (req.body.title || '').trim();
  const sort = Number(req.body.sort) || 0;
  const is_active = Number(req.body.is_active) || 0;

  db.prepare(`
    UPDATE announcements SET title=?, content=?, sort=?, is_active=?, updated_at=datetime('now')
    WHERE id=?
  `).run(title, content, sort, is_active, id);

  res.redirect('/admin/announcements');
});

router.post('/announcements/:id/delete', (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.redirect('/admin/announcements');
  db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
  res.redirect('/admin/announcements');
});

export default router;
