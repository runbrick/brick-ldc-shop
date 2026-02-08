/**
 * 基于 sql.js 的 session 持久化存储，重启不丢失登录态
 * @param { () => object } getDb - 返回已初始化的 db 的函数（避免启动顺序依赖）
 */
import session from 'express-session';

export default function createSessionStore(getDb) {
  return new (class SqliteStore extends session.Store {
    get(sid, callback) {
      const db = getDb();
      if (!db) return callback();
      try {
        const row = db.prepare('SELECT session, expire FROM sessions WHERE sid = ?').get(sid);
        if (!row) return callback();
        if (row.expire < Date.now()) {
          this.destroy(sid, () => callback());
          return;
        }
        callback(null, JSON.parse(row.session));
      } catch (e) {
        callback(e);
      }
    }

    set(sid, sess, callback) {
      const db = getDb();
      if (!db) return callback();
      const expire = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
      try {
        db.prepare('INSERT OR REPLACE INTO sessions (sid, session, expire) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expire);
        callback();
      } catch (e) {
        callback(e);
      }
    }

    destroy(sid, callback) {
      const db = getDb();
      if (!db) return callback();
      try {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        callback();
      } catch (e) {
        callback(e);
      }
    }

    touch(sid, sess, callback) {
      const db = getDb();
      if (!db) return callback();
      const expire = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
      try {
        db.prepare('UPDATE sessions SET session = ?, expire = ? WHERE sid = ?').run(JSON.stringify(sess), expire, sid);
        callback();
      } catch (e) {
        callback(e);
      }
    }
  })();
}
