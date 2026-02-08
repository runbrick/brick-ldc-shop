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

router.get('/', (req, res) => {
  if (req.session.pendingPaymentOrderNo) {
    const orderNo = req.session.pendingPaymentOrderNo;
    delete req.session.pendingPaymentOrderNo;
    return res.redirect(`/shop/order/result?order_no=${orderNo}`);
  }
  const products = db.prepare(
    'SELECT * FROM products WHERE status = 1 ORDER BY sort DESC, id DESC'
  ).all();
  res.render('shop/home', {
    title: '商城',
    user: req.user,
    products,
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
  res.render('shop/orders', {
    title: '我的订单',
    user: req.user,
    orders,
  });
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
