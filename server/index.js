import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import db, { init as initDb } from './db.js';
import { config } from './config.js';
import createSessionStore from './session-store.js';
import { refreshAccessToken, getUserInfo } from './services/oauth-linux-do.js';
import { singleDeviceSession } from './middleware/single-device.js';
import authRoutes from './routes/auth.js';
import shopRoutes from './routes/shop.js';
import adminRoutes from './routes/admin.js';
import apiPayRoutes from './routes/api-pay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { ok: false, message: '请求过于频繁，请稍后再试' },
    standardHeaders: true,
    legacyHeaders: false,
  })
);
app.use(cookieParser());
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: createSessionStore(() => db),
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.SECURE_COOKIE === '1',
    },
  })
);
app.use(singleDeviceSession);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(async (req, res, next) => {
  if (!req.session?.user?.id) return next();
  if (typeof db.prepare !== 'function') return next();
  try {
    const row = db.prepare('SELECT id, refresh_token, token_expires_at FROM users WHERE id = ?').get(req.session.user.id);
    if (!row?.refresh_token) return next();
    const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
    const now = Date.now();
    const fiveMin = 5 * 60 * 1000;
    if (expiresAt > now + fiveMin) return next();
    const tokenRes = await refreshAccessToken(row.refresh_token);
    const newRefresh = tokenRes.refresh_token ?? row.refresh_token;
    const expiresIn = Number(tokenRes.expires_in) || 7200;
    const newExpiresAt = new Date(now + expiresIn * 1000).toISOString();
    db.prepare('UPDATE users SET refresh_token = ?, token_expires_at = ?, updated_at = datetime("now") WHERE id = ?').run(newRefresh, newExpiresAt, row.id);
    const userInfo = await getUserInfo(tokenRes.access_token);
    const username = userInfo.username ?? userInfo.name ?? String(userInfo.id ?? userInfo.user_id ?? '');
    const avatarUrl = userInfo.avatar_template ? userInfo.avatar_template.replace('{size}', '96') : null;
    const email = userInfo.email ?? null;
    db.prepare('UPDATE users SET username = ?, avatar_url = ?, email = ? WHERE id = ?').run(username, avatarUrl, email, row.id);
    if (req.session.user) {
      req.session.user.username = username;
      req.session.user.avatarUrl = avatarUrl;
    }
  } catch (e) {
    console.warn('[OAuth] refresh token failed:', e.message);
  }
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res, next) => {
  res.locals.siteName = (db.getSetting && db.getSetting('site_name')) || '砖头商城';
  res.locals.homeSubtitle = (db.getSetting && db.getSetting('home_subtitle')) || '选择商品，使用 Linux.do 积分支付';
  res.locals.siteFooterText = (db.getSetting && db.getSetting('site_footer_text')) || '砖头商城 · Linux.do 登录 · credit.linux.do 支付';
  res.locals.siteBackground = (db.getSetting && db.getSetting('site_background')) || '';
  res.locals.footerCol1 = (db.getSetting && db.getSetting('footer_col1')) || '';
  // res.locals.footerCol2 removed
  res.locals.footerCol3 = (db.getSetting && db.getSetting('footer_col3')) || '';
  res.locals.footerCol4 = (db.getSetting && db.getSetting('footer_col4')) || '';
  // res.locals.footerLinks removed, using db query now
  try {
    if (typeof db.prepare === 'function') {
      res.locals.friendlyLinks = db.prepare('SELECT * FROM links WHERE is_active = 1 ORDER BY sort DESC, id ASC').all();
    }
  } catch (_) { res.locals.friendlyLinks = []; }
  next();
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { ok: false, message: '登录尝试过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});
const orderCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { ok: false, message: '操作过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/auth/linux-do', authLimiter, authRoutes);
app.use('/api/pay', apiPayRoutes);
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/shop/order/create') return orderCreateLimiter(req, res, next);
  next();
});
app.use('/shop', shopRoutes);
app.use('/admin', adminRoutes);

app.get('/', (req, res) => res.redirect('/shop'));

app.use((req, res) => {
  res.status(404).render('shop/404', { title: '404', user: null });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('shop/500', { title: '错误', message: err.message });
});

async function start() {
  await initDb();
  app.listen(config.port, () => {
    console.log(`砖头商城运行: http://localhost:${config.port}`);
    console.log('  前台: /shop  后台: /admin');
  });
}
start().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
