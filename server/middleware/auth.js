import db from '../db.js';

export function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ ok: false, message: '请先登录' });
  }
  res.redirect('/shop/login?next=' + encodeURIComponent(req.originalUrl || '/shop'));
}

export function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.isAdmin) return next();
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(403).json({ ok: false, message: '需要管理员权限' });
  }
  res.redirect('/shop');
}

export function optionalUser(req, res, next) {
  if (req.session && req.session.user) {
    try {
      const user = db.prepare('SELECT id, username, linux_do_id, is_admin, is_banned, points, last_checkin_at FROM users WHERE id = ?').get(req.session.user.id);
      if (!user || user.is_banned === 1) {
        delete req.session.user;
        req.user = null;
        return next();
      }
      req.user = {
        id: user.id,
        username: user.username,
        linuxDoId: user.linux_do_id,
        points: user.points,
        isAdmin: user.is_admin === 1 || req.session.user.isAdmin,
        last_checkin_at: user.last_checkin_at,
      };
      return next();
    } catch (e) {
      console.error('optionalUser error:', e);
    }
  }
  req.user = null;
  next();
}
