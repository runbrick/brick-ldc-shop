/**
 * credit.linux.do 易支付兼容接口
 * 文档: https://credit.linux.do/docs/api
 * 连接超时时可在 .env 设置 EPAY_HTTP_PROXY 或 OAUTH_HTTP_PROXY 走代理
 */
import crypto from 'crypto';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from '../config.js';

const { pid, key, baseUrl, notifyUrl, returnUrl, proxy, timeout } = config.epay;

function timeoutSignal(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

const baseOpts = proxy ? { agent: new HttpsProxyAgent(proxy) } : {};

function toSignString(params) {
  const filtered = Object.fromEntries(
    Object.entries(params).filter(
      ([k, v]) => k !== 'sign' && k !== 'sign_type' && v != null && v !== ''
    )
  );
  const sorted = Object.keys(filtered).sort();
  return sorted.map((k) => `${k}=${filtered[k]}`).join('&');
}

function sign(params) {
  const str = toSignString(params) + key;
  return crypto.createHash('md5').update(str).digest('hex').toLowerCase();
}

/**
 * 创建支付（积分流转）并返回跳转 URL
 * 成功时平台会 302 到认证页，这里返回该 URL 供前端跳转
 */
export async function createPay({ out_trade_no, name, money, return_url_override, notify_url_override }) {
  if (!pid || !key) {
    throw new Error('支付未配置：请在 .env 中设置 EPAY_PID 和 EPAY_KEY（在 credit.linux.do 控制台创建应用获取）');
  }
  const params = {
    pid,
    type: 'epay',
    out_trade_no,
    name: String(name).slice(0, 64),
    money: Number(money).toFixed(2),
    notify_url: notify_url_override || notifyUrl,
    return_url: return_url_override || returnUrl,
    sign_type: 'MD5',
  };
  if (!params.money || Number(params.money) <= 0) {
    throw new Error('金额必须大于0');
  }
  params.sign = sign(params);

  const res = await fetch(`${baseUrl}/pay/submit.php`, {
    ...baseOpts,
    signal: timeoutSignal(timeout),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    redirect: 'manual',
  });

  if (res.status === 302 && res.headers.get('location')) {
    return { redirectUrl: res.headers.get('location') };
  }
  const body = await res.json().catch(() => ({}));
  throw new Error(body.error_msg || `支付创建失败: ${res.status}`);
}

/**
 * 查询订单状态
 * @returns { code, status: 1成功 0失败/处理中, ... }
 */
export async function queryOrder(out_trade_no) {
  const params = new URLSearchParams({
    act: 'order',
    pid,
    key,
    out_trade_no,
  });
  const res = await fetch(`${baseUrl}/api.php?${params}`, { ...baseOpts, signal: timeoutSignal(timeout) });
  if (res.status === 404) {
    return { code: -1, msg: '服务不存在或已完成' };
  }
  return res.json();
}

/**
 * 退款（全额退回积分）
 * 文档：POST /api.php，参数 pid, key, trade_no, money
 */
export async function refund(trade_no, money) {
  const body = new URLSearchParams({
    pid,
    key,
    trade_no,
    money: Number(money).toFixed(2),
  });
  const res = await fetch(`${baseUrl}/api.php`, {
    ...baseOpts,
    signal: timeoutSignal(timeout),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return { code: -1, msg: text || '退款接口返回异常' };
  }
}

/**
 * 验证异步通知签名
 */
export function verifyNotify(query) {
  const signReceived = query.sign;
  if (!signReceived) return false;
  const params = { ...query };
  delete params.sign;
  delete params.sign_type;
  const expected = sign(params);
  return expected === signReceived.toLowerCase();
}
