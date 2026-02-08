import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { init as initDb } from './db.js';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import shopRoutes from './routes/shop.js';
import adminRoutes from './routes/admin.js';
import apiPayRoutes from './routes/api-pay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cookieParser());
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/auth/linux-do', authRoutes);
app.use('/api/pay', apiPayRoutes);
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
    console.log(`发卡平台运行: http://localhost:${config.port}`);
    console.log('  前台: /shop  后台: /admin');
  });
}
start().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
