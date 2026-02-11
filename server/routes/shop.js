import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { config } from '../config.js';
import * as epay from '../services/epay.js';
import { optionalUser, requireLogin } from '../middleware/auth.js';
import { parseId, sanitizeOrderNo, sanitizeSort } from '../middleware/security.js';
import { isOAuthConfigured } from '../services/oauth-linux-do.js';
import { syncOrderByGateway } from './api-pay.js';
import { logPayment } from '../services/payment-log.js';

const router = Router();
router.use(optionalUser);

const PAGE_SIZE = 20;

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
  const categoryIdParam = parseId(req.query.category);
  const sortParam = sanitizeSort(req.query.sort);
  const categoryTree = getShopCategoryTree();

  const categoryIds = [];
  if (categoryIdParam != null) {
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

  const inPlaceholders = categoryIds.length ? ' AND p.category_id IN (' + categoryIds.map(() => '?').join(',') + ')' : '';
  const baseWhere = 'FROM products p WHERE p.status = 1' + inPlaceholders;
  const countParams = categoryIds.length ? categoryIds : [];

  const countRow = db.prepare('SELECT COUNT(*) as c FROM products p WHERE p.status = 1' + inPlaceholders).get(...countParams);
  const total = countRow.c;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), totalPages);
  const offset = (page - 1) * PAGE_SIZE;
  const listParams = categoryIds.length ? [...categoryIds, PAGE_SIZE, offset] : [PAGE_SIZE, offset];

  let products;
  if (sortParam === 'price_asc') {
    products = db.prepare('SELECT p.* ' + baseWhere + ' ORDER BY p.price ASC, p.id DESC LIMIT ? OFFSET ?').all(...listParams);
  } else if (sortParam === 'price_desc') {
    products = db.prepare('SELECT p.* ' + baseWhere + ' ORDER BY p.price DESC, p.id DESC LIMIT ? OFFSET ?').all(...listParams);
  } else if (sortParam === 'sales_desc') {
    products = db.prepare(
      'SELECT p.* ' + baseWhere + ' ORDER BY (SELECT COALESCE(SUM(o.quantity),0) FROM orders o WHERE o.product_id = p.id AND o.status = \'paid\') DESC, p.id DESC LIMIT ? OFFSET ?'
    ).all(...listParams);
  } else {
    products = db.prepare('SELECT p.* ' + baseWhere + ' ORDER BY p.sort DESC, p.id DESC LIMIT ? OFFSET ?').all(...listParams);
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
    pagination: { page, pageSize: PAGE_SIZE, total, totalPages },
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

// 每日签到
router.post('/checkin', requireLogin, (req, res) => {
  const user = db.prepare('SELECT points, last_checkin_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ ok: false, message: '用户不存在' });

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const lastCheckin = user.last_checkin_at ? user.last_checkin_at.split(' ')[0] : null;

  if (lastCheckin === today) {
    return res.status(400).json({ ok: false, message: '今天已经签到过了，明天再来吧！' });
  }

  const checkinPoints = parseInt(db.getSetting('checkin_points')) || 10;
  
  try {
    db.prepare('UPDATE users SET points = points + ?, last_checkin_at = datetime("now"), updated_at = datetime("now") WHERE id = ?').run(checkinPoints, req.user.id);
    db.prepare('INSERT INTO checkin_logs (user_id, points) VALUES (?, ?)').run(req.user.id, checkinPoints);
    res.json({ ok: true, message: `签到成功！获得 ${checkinPoints} 积分。`, points: user.points + checkinPoints });
  } catch (e) {
    console.error('Checkin error:', e);
    res.status(500).json({ ok: false, message: '签到失败，请稍后再试。' });
  }
});

router.get('/product/:idOrSlug', (req, res) => {
  const param = req.params.idOrSlug;
  const id = parseId(param);
  
  let product;
  if (id != null) {
      // Try finding by ID first if it looks like an ID
      product = db.prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(id);
  }
  
  // If not found by ID (or param wasn't an ID), try finding by slug
  if (!product) {
      product = db.prepare('SELECT * FROM products WHERE slug = ? AND status = 1').get(param);
  }

  if (!product) return res.status(404).render('shop/404', { title: '未找到' });

  // 获取评价
  const reviews = db.prepare(`
    SELECT r.*, u.username, u.avatar_url 
    FROM reviews r 
    JOIN users u ON r.user_id = u.id 
    WHERE r.product_id = ? AND r.is_hidden = 0 
    ORDER BY r.created_at DESC
  `).all(product.id);

  // 计算平均分
  const ratingStats = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as count FROM reviews WHERE product_id = ? AND is_hidden = 0').get(product.id);

  res.render('shop/product', {
    title: product.name,
    product,
    reviews,
    ratingAvg: ratingStats.avg || 0,
    ratingCount: ratingStats.count || 0,
    user: req.user,
    oauthConfigured: isOAuthConfigured(),
  });
});

// 创建订单并跳转支付
router.post('/order/create', requireLogin, async (req, res) => {
  const productId = parseId(req.body.product_id);
  if (productId == null) return res.status(400).json({ ok: false, message: '无效商品' });
  const quantity = Math.max(1, Math.min(100, Number(req.body.quantity) || 1));
  const contact = '';

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
  if (available === 0) {
    return res.status(400).json({ ok: false, message: '该商品还没添加卡密' });
  }
  if (available < quantity) {
    return res.status(400).json({ ok: false, message: '库存不足' });
  }
  if (!unlimited && product.stock < quantity) {
    return res.status(400).json({ ok: false, message: '库存不足' });
  }

  // 限购校验
  if (product.purchase_limit > 0) {
    const bought = db.prepare(
      "SELECT SUM(quantity) as total FROM orders WHERE user_id = ? AND product_id = ? AND status IN ('paid', 'pending')"
    ).get(req.user.id, product.id).total || 0;
    if (bought + quantity > product.purchase_limit) {
      return res.status(400).json({ ok: false, message: `该商品每人限购 ${product.purchase_limit} 件，您已购买或有未支付订单共 ${bought} 件` });
    }
  }

  // 清理过期锁定
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM inventory_locks WHERE expires_at < ?').run(now);

  // 检查可用库存（实际库存 - 锁定库存）
  if (!unlimited) {
    const locked = db.prepare('SELECT SUM(quantity) as total FROM inventory_locks WHERE product_id = ?').get(product.id).total || 0;
    if (product.stock - locked < quantity) {
      return res.status(400).json({ ok: false, message: '商品正被其他人抢购中，请稍后再试' });
    }
  }

  const orderNo = 'O' + Date.now() + crypto.randomBytes(4).toString('hex').toUpperCase();
  const amount = product.price * quantity;
  let pointsUsed = 0;
  let pointsAmount = 0;
  let finalAmount = amount;

  if (req.body.use_points === 'on' && req.user.points > 0) {
    const pointsRatio = parseInt(db.getSetting('points_ratio')) || 100;
    // 计算最多可用积分（不超过订单总额，也不超过用户持有量）
    const maxPointsNeeded = Math.floor(amount * pointsRatio);
    pointsUsed = Math.min(req.user.points, maxPointsNeeded);
    pointsAmount = pointsUsed / pointsRatio;
    finalAmount = Math.max(0, amount - pointsAmount);
  }

  const userId = req.user?.id ?? null;
  const username = req.user?.username ?? null;

  db.prepare(
    `INSERT INTO orders (order_no, user_id, username, product_id, product_name, amount, quantity, contact, points_used, points_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(orderNo, userId, username, product.id, product.name, finalAmount, quantity, contact, pointsUsed, pointsAmount);
  const order = db.prepare('SELECT id FROM orders WHERE order_no = ?').get(orderNo);

  // 扣除积分
  if (pointsUsed > 0) {
    db.prepare('UPDATE users SET points = points - ?, updated_at = datetime("now") WHERE id = ?').run(pointsUsed, userId);
  }

  // 锁定库存 (5分钟)
  if (!unlimited) {
    db.prepare('INSERT INTO inventory_locks (order_id, product_id, quantity, expires_at) VALUES (?, ?, ?, ?)').run(
      order.id, product.id, quantity, now + 300
    );
  }

  // 如果实付金额为 0，直接完成订单
  if (finalAmount <= 0) {
    const completeOrder = (await import('./api-pay.js')).completeOrder;
    const fullOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    completeOrder(fullOrder, 'POINTS_PAY');
    return res.json({ ok: true, redirectUrl: `/shop/order/result?order_no=${orderNo}` });
  }

  const baseUrl = config.baseUrl;
  const notifyUrl = `${baseUrl}/api/pay/notify`;
  const returnUrl = `${baseUrl}/shop/order/result?order_no=${orderNo}`;

  const payRequest = {
    out_trade_no: orderNo,
    name: product.name + (quantity > 1 ? ` x${quantity}` : ''),
    money: finalAmount,
    return_url: returnUrl,
    notify_url: notifyUrl,
  };

  try {
    req.session.pendingPaymentOrderNo = orderNo;
    const result = await epay.createPay({
      out_trade_no: orderNo,
      name: payRequest.name,
      money: finalAmount,
      return_url_override: returnUrl,
      notify_url_override: notifyUrl,
    });
    logPayment('pay_create', {
      orderId: order?.id,
      orderNo,
      payload: payRequest,
      result: 'success',
      message: result.redirectUrl ? '已获取跳转 URL' : null,
    });
    return res.json({ ok: true, redirectUrl: result.redirectUrl });
  } catch (e) {
    console.error('Order create / pay error:', e);
    logPayment('pay_create', {
      orderId: order?.id,
      orderNo,
      payload: payRequest,
      result: 'fail',
      message: e.message || '发起支付失败',
    });
    return res.status(500).json({ ok: false, message: e.message || '发起支付失败' });
  }
});

router.get('/order/result', async (req, res) => {
  let orderNo = sanitizeOrderNo(req.query.order_no || req.query.out_trade_no || '');
  if (!orderNo && req.session.pendingPaymentOrderNo) {
    orderNo = sanitizeOrderNo(req.session.pendingPaymentOrderNo);
    delete req.session.pendingPaymentOrderNo;
    if (orderNo) return res.redirect(`/shop/order/result?order_no=${encodeURIComponent(orderNo)}`);
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
    reviewed: order ? !!db.prepare('SELECT id FROM reviews WHERE order_id = ?').get(order.id) : false,
  });
});



// 我的订单（需登录）
router.get('/orders', requireLogin, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM orders WHERE user_id = ?').get(req.user.id).c;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), totalPages);
  const orders = db.prepare(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(req.user.id, PAGE_SIZE, (page - 1) * PAGE_SIZE);
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
    pagination: { page, pageSize: PAGE_SIZE, total, totalPages },
  });
});

// 取消待支付订单
router.post('/order/cancel', requireLogin, (req, res) => {
  const orderNo = sanitizeOrderNo(req.body.order_no);
  if (!orderNo) return res.status(400).json({ ok: false, message: '无效订单号' });
  
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ? AND user_id = ? AND status = ?').get(orderNo, req.user.id, 'pending');
  if (!order) {
    return res.status(400).json({ ok: false, message: '订单不存在或不可取消' });
  }

  try {
    const cancelTx = db.transaction(() => {
      // 归还积分
      if (order.points_used > 0) {
        db.prepare('UPDATE users SET points = points + ?, updated_at = datetime("now") WHERE id = ?').run(order.points_used, req.user.id);
      }
      // 删除库存锁定
      db.prepare('DELETE FROM inventory_locks WHERE order_id = ?').run(order.id);
      // 更新订单状态
      db.prepare('UPDATE orders SET status = ?, updated_at = datetime("now") WHERE id = ?').run('cancelled', order.id);
    });
    cancelTx();
    res.json({ ok: true, message: '订单已取消' + (order.points_used > 0 ? `，已退还 ${order.points_used} 积分` : '') });
  } catch (e) {
    console.error('Cancel order error:', e);
    res.status(500).json({ ok: false, message: '取消订单失败' });
  }
});

// 前台申请退款（仅提交申请，需后台同意后才执行退款）
router.post('/order/refund', requireLogin, (req, res) => {
  const orderNo = sanitizeOrderNo(req.body.order_no);
  if (!orderNo) return res.redirect('/shop/orders?error=refund&msg=' + encodeURIComponent('缺少或无效订单号'));
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ? AND user_id = ? AND status = ?').get(orderNo, req.user.id, 'paid');
  if (!order || !order.epay_trade_no) {
    return res.redirect('/shop/orders?error=refund&msg=' + encodeURIComponent('订单不存在或不可退款'));
  }
  const existing = db.prepare('SELECT id FROM refund_requests WHERE order_id = ? AND status = ?').get(order.id, 'pending');
  if (existing) {
    return res.redirect('/shop/orders?error=refund&msg=' + encodeURIComponent('该订单已提交过退款申请，请等待处理'));
  }
  db.prepare('INSERT INTO refund_requests (order_id, status) VALUES (?, ?)').run(order.id, 'pending');
  logPayment('refund_request', {
    orderId: order.id,
    orderNo: order.order_no,
    payload: { user_id: req.user.id, username: req.user.username },
    result: 'success',
    message: '用户提交退款申请',
  });
  res.redirect('/shop/orders?refund_request=ok');
});

// 凭订单号查询卡密（支付成功后任何人可查；若订单仍待支付会先向网关查单并同步状态）
router.get('/order/:orderNo/cards', async (req, res) => {
  const orderNo = sanitizeOrderNo(req.params.orderNo);
  if (!orderNo) return res.status(400).json({ message: '无效订单号' });
  let order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
  if (!order) return res.status(404).json({ message: '订单不存在' });
  if (order.status === 'pending') {
    await syncOrderByGateway(orderNo);
    order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
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

// 提交评价
router.post('/order/review', requireLogin, (req, res) => {
  const { order_no, rating, content } = req.body;
  const orderNo = sanitizeOrderNo(order_no);
  const starRating = Math.max(1, Math.min(5, parseInt(rating) || 5));

  if (!orderNo) return res.status(400).json({ ok: false, message: '无效订单号' });

  const order = db.prepare('SELECT * FROM orders WHERE order_no = ? AND user_id = ? AND status = ?').get(orderNo, req.user.id, 'paid');
  if (!order) {
    return res.status(400).json({ ok: false, message: '订单不存在或未完成' });
  }

  const existing = db.prepare('SELECT id FROM reviews WHERE order_id = ?').get(order.id);
  if (existing) {
    return res.status(400).json({ ok: false, message: '您已经评价过该订单了' });
  }

  try {
    db.prepare('INSERT INTO reviews (user_id, product_id, order_id, rating, content) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id,
      order.product_id,
      order.id,
      starRating,
      content || ''
    );
    res.json({ ok: true, message: '评价提交成功' });
  } catch (e) {
    console.error('Review submission error:', e);
    res.status(500).json({ ok: false, message: '评价提交失败' });
  }
});

export default router;
