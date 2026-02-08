/**
 * Linux.do OAuth2 登录对接
 * 参考: https://linux.do/t/topic/32752/1 创建 OAuth2 应用后配置 .env
 * 连接超时时可在 .env 设置 OAUTH_HTTP_PROXY=http://127.0.0.1:7890 等走代理
 */
import crypto from 'crypto';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from '../config.js';

const { clientId, clientSecret, authorizeUrl, tokenUrl, userInfoUrl, callbackPath, proxy, timeout } = config.oauth;

function timeoutSignal(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

const baseOpts = proxy ? { agent: new HttpsProxyAgent(proxy) } : {};

export function getAuthorizeUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    // scope: 'session_info',
    state: state || crypto.randomBytes(16).toString('hex'),
  });
  return `${authorizeUrl}?${params}`;
}

export async function exchangeCodeForToken(code, redirectUri) {
  if (process.env.OAUTH_DEBUG) {
    console.log('[OAuth] tokenUrl:', tokenUrl, 'redirect_uri:', redirectUri, 'proxy:', proxy ? 'yes' : 'no');
  }
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  const res = await fetch(tokenUrl, {
    ...baseOpts,
    signal: timeoutSignal(timeout),
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token 交换失败: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * 使用 refresh_token 刷新 access_token（定期调用以保持登录有效）
 */
export async function refreshAccessToken(refreshToken) {
  if (!refreshToken) throw new Error('缺少 refresh_token');
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  const res = await fetch(tokenUrl, {
    ...baseOpts,
    signal: timeoutSignal(timeout),
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token 刷新失败: ${res.status} ${text}`);
  }
  return res.json();
}

export async function getUserInfo(accessToken) {
  const res = await fetch(userInfoUrl, {
    ...baseOpts,
    signal: timeoutSignal(timeout),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`获取用户信息失败: ${res.status} ${text}`);
  }
  return res.json();
}

export function getCallbackUrl(baseUrl) {
  return new URL(callbackPath, baseUrl).href;
}

export function isOAuthConfigured() {
  return Boolean(clientId && clientSecret);
}
