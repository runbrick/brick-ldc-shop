import { Router } from 'express';
import db from '../db.js';
import * as epay from '../services/epay.js';

const router = Router();

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

  db.transaction(() => {
    db.prepare(
      'UPDATE orders SET status = ?, epay_trade_no = ?, paid_at = datetime("now") WHERE id = ?'
    ).run('paid', trade_no, order.id);
    const cards = db.prepare(
      'SELECT id FROM cards WHERE product_id = ? AND used = 0 ORDER BY id LIMIT ?'
    ).all(order.product_id, order.quantity);
    for (let i = 0; i < cards.length; i++) {
      db.prepare('UPDATE cards SET used = 1, order_id = ? WHERE id = ?').run(order.id, cards[i].id);
    }
    const cardContents = cards.map((c) => {
      const row = db.prepare('SELECT card_content FROM cards WHERE id = ?').get(c.id);
      return row?.card_content;
    }).filter(Boolean);
    db.prepare(
      'UPDATE products SET stock = stock - ? WHERE id = ?'
    ).run(cards.length, order.product_id);
    order.delivered_cards = cardContents;
  })();

  res.send('success');
});

// 轮询订单状态（供前台查询是否已支付并发卡）
router.get('/order-status/:orderNo', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(req.params.orderNo);
  if (!order) {
    return res.json({ ok: false, message: '订单不存在' });
  }
  if (order.status === 'paid') {
    const cards = db.prepare('SELECT card_content FROM cards WHERE order_id = ?').all(order.id);
    return res.json({
      ok: true,
      status: 'paid',
      cards: cards.map((c) => c.card_content),
    });
  }
  res.json({ ok: true, status: order.status });
});

export default router;
