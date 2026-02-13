/**
 * 单设备登录：仅允许用户在一个设备上保持登录，其他设备的会话在下次请求时会被踢出
 */
import db from '../db.js';

export function singleDeviceSession(req, res, next) {
  if (!req.session || !req.session.user || !req.session.user.id) return next();
  try {
    const row = db.prepare('SELECT active_session_id FROM users WHERE id = ?').get(req.session.user.id);
    if (!row || row.active_session_id == null) return next();
    if (row.active_session_id === req.sessionID) return next();

    req.session.destroy((err) => {
      if (err) console.warn('[single-device] session destroy err:', err);
      const to = '/login?error=other_device';
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ ok: false, message: '您已在其他设备登录，当前会话已退出', redirect: to });
      }
      res.redirect(to);
    });
  } catch (e) {
    next(e);
  }
}
