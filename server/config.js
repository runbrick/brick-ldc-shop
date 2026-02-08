import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT) || 3000,
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,

  // Linux.do OAuth2（若连接超时，可设置 OAUTH_HTTP_PROXY 走代理）
  oauth: {
    clientId: process.env.LINUX_DO_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.LINUX_DO_OAUTH_CLIENT_SECRET || '',
    authorizeUrl: process.env.LINUX_DO_OAUTH_AUTHORIZE_URL || 'https://linux.do/oauth2/authorize',
    tokenUrl: process.env.LINUX_DO_OAUTH_TOKEN_URL || 'https://linux.do/oauth2/token',
    userInfoUrl: process.env.LINUX_DO_OAUTH_USERINFO_URL || 'https://linux.do/user-api/me',
    callbackPath: process.env.LINUX_DO_OAUTH_CALLBACK_PATH || '/auth/linux-do/callback',
    proxy: process.env.OAUTH_HTTP_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY || '',
    timeout: Number(process.env.OAUTH_REQUEST_TIMEOUT) || 60000,
  },

  // credit.linux.do 易支付（连接超时时可设置 EPAY_HTTP_PROXY 或复用 OAUTH_HTTP_PROXY）
  epay: {
    pid: process.env.EPAY_PID || '',
    key: process.env.EPAY_KEY || '',
    baseUrl: (process.env.EPAY_BASE_URL || 'https://credit.linux.do/epay').replace(/\/$/, ''),
    notifyUrl: process.env.EPAY_NOTIFY_URL || '',
    returnUrl: process.env.EPAY_RETURN_URL || '',
    proxy: process.env.EPAY_HTTP_PROXY || process.env.OAUTH_HTTP_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY || '',
    timeout: Number(process.env.EPAY_REQUEST_TIMEOUT) || 60000,
  },
};
