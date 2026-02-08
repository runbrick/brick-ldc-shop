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
  req.user = (req.session && req.session.user) || null;
  next();
}
