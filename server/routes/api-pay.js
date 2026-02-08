import { Router } from 'express';
import db from '../db.js';
import * as epay from '../services/epay.js';

const router = Router();

/** 将订单标记为已支付并发卡（供 notify 与主动查单共用） */
function completeOrder(order, tradeNo) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
  const cardMode = product && product.card_mode === 1;
  const qty = order.quantity;

  db.prepare(
    'UPDATE orders SET status = ?, epay_trade_no = ?, paid_at = datetime("now") WHERE id = ?'
  ).run('paid', tradeNo || null, order.id);

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

/** 主动向支付网关查单并同步订单状态（异步回调未到时补偿） */
export async function syncOrderByGateway(orderNo) {
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ? AND status = ?').get(orderNo, 'pending');
  if (!order) return false;
  try {
    const result = await epay.queryOrder(orderNo);
    if (result && result.code === 1 && result.status === 1 && Math.abs(parseFloat(result.money) - order.amount) < 0.01) {
      completeOrder(order, result.trade_no);
      return true;
    }
  } catch (e) {
    console.error('syncOrderByGateway error:', e);
  }
  return false;
}

// 易支付异步通知（认证成功）
router.get('/notify', (req, res) => {
  const q = req.query;
  if (q.trade_status !== 'TRADE_SUCCESS') {
    return res.status(400).send('ignore');
  }
  if (!epay.verifyNotify(q)) {
    return res.status(400).send('fail');
  }
  const out_trade_no = q.out_trade_no;
  const trade_no = q.trade_no;
  const money = parseFloat(q.money);

  const order = db.prepare('SELECT * FROM orders WHERE order_no = ? AND status = ?').get(out_trade_no, 'pending');
  if (!order) {
    return res.send('success');
  }
  if (Math.abs(order.amount - money) > 0.01) {
    return res.status(400).send('fail');
  }

  completeOrder(order, trade_no);
  res.send('success');
});

// 轮询订单状态（供前台查询是否已支付并出卡）
router.get('/order-status/:orderNo', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(req.params.orderNo);
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
