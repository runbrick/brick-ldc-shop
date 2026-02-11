import { Router } from 'express';
import db from '../db.js';
import * as epay from '../services/epay.js';
import { logPayment } from '../services/payment-log.js';
import { sanitizeOrderNo } from '../middleware/security.js';

const router = Router();

/** 将订单标记为已支付并发卡（供 notify 与主动查单共用） */
export function completeOrder(order, tradeNo) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
  const cardMode = product && product.card_mode === 1;
  const qty = order.quantity;

  db.prepare(
    'UPDATE orders SET status = ?, epay_trade_no = ?, paid_at = datetime("now") WHERE id = ?'
  ).run('paid', tradeNo || null, order.id);

  // 释放锁定并增加销量
  db.run('DELETE FROM inventory_locks WHERE order_id = ?', [order.id]);
  if (product) {
    db.run('UPDATE products SET sold_count = sold_count + ? WHERE id = ?', [qty, order.product_id]);
  }

  if (cardMode) {
    const allCards = db.prepare('SELECT id, card_content FROM cards WHERE product_id = ? ORDER BY id').all(order.product_id);
    const n = allCards.length;
    if (n > 0) {
      const paidCount = db.prepare('SELECT COUNT(*) as c FROM orders WHERE product_id = ? AND status = ?').get(order.product_id, 'paid').c;
      const contents = [];
      for (let i = 0; i < qty; i++) contents.push(allCards[(paidCount - 1 + i) % n].card_content);
      db.prepare('UPDATE orders SET delivered_cards = ? WHERE id = ?').run(JSON.stringify(contents), order.id);
    }
  } else {
    const cards = db.prepare(
      'SELECT id, card_content FROM cards WHERE product_id = ? AND used = 0 ORDER BY id LIMIT ?'
    ).all(order.product_id, qty);
    const contents = cards.map((c) => c.card_content);
    for (let i = 0; i < cards.length; i++) {
      db.prepare('UPDATE cards SET used = 1, order_id = ? WHERE id = ?').run(order.id, cards[i].id);
    }
    if (product && product.stock >= 0) {
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(cards.length, order.product_id);
    }
  }
}

/** 将订单标记为已退款并回滚卡密/库存（供后台与前台退款共用） */
export function markOrderRefundedAndRollback(order) {
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('refunded', order.id);
  
  // 退回积分
  if (order.points_used > 0 && order.user_id) {
    db.prepare('UPDATE users SET points = points + ?, updated_at = datetime("now") WHERE id = ?').run(order.points_used, order.user_id);
  }

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

/** 主动向支付网关查单并同步订单状态（异步回调未到时补偿） */
export async function syncOrderByGateway(orderNo) {
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ? AND status = ?').get(orderNo, 'pending');
  if (!order) return false;
  try {
    const result = await epay.queryOrder(orderNo);
    logPayment('pay_query', {
      orderId: order.id,
      orderNo,
      payload: { request: 'query', out_trade_no: orderNo },
      result: result && result.code === 1 && result.status === 1 ? 'success' : 'fail',
      message: result ? (result.msg || `code=${result.code} status=${result.status}`) : '无响应',
    });
    if (result && result.code === 1 && result.status === 1 && Math.abs(parseFloat(result.money) - order.amount) < 0.01) {
      completeOrder(order, result.trade_no);
      return true;
    }
  } catch (e) {
    console.error('syncOrderByGateway error:', e);
    logPayment('pay_query', {
      orderId: order.id,
      orderNo,
      payload: { request: 'query', out_trade_no: orderNo },
      result: 'fail',
      message: e.message || '查单异常',
    });
  }
  return false;
}

/** 自动取消过期订单并释放锁定 */
export async function cancelExpiredOrders() {
  const now = Math.floor(Date.now() / 1000);
  
  // 1. 处理带有过期锁定的订单
  const expiredLocks = db.prepare('SELECT * FROM inventory_locks WHERE expires_at < ?').all(now);
  for (const lock of expiredLocks) {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = ?').get(lock.order_id, 'pending');
    if (order) {
      await cancelOneOrder(order);
    }
    db.prepare('DELETE FROM inventory_locks WHERE id = ?').run(lock.id);
  }

  // 2. 处理没有锁定但已超时的订单（例如虚拟商品/无限库存，或者锁记录丢失）
  // 统一设置 15 分钟超时
  const timeoutSeconds = 15 * 60;
  const timeoutOrders = db.prepare(`
    SELECT * FROM orders 
    WHERE status = 'pending' 
    AND (strftime('%s', 'now') - strftime('%s', created_at)) > ?
  `).all(timeoutSeconds);

  for (const order of timeoutOrders) {
    await cancelOneOrder(order);
    // 确保相关锁定也被清除
    db.prepare('DELETE FROM inventory_locks WHERE order_id = ?').run(order.id);
  }
}

/** 取消单个订单并退还积分（内部调用） */
async function cancelOneOrder(order) {
  // 尝试向支付网关最后核实一次
  const isPaid = await syncOrderByGateway(order.order_no);
  if (isPaid) return;

  // 未支付则取消订单
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);
  
  // 退回积分
  if (order.points_used > 0 && order.user_id) {
    db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(order.points_used, order.user_id);
    console.log(`[Order Cleanup] Refunded ${order.points_used} points for order ${order.order_no}`);
  }
  
  console.log(`[Order Cleanup] Cancelled order ${order.order_no}`);
}

// 易支付异步通知（认证成功）
router.get('/notify', (req, res) => {
  const q = req.query;
  const callbackPayload = {
    out_trade_no: q.out_trade_no,
    trade_no: q.trade_no,
    trade_status: q.trade_status,
    money: q.money,
    type: q.type,
  };

  if (q.trade_status !== 'TRADE_SUCCESS') {
    logPayment('pay_notify', {
      orderNo: q.out_trade_no,
      payload: callbackPayload,
      result: 'ignore',
      message: 'trade_status 非 TRADE_SUCCESS',
    });
    return res.status(400).send('ignore');
  }
  if (!epay.verifyNotify(q)) {
    logPayment('pay_notify', {
      orderNo: q.out_trade_no,
      payload: callbackPayload,
      result: 'fail',
      message: '签名验证失败',
    });
    return res.status(400).send('fail');
  }
  const out_trade_no = sanitizeOrderNo(q.out_trade_no);
  if (!out_trade_no) {
    logPayment('pay_notify', { orderNo: q.out_trade_no, payload: callbackPayload, result: 'fail', message: '无效订单号' });
    return res.status(400).send('fail');
  }
  const trade_no = (q.trade_no && String(q.trade_no).trim().slice(0, 128)) || '';
  const money = parseFloat(q.money);

  const order = db.prepare('SELECT * FROM orders WHERE order_no = ? AND status = ?').get(out_trade_no, 'pending');
  if (!order) {
    logPayment('pay_notify', {
      orderNo: out_trade_no,
      payload: callbackPayload,
      result: 'ignore',
      message: '订单不存在或已处理',
    });
    return res.send('success');
  }
  if (Math.abs(order.amount - money) > 0.01) {
    logPayment('pay_notify', {
      orderId: order.id,
      orderNo: out_trade_no,
      payload: callbackPayload,
      result: 'fail',
      message: `金额不一致 订单:${order.amount} 回调:${money}`,
    });
    return res.status(400).send('fail');
  }

  completeOrder(order, trade_no);
  logPayment('pay_notify', {
    orderId: order.id,
    orderNo: out_trade_no,
    payload: callbackPayload,
    result: 'success',
    message: `已完成订单 trade_no=${trade_no}`,
  });
  res.send('success');
});

// 轮询订单状态（供前台查询是否已支付并出卡）
router.get('/order-status/:orderNo', (req, res) => {
  const orderNo = sanitizeOrderNo(req.params.orderNo);
  if (!orderNo) return res.status(400).json({ ok: false, message: '无效订单号' });
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
  if (!order) {
    return res.json({ ok: false, message: '订单不存在' });
  }
  if (order.status === 'paid') {
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
    return res.json({ ok: true, status: 'paid', cards });
  }
  res.json({ ok: true, status: order.status });
});

export default router;
