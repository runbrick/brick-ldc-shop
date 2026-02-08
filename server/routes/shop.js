import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { config } from '../config.js';
import * as epay from '../services/epay.js';
import { optionalUser, requireLogin } from '../middleware/auth.js';
import { isOAuthConfigured } from '../services/oauth-linux-do.js';
import { syncOrderByGateway } from './api-pay.js';

const router = Router();
router.use(optionalUser);

function getShopCategoryTree() {
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

router.get('/', (req, res) => {
  if (req.session.pendingPaymentOrderNo) {
    const orderNo = req.session.pendingPaymentOrderNo;
    delete req.session.pendingPaymentOrderNo;
    return res.redirect(`/shop/order/result?order_no=${orderNo}`);
  }
  const categoryIdParam = req.query.category ? Number(req.query.category) : null;
  const sortParam = (req.query.sort || '').trim();
  const categoryTree = getShopCategoryTree();

  const categoryIds = [];
  if (categoryIdParam) {
    const all = db.prepare('SELECT id, parent_id FROM categories').all();
    const childrenOf = {};
    all.forEach((c) => {
      const pid = c.parent_id || 0;
      if (!childrenOf[pid]) childrenOf[pid] = [];
      childrenOf[pid].push(c.id);
    });
    categoryIds.push(categoryIdParam);
    (childrenOf[categoryIdParam] || []).forEach((id) => categoryIds.push(id));
  }

  const catFilter = categoryIds.length
    ? ' AND p.category_id IN (' + categoryIds.join(',') + ')'
    : '';
  const baseWhere = 'FROM products p WHERE p.status = 1' + catFilter;

  let products;
  if (sortParam === 'price_asc') {
    products = db.prepare('SELECT p.* ' + baseWhere + ' ORDER BY p.price ASC, p.id DESC').all();
  } else if (sortParam === 'price_desc') {
    products = db.prepare('SELECT p.* ' + baseWhere + ' ORDER BY p.price DESC, p.id DESC').all();
  } else if (sortParam === 'sales_desc') {
    products = db.prepare(
      'SELECT p.* ' + baseWhere + ' ORDER BY (SELECT COALESCE(SUM(o.quantity),0) FROM orders o WHERE o.product_id = p.id AND o.status = \'paid\') DESC, p.id DESC'
    ).all();
  } else {
    products = db.prepare('SELECT p.* ' + baseWhere + ' ORDER BY p.sort DESC, p.id DESC').all();
  }

  res.render('shop/home', {
    title: '商城',
    user: req.user,
    products,
    categoryTree,
    currentCategoryId: categoryIdParam,
    currentSort: sortParam,
    oauthConfigured: isOAuthConfigured(),
    query: req.query,
  });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.query.next || '/shop');
  const message = req.session.oauthErrorMessage;
  if (req.session.oauthErrorMessage) delete req.session.oauthErrorMessage;
  res.render('shop/login', {
    title: '登录',
    error: req.query.error,
    message: message || req.query.message,
    oauthConfigured: isOAuthConfigured(),
  });
});

router.get('/product/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(req.params.id);
  if (!product) return res.status(404).render('shop/404', { title: '未找到' });
  res.render('shop/product', {
    title: product.name,
    product,
    user: req.user,
    oauthConfigured: isOAuthConfigured(),
  });
});

// 创建订单并跳转支付
router.post('/order/create', async (req, res) => {
  const productId = Number(req.body.product_id);
  const quantity = Math.max(1, Math.min(100, Number(req.body.quantity) || 1));
  const contact = (req.body.contact || '').trim().slice(0, 200);

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(productId);
  if (!product) {
    return res.status(400).json({ ok: false, message: '商品不存在或已下架' });
  }
  const unlimited = product.stock === -1;
  const available = db.prepare(
    product.card_mode === 1
      ? 'SELECT COUNT(*) as c FROM cards WHERE product_id = ?'
      : 'SELECT COUNT(*) as c FROM cards WHERE product_id = ? AND used = 0'
  ).get(productId).c;
  if (available < quantity) {
    return res.status(400).json({ ok: false, message: '库存不足' });
  }
  if (!unlimited && product.stock < quantity) {
    return res.status(400).json({ ok: false, message: '库存不足' });
  }

  const orderNo = 'O' + Date.now() + crypto.randomBytes(4).toString('hex').toUpperCase();
  const amount = product.price * quantity;
  const userId = req.user?.id ?? null;
  const username = req.user?.username ?? null;

  db.prepare(
    `INSERT INTO orders (order_no, user_id, username, product_id, product_name, amount, quantity, contact)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(orderNo, userId, username, product.id, product.name, amount, quantity, contact);

  const baseUrl = config.baseUrl;
  const notifyUrl = `${baseUrl}/api/pay/notify`;
  const returnUrl = `${baseUrl}/shop/order/result?order_no=${orderNo}`;

  try {
    req.session.pendingPaymentOrderNo = orderNo;
    const result = await epay.createPay({
      out_trade_no: orderNo,
      name: product.name + (quantity > 1 ? ` x${quantity}` : ''),
      money: amount,
      return_url_override: returnUrl,
      notify_url_override: notifyUrl,
    });
    return res.json({ ok: true, redirectUrl: result.redirectUrl });
  } catch (e) {
    console.error('Order create / pay error:', e);
    return res.status(500).json({ ok: false, message: e.message || '发起支付失败' });
  }
});

router.get('/order/result', async (req, res) => {
  let orderNo = req.query.order_no || req.query.out_trade_no;
  if (!orderNo && req.session.pendingPaymentOrderNo) {
    orderNo = req.session.pendingPaymentOrderNo;
    delete req.session.pendingPaymentOrderNo;
    return res.redirect(`/shop/order/result?order_no=${orderNo}`);
  }
  if (!orderNo) return res.redirect('/shop');
  let order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
  if (order && order.status === 'pending') {
    await syncOrderByGateway(orderNo);
    order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
    if (order && order.status === 'pending') {
      await new Promise((r) => setTimeout(r, 2000));
      await syncOrderByGateway(orderNo);
      order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
    }
  }
  res.render('shop/order-result', {
    title: '订单结果',
    order: order || null,
    orderNo,
    user: req.user,
  });
});

// 我的订单（需登录）
router.get('/orders', requireLogin, (req, res) => {
  const orders = db.prepare(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 100'
  ).all(req.user.id);
  const orderIds = orders.map((o) => o.id);
  const pendingRefundOrderIds = orderIds.length
    ? db.prepare(
        'SELECT order_id FROM refund_requests WHERE status = ? AND order_id IN (' +
          orderIds.map(() => '?').join(',') +
          ')'
      )
      .all('pending', ...orderIds)
      .map((r) => r.order_id)
    : [];
  orders.forEach((o) => {
    o.refund_pending = pendingRefundOrderIds.includes(o.id);
  });
  res.render('shop/orders', {
    title: '我的订单',
    user: req.user,
    orders,
    query: req.query,
  });
});

// 前台申请退款（仅提交申请，需后台同意后才执行退款）
router.post('/order/refund', requireLogin, (req, res) => {
  const orderNo = (req.body.order_no || '').trim();
  if (!orderNo) return res.redirect('/shop/orders?error=refund&msg=' + encodeURIComponent('缺少订单号'));
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ? AND user_id = ? AND status = ?').get(orderNo, req.user.id, 'paid');
  if (!order || !order.epay_trade_no) {
    return res.redirect('/shop/orders?error=refund&msg=' + encodeURIComponent('订单不存在或不可退款'));
  }
  const existing = db.prepare('SELECT id FROM refund_requests WHERE order_id = ? AND status = ?').get(order.id, 'pending');
  if (existing) {
    return res.redirect('/shop/orders?error=refund&msg=' + encodeURIComponent('该订单已提交过退款申请，请等待处理'));
  }
  db.prepare('INSERT INTO refund_requests (order_id, status) VALUES (?, ?)').run(order.id, 'pending');
  res.redirect('/shop/orders?refund_request=ok');
});

// 凭订单号查询卡密（支付成功后任何人可查；若订单仍待支付会先向网关查单并同步状态）
router.get('/order/:orderNo/cards', async (req, res) => {
  let order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(req.params.orderNo);
  if (!order) return res.status(404).json({ message: '订单不存在' });
  if (order.status === 'pending') {
    await syncOrderByGateway(req.params.orderNo);
    order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(req.params.orderNo);
  }
  if (order.status !== 'paid') {
    return res.json({ ok: true, status: order.status, cards: [] });
  }
  let cards = [];
  if (order.delivered_cards) {
    try {
      cards = JSON.parse(order.delivered_cards);
    } catch (_) {}
  }
  if (cards.length === 0) {
    const rows = db.prepare('SELECT card_content FROM cards WHERE order_id = ?').all(order.id);
    cards = rows.map((c) => c.card_content);
  }
  res.json({ ok: true, status: 'paid', cards });
});

export default router;
