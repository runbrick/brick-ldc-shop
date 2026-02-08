/**
 * 支付相关操作日志：支付发起、异步回调、查单、退款申请/同意/拒绝/接口调用
 */
import db from '../db.js';

/**
 * 写入一条支付日志
 * @param {string} eventType - pay_create | pay_notify | pay_query | refund_request | refund_approve | refund_reject | refund_api
 * @param {object} opts
 * @param {number} [opts.orderId]
 * @param {string} [opts.orderNo]
 * @param {object|string} [opts.payload] - 请求/回调/响应内容，会 JSON.stringify 存储
 * @param {string} [opts.result] - success | fail | ignore
 * @param {string} [opts.message]
 */
export function logPayment(eventType, opts = {}) {
  const { orderId, orderNo, payload, result, message } = opts;
  const payloadStr = payload !== undefined && payload !== null
    ? (typeof payload === 'string' ? payload : JSON.stringify(payload))
    : null;
  try {
    db.prepare(
      `INSERT INTO payment_logs (order_id, order_no, event_type, payload, result, message)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      orderId ?? null,
      orderNo ?? null,
      eventType,
      payloadStr,
      result ?? null,
      message ?? null
    );
  } catch (e) {
    console.error('payment_log insert error:', e);
  }
}
