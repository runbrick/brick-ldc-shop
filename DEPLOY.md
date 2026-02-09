# 部署到服务器

## 1. 本地打包

在项目根目录执行：

```bash
npm run pack
```

会在 `release/` 下生成 `shop-card-platform-<版本号>.zip`，内含源码、`package.json`、`package-lock.json`、`.env.example`，不含 `node_modules`、`.env`、数据库文件。

## 2. 上传到服务器

将 zip 上传到服务器（如 `/opt/shop`），并解压：

```bash
cd /opt/shop
unzip shop-card-platform-1.0.0.zip
cd shop-card-platform-1.0.0
```

## 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少填写：
# - SESSION_SECRET（生产环境务必改为随机长字符串）
# - BASE_URL（站点对外地址，如 https://your-domain.com）
# - LINUX_DO_OAUTH_CLIENT_ID / LINUX_DO_OAUTH_CLIENT_SECRET（若使用 Linux.do 登录）
# - EPAY_PID / EPAY_KEY（若使用 credit.linux.do 支付）
# - EPAY_NOTIFY_URL / EPAY_RETURN_URL（支付回调与 return 地址，一般用 BASE_URL 拼接）
# - ADMIN_USER_IDS（管理员用户 ID，逗号分隔）
```

## 4. 安装依赖并启动

```bash
npm ci --omit=dev
# 或：npm install --production

# 直接前台运行（调试用）
npm start
```

默认监听 `PORT`（.env 中，默认 3000）。建议用进程管理器保活并开机自启。

### 使用 PM2（推荐）

```bash
npm install -g pm2
pm2 start server/index.js --name shop
pm2 save
pm2 startup
```

### 使用 systemd

在 `/etc/systemd/system/shop.service` 新建（路径按实际修改）：

```ini
[Unit]
Description=砖头商城
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/shop/shop-card-platform-1.0.0
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable shop
sudo systemctl start shop
sudo systemctl status shop
```

## 5. 反向代理（可选）

若用 Nginx 做反向代理并启用 HTTPS：

```nginx
server {
  listen 80;
  server_name your-domain.com;
  return 301 https://$server_name$request_uri;
}
server {
  listen 443 ssl;
  server_name your-domain.com;
  ssl_certificate /path/to/fullchain.pem;
  ssl_certificate_key /path/to/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

此时 `.env` 中 `BASE_URL` 应设为 `https://your-domain.com`，并视需要设置 `SECURE_COOKIE=1`。

## 6. 数据与上传目录

- 数据库 SQLite 文件会生成在项目下的 `data/` 目录（若不存在会自动创建）。
- 上传图片等会保存在 `public/uploads/`，部署时该目录可不存在，运行时会自动创建；若需持久化，请勿删除该目录。

## 7. 更新部署

重新执行 `npm run pack`，将新 zip 上传到服务器，解压到新目录（或覆盖旧目录），再执行：

```bash
cp .env .env.bak
# 若覆盖解压，注意保留 .env 或从 .env.bak 恢复
npm ci --omit=dev
pm2 restart shop
```

若数据库与上传文件在项目目录内，覆盖解压时不要删除 `data/` 和 `public/uploads/`。
