/**
 * 安全相关：ID 校验、订单号校验、防止 SQL 注入与非法参数
 */

/**
 * 解析为安全整数 ID，非法则返回 null
 * @param {any} value - req.params.id / req.query.id 等
 * @returns {number|null}
 */
export function parseId(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(String(value), 10);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) return null;
  return n;
}

/**
 * 订单号只允许字母数字和少量符号，防止注入
 * @param {string} orderNo
 * @returns {string|null} 合法则返回原串，否则 null
 */
export function sanitizeOrderNo(orderNo) {
  if (typeof orderNo !== 'string') return null;
  const s = orderNo.trim().slice(0, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  return s || null;
}

/**
 * 排序参数白名单，防止 ORDER BY 注入
 */
export const SORT_WHITELIST = new Set(['price_asc', 'price_desc', 'sales_desc', '']);

export function sanitizeSort(sort) {
  const s = typeof sort === 'string' ? sort.trim() : '';
  return SORT_WHITELIST.has(s) ? s : '';
}
