import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { config } from '../config.js';
import {
  getAuthorizeUrl,
  exchangeCodeForToken,
  getUserInfo,
  getCallbackUrl,
  isOAuthConfigured,
} from '../services/oauth-linux-do.js';

const router = Router();
const stateStore = new Map();

router.get('/login', (req, res) => {
  if (!isOAuthConfigured()) {
    return res.redirect('/shop?oauth=not_configured');
  }
  const baseUrl = config.baseUrl;
  const redirectUri = getCallbackUrl(baseUrl);
  const state = crypto.randomBytes(16).toString('hex');
  stateStore.set(state, { redirect: req.query.next || '/shop' });
  const url = getAuthorizeUrl(redirectUri, state);
  res.redirect(url);
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const redirectTo = state && stateStore.get(state)?.redirect || '/shop';
  if (state) stateStore.delete(state);

  if (!code) {
    return res.redirect('/shop/login?error=no_code');
  }

  const baseUrl = config.baseUrl;
  const redirectUri = getCallbackUrl(baseUrl);

  try {
    const tokenRes = await exchangeCodeForToken(code, redirectUri);
    const accessToken = tokenRes.access_token;
    const refreshToken = tokenRes.refresh_token || null;
    const expiresIn = Number(tokenRes.expires_in) || 7200;
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    const userInfo = await getUserInfo(accessToken);

    const linuxDoId = String(userInfo.id ?? userInfo.user_id ?? userInfo.username);
    const username = userInfo.username ?? userInfo.name ?? linuxDoId;
    const avatarUrl = userInfo.avatar_template ? userInfo.avatar_template.replace('{size}', '96') : null;
    const email = userInfo.email ?? null;

    let user = db.prepare('SELECT * FROM users WHERE linux_do_id = ?').get(linuxDoId);
    if (!user) {
      db.prepare(
        'INSERT INTO users (linux_do_id, username, avatar_url, email, refresh_token, token_expires_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(linuxDoId, username, avatarUrl, email, refreshToken, tokenExpiresAt);
      user = db.prepare('SELECT * FROM users WHERE linux_do_id = ?').get(linuxDoId);
    } else {
      db.prepare(
        'UPDATE users SET username = ?, avatar_url = ?, email = ?, updated_at = datetime("now"), refresh_token = ?, token_expires_at = ? WHERE id = ?'
      ).run(username, avatarUrl, email, refreshToken, tokenExpiresAt, user.id);
      user = db.prepare('SELECT * FROM users WHERE linux_do_id = ?').get(linuxDoId);
    }

    const isAdminByDb = user.is_admin === 1;
    const adminUserIds = process.env.ADMIN_USER_IDS?.split(',') || [];
    const adminLinuxDoIds = process.env.ADMIN_LINUX_DO_ID?.split(',') || [];
    
    const isAdminByEnv = adminUserIds.includes(String(user.id)) || 
                         adminLinuxDoIds.includes(String(user.linux_do_id));

    req.session.user = {
      id: user.id,
      username: user.username,
      avatarUrl: user.avatar_url,
      linuxDoId: user.linux_do_id,
      isAdmin: isAdminByDb || isAdminByEnv,
    };
    db.prepare('UPDATE users SET active_session_id = ? WHERE id = ?').run(req.sessionID, user.id);
    req.session.save((err) => {
      if (err) return res.redirect('/shop/login?error=session');
      res.redirect(redirectTo);
    });
  } catch (e) {
    console.error('OAuth callback error:', e);
    const isNetwork =
      e.name === 'AbortError' ||
      e.type === 'aborted' ||
      e.cause?.code === 'ETIMEDOUT' ||
      e.cause?.code === 'ECONNREFUSED' ||
      e.code === 'ETIMEDOUT' ||
      e.code === 'ECONNREFUSED' ||
      /ETIMEDOUT|ECONNREFUSED|fetch failed|aborted/i.test(e.message || '');
    const msg = isNetwork
      ? '无法连接登录服务器（超时或被墙），请在 .env 中设置 OAUTH_HTTP_PROXY 使用代理后重试'
      : e.message;
    req.session.oauthErrorMessage = msg;
    req.session.save((err) => {
      res.redirect('/shop/login?error=oauth');
    });
  }
});

router.get('/logout', (req, res) => {
  const userId = req.session?.user?.id;
  if (userId) {
    try {
      db.prepare('UPDATE users SET refresh_token = NULL, token_expires_at = NULL WHERE id = ?').run(userId);
    } catch (_) {}
  }
  req.session.destroy(() => res.redirect('/shop'));
});

export default router;
