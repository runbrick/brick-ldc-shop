# 发卡平台

Node.js 发卡平台：前台商城 + 后台管理，对接 **Linux.do OAuth 登录** 与 **credit.linux.do 易支付**。

## 功能

- **前台商城**：商品列表、商品详情、下单、Linux.do 积分支付、订单结果页（自动发卡）、我的订单
- **后台管理**：概览、商品 CRUD、卡密批量导入、订单列表与退款
- **登录**：Linux.do OAuth2（需在 Linux.do 创建 OAuth2 应用）
- **支付**：credit.linux.do 易支付兼容接口（需在控制台创建应用，配置 pid/key、回调地址）

## 快速开始

```bash
# 安装依赖（使用 sql.js 纯 JS 数据库，无需 node-gyp/Python）
npm install

# 复制环境变量并填写
cp .env.example .env

# 启动（开发可加 --watch）
npm run dev
```

访问：前台 http://localhost:3000/shop ，后台 http://localhost:3000/admin（需管理员账号）。

## 配置说明

### 1. Linux.do OAuth 登录

- 在 Linux.do 站点创建 OAuth2 应用（若论坛提供该功能，一般位于 设置 → 应用 或 管理 → 应用）。
- 文档参考：<https://linux.do/t/topic/32752/1>（若链接失效，请在论坛搜索「OAuth」或「应用」）。
- 配置项：
  - **回调地址**：`https://你的域名/auth/linux-do/callback`（本地测试可用 ngrok 等：`https://xxx.ngrok.io/auth/linux-do/callback`）
  - 将获得的 **Client ID** 填入 `LINUX_DO_OAUTH_CLIENT_ID`
  - 将 **Client Secret** 填入 `LINUX_DO_OAUTH_CLIENT_SECRET`
- 若 Linux.do 使用的 OAuth 端点与默认不同，可覆盖：
  - `LINUX_DO_OAUTH_AUTHORIZE_URL`
  - `LINUX_DO_OAUTH_TOKEN_URL`
  - `LINUX_DO_OAUTH_USERINFO_URL`

### 2. credit.linux.do 易支付

- 文档：<https://credit.linux.do/docs/api>
- 在 credit.linux.do 控制台创建应用，获取 **pid**、**key**，并设置 **回调地址**：
  - 异步通知：`https://你的域名/api/pay/notify`
- `.env` 配置：
  - `EPAY_PID`、`EPAY_KEY`
  - `EPAY_NOTIFY_URL`：异步通知地址（需与控制台一致）
  - `EPAY_RETURN_URL`：支付完成跳转（如 `https://你的域名/shop/order/result`）
  - `EPAY_BASE_URL` 默认 `https://credit.linux.do/epay`，一般无需修改

### 3. 管理员

- 将允许登录后台的用户 ID 填入 `ADMIN_USER_IDS`，多个用逗号分隔，例如：`ADMIN_USER_IDS=1,2`。
- 用户 ID 在首次用 Linux.do 登录后，可在项目目录下 `data/shop.db` 的 `users` 表中查看。

## 项目结构

```
server/
  config.js          # 配置
  db.js              # SQLite 与表结构
  index.js           # Express 入口
  middleware/auth.js # 登录/管理员校验
  routes/
    auth.js          # Linux.do OAuth 回调与登出
    shop.js          # 前台：首页、商品、下单、订单
    admin.js         # 后台：商品、卡密、订单
    api-pay.js       # 支付回调、订单状态查询
  services/
    oauth-linux-do.js # OAuth 授权 URL、换 token、拉用户信息
    epay.js          # 易支付：下单、查询、退款、验签
  views/             # EJS 模板
```

## 技术栈

- Node.js (ESM) + Express
- EJS + Tailwind CSS（CDN）
- better-sqlite3
- 登录：Session；支付：易支付 MD5 签名

## 协议与免责

- 本仓库仅供学习与自建使用。
- Linux.do、credit.linux.do 的接口与策略以官方文档与站点为准。
