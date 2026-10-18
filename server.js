// ============================================================
// WebPanel — Node.js 一体化服务（替代 Nginx）
// 功能：
//   1. 提供管理面板静态文件（index.html 等）
//   2. 反向代理 /terminal/ 到本地 ttyd（含 WebSocket）
//   3. 自动启动 ttyd 子进程
//   4. 可选启动内网穿透工具（cpolar / chmlfrp / frp / ngrok）
//   5. 会话认证 + 安全响应头 + Origin 校验 + 速率限制
// 启动：npm install && npm start
// ============================================================

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const httpProxy = require('http-proxy');

// ---------- 读取配置 ----------
const PORT = parseInt(process.env.PORT) || 9999;
const TTYD_PORT = parseInt(process.env.TTYD_PORT) || 7681;
const TTYD_EXEC = process.env.TTYD_EXEC || path.join(__dirname, (process.platform === 'win32' ? 'ttyd.exe' : 'ttyd'));
const TTYD_SHELL = process.env.TTYD_SHELL || (process.platform === 'win32' ? 'cmd.exe' : 'bash');
const TUNNEL_TOOL = process.env.TUNNEL_TOOL || 'cpolar'; // cpolar | chmlfrp | frp | ngrok
const TUNNEL_ENABLE = process.env.TUNNEL_ENABLE !== 'false'; // 默认启用内网穿透

// ---- 认证配置 ----
// 管理面板登录账号（必须在 .env 中设置，否则自动生成随机密码并打印到控制台）
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || generateRandomPassword();
// 会话密钥，用于签名 cookie
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// 会话有效期（毫秒），默认 12 小时
const SESSION_TTL = parseInt(process.env.SESSION_TTL) || 12 * 60 * 60 * 1000;
// ttyd 内部认证（Node.js 代理自动注入，用户无需感知）
const TTYD_USERNAME = process.env.TTYD_USERNAME || 'webpanel_internal';
const TTYD_PASSWORD = process.env.TTYD_PASSWORD || crypto.randomBytes(24).toString('base64');
// ttyd basic auth 头（预编码）
const TTYD_AUTH_HEADER = 'Basic ' + Buffer.from(`${TTYD_USERNAME}:${TTYD_PASSWORD}`).toString('base64');

// ---- 速率限制配置 ----
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 分钟窗口
const RATE_LIMIT_MAX = 120;           // 每 IP 每分钟最多 120 次请求
const LOGIN_RATE_LIMIT_MAX = 5;       // 每 IP 每分钟最多 5 次登录尝试

// ---------- 子进程引用 ----------
let ttydProc = null;
let tunnelProc = null;
const childProcs = [];

// ---------- 会话存储（内存）----------
// sessionId -> { expiresAt }
const sessions = new Map();

// ---------- 速率限制存储（内存）----------
// ip -> { count, windowStart, loginCount, loginWindowStart }
const rateLimits = new Map();

function log(msg) {
  const time = new Date().toLocaleString();
  console.log(`[${time}] ${msg}`);
}

// ---------- 工具函数 ----------
function generateRandomPassword() {
  return crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
}

// 签名会话 ID
function signSession(sessionId) {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(sessionId);
  return sessionId + '.' + hmac.digest('base64').replace(/=/g, '');
}

// 验证签名
function verifySession(signed) {
  if (!signed || !signed.includes('.')) return null;
  const [sessionId, sig] = signed.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(sessionId).digest('base64').replace(/=/g, '');
  if (sig !== expected) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return sessionId;
}

// 解析 Cookie 头
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name] = rest.join('=');
  });
  return cookies;
}

// 获取客户端 IP
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---------- 速率限制 ----------
function checkRateLimit(ip, isLogin = false) {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry) {
    entry = { count: 0, windowStart: now, loginCount: 0, loginWindowStart: now };
    rateLimits.set(ip, entry);
  }
  // 重置窗口
  if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
    entry.count = 0;
    entry.windowStart = now;
  }
  if (now - entry.loginWindowStart > RATE_LIMIT_WINDOW) {
    entry.loginCount = 0;
    entry.loginWindowStart = now;
  }
  if (isLogin) {
    entry.loginCount++;
    return entry.loginCount <= LOGIN_RATE_LIMIT_MAX;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// ---------- 安全响应头 ----------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'X-XSS-Protection': '1; mode=block',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self'",
};

function setSecurityHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
}

// ---------- Origin 校验 ----------
function isValidOrigin(req) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true; // 无 Origin 头时放行（直接访问）
  const host = req.headers.host;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === host;
  } catch (_) {
    return false;
  }
}

// ---------- 1. 创建反向代理（把 /terminal/* -> ttyd）----------
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${TTYD_PORT}`,
  ws: true,
  changeOrigin: true
});

// 注入 ttyd 内部认证头，用户无需感知 ttyd 的 basic auth
proxy.on('proxyReq', (proxyReq) => {
  proxyReq.setHeader('Authorization', TTYD_AUTH_HEADER);
});

proxy.on('proxyReqWs', (proxyReq) => {
  proxyReq.setHeader('Authorization', TTYD_AUTH_HEADER);
});

proxy.on('error', (err, req, res) => {
  log(`[代理错误] ${err.message}`);
  try {
    if (res && res.writeHead) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('服务暂不可用，请稍后重试');
    }
  } catch (_) {}
});

// ---------- 2. 创建 HTTP 主服务 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendFile(res, filePath, maxAge = 0) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (maxAge > 0) {
      headers['Cache-Control'] = `public, max-age=${maxAge}`;
    } else {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ---------- 认证中间件 ----------
function requireAuth(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = verifySession(cookies['webpanel_session']);
  if (!sessionId) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getLoginPage());
    return false;
  }
  return true;
}

// ---------- 登录页面 ----------
function getLoginPage(errorMsg = '') {
  const errorHtml = errorMsg
    ? `<div class="mb-4 text-red-400 text-sm bg-red-900/30 border border-red-700 rounded px-3 py-2">${errorMsg}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WebPanel 登录</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap');
    * { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="bg-gray-900 text-gray-100 min-h-screen flex items-center justify-center">
  <div class="bg-gray-800 border border-gray-700 rounded-lg shadow-2xl p-8 w-full max-w-md">
    <div class="text-center mb-6">
      <i class="fas fa-terminal text-blue-400 text-4xl mb-3"></i>
      <h1 class="text-2xl font-bold">WebPanel 登录</h1>
      <p class="text-gray-400 text-sm mt-2">请输入管理员账号密码</p>
    </div>
    ${errorHtml}
    <form method="POST" action="/login">
      <div class="mb-4">
        <label class="block text-sm text-gray-400 mb-1">用户名</label>
        <input type="text" name="username" required autocomplete="username"
          class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-gray-100 focus:border-blue-400 focus:outline-none">
      </div>
      <div class="mb-6">
        <label class="block text-sm text-gray-400 mb-1">密码</label>
        <input type="password" name="password" required autocomplete="current-password"
          class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-gray-100 focus:border-blue-400 focus:outline-none">
      </div>
      <button type="submit"
        class="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2 rounded transition">
        登录
      </button>
    </form>
    <p class="text-gray-500 text-xs text-center mt-6">
      默认账号: admin / 密码请查看启动日志
    </p>
  </div>
</body>
</html>`;
}

// 解析 POST body
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  let reqUrl = decodeURIComponent(req.url.split('?')[0]);
  const clientIp = getClientIp(req);

  // 安全响应头
  setSecurityHeaders(res);

  // 速率限制（登录接口单独限制）
  const isLogin = reqUrl === '/login' && req.method === 'POST';
  if (!checkRateLimit(clientIp, isLogin)) {
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('请求过于频繁，请稍后再试');
    return;
  }

  // ---- 登录接口 ----
  if (reqUrl === '/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const params = new URLSearchParams(body);
    const username = params.get('username') || '';
    const password = params.get('password') || '';

    // 使用恒定时间比较，防止计时攻击
    // 注意：timingSafeEqual 要求两个 Buffer 长度相同，否则抛出异常
    // 为避免通过异常探测用户名/密码长度，先做长度检查并在不等长时返回 false
    let userOk = false;
    let passOk = false;
    const userBuf = Buffer.from(username);
    const adminBuf = Buffer.from(ADMIN_USERNAME);
    const passBuf = Buffer.from(password);
    const adminPassBuf = Buffer.from(ADMIN_PASSWORD);
    if (userBuf.length === adminBuf.length && passBuf.length === adminPassBuf.length) {
      userOk = crypto.timingSafeEqual(userBuf, adminBuf);
      passOk = crypto.timingSafeEqual(passBuf, adminPassBuf);
    }

    if (userOk && passOk) {
      const sessionId = crypto.randomBytes(16).toString('hex');
      const signed = signSession(sessionId);
      sessions.set(sessionId, { expiresAt: Date.now() + SESSION_TTL });
      res.writeHead(302, {
        'Set-Cookie': `webpanel_session=${signed}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`,
        'Location': '/'
      });
      res.end();
      log(`[登录成功] IP: ${clientIp}`);
    } else {
      log(`[登录失败] IP: ${clientIp}, 用户: ${username}`);
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getLoginPage('用户名或密码错误'));
    }
    return;
  }

  // ---- 登出接口 ----
  if (reqUrl === '/logout') {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = verifySession(cookies['webpanel_session']);
    if (sessionId) sessions.delete(sessionId);
    res.writeHead(302, {
      'Set-Cookie': 'webpanel_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
      'Location': '/'
    });
    res.end();
    return;
  }

  // ---- 以下接口均需认证 ----
  if (!requireAuth(req, res)) return;

  // ---- /terminal/* → 反向代理到 ttyd ----
  if (reqUrl.startsWith('/terminal')) {
    // Origin 校验
    if (!isValidOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    const originalUrl = reqUrl.replace(/^\/terminal/, '') || '/';
    req.url = originalUrl + (req.url.split('?')[1] ? '?' + req.url.split('?')[1] : '');
    proxy.web(req, res);
    return;
  }

  // ---- /api/status → 状态检查 ----
  if (reqUrl === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      port: PORT,
      ttyd: ttydProc && !ttydProc.killed,
      tunnel: tunnelProc && !tunnelProc.killed,
      tunnelTool: TUNNEL_TOOL
    }));
    return;
  }

  // ---- 其他 → 静态文件服务（管理面板）----
  let filePath;
  if (reqUrl === '/' || reqUrl === '') {
    filePath = path.join(__dirname, 'index.html');
  } else {
    filePath = path.join(__dirname, reqUrl);
  }

  // 防目录穿越
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(normalized, (err, stat) => {
    if (err || !stat.isFile()) {
      // 不返回 index.html 作为 fallback，避免泄露 SPA 路由
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    // 静态资源缓存 1 小时，HTML 不缓存
    const ext = path.extname(normalized).toLowerCase();
    const maxAge = ['.js', '.css', '.png', '.svg', '.ico'].includes(ext) ? 3600 : 0;
    sendFile(res, normalized, maxAge);
  });
});

// WebSocket 升级请求也代理到 ttyd
server.on('upgrade', (req, socket, head) => {
  // Origin 校验
  if (!isValidOrigin(req)) {
    socket.destroy();
    return;
  }
  // 会话校验
  const cookies = parseCookies(req.headers.cookie);
  if (!verifySession(cookies['webpanel_session'])) {
    socket.destroy();
    return;
  }
  if (req.url.startsWith('/terminal')) {
    req.url = req.url.replace(/^\/terminal/, '') || '/';
    proxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});

// ---------- 3. 启动 ttyd 子进程 ----------
function startTtyd() {
  log(`启动 ttyd 终端服务 → 端口 ${TTYD_PORT}，shell: ${TTYD_SHELL}`);
  // ttyd 启用 basic auth（内部认证，由 Node.js 代理自动注入 Authorization 头）
  const args = ['-p', String(TTYD_PORT), '-c', `${TTYD_USERNAME}:${TTYD_PASSWORD}`, TTYD_SHELL];
  try {
    ttydProc = spawn(TTYD_EXEC, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    ttydProc.stdout.on('data', (data) => process.stdout.write(`[ttyd] ${data}`));
    ttydProc.stderr.on('data', (data) => process.stderr.write(`[ttyd] ${data}`));
    ttydProc.on('close', (code) => {
      log(`ttyd 进程退出 (code=${code})`);
    });
    ttydProc.on('error', (err) => {
      log(`[ttyd 启动失败] 请检查 ttyd 可执行文件是否存在，或执行 npm install 后重试`);
    });
    childProcs.push(ttydProc);
  } catch (e) {
    log(`启动 ttyd 异常`);
  }
}

// ---------- 4. 启动内网穿透子进程 ----------
function startTunnel() {
  if (!TUNNEL_ENABLE) {
    log('内网穿透已禁用（TUNNEL_ENABLE=false）');
    return;
  }
  let cmd = null;
  let args = [];
  switch (TUNNEL_TOOL) {
    case 'chmlfrp':
      cmd = path.join(__dirname, process.platform === 'win32' ? 'chmlfrp.exe' : 'chmlfrp');
      const chmlConfig = path.join(__dirname, 'frpc.ini');
      const chmlToml = path.join(__dirname, 'frpc.toml');
      if (fs.existsSync(chmlConfig)) {
        log('检测到 frpc.ini，使用配置文件启动 chmlfrp');
        args = ['-c', chmlConfig];
      } else if (fs.existsSync(chmlToml)) {
        log('检测到 frpc.toml，使用配置文件启动 chmlfrp');
        args = ['-c', chmlToml];
      } else {
        log('❌ 未找到 chmlfrp 配置文件！请按以下步骤配置：');
        log('   1. 登录 https://panel.chmlfrp.net/ 创建隧道');
        log('   2. 从隧道配置页面下载/复制 frpc.ini 内容');
        log('   3. 将 frpc.ini 保存到项目根目录');
        log('   4. 重启 WebPanel 即可自动启动内网穿透');
        return;
      }
      break;
    case 'cpolar':
      cmd = path.join(__dirname, process.platform === 'win32' ? 'cpolar.exe' : 'cpolar');
      const cpolarConfig = path.join(__dirname, 'cpolar.yml');
      if (fs.existsSync(cpolarConfig)) {
        log('检测到 cpolar.yml，使用配置文件启动');
        args = ['http', String(PORT), '-config=' + cpolarConfig];
      } else {
        const authToken = process.env.CPOLAR_AUTH_TOKEN;
        if (authToken) {
          log('使用 CPOLAR_AUTH_TOKEN 启动 cpolar');
          args = ['http', String(PORT), '-authtoken=' + authToken];
        } else {
          log('未找到 cpolar.yml 和 CPOLAR_AUTH_TOKEN，使用默认配置启动');
          args = ['http', String(PORT)];
        }
      }
      break;
    case 'frp':
      cmd = path.join(__dirname, process.platform === 'win32' ? 'frpc.exe' : 'frpc');
      args = ['-c', path.join(__dirname, 'frpc.toml')];
      break;
    case 'ngrok':
      cmd = path.join(__dirname, process.platform === 'win32' ? 'ngrok.exe' : 'ngrok');
      args = ['http', String(PORT)];
      break;
    default:
      log(`未知的内网穿透工具: ${TUNNEL_TOOL}，跳过`);
      return;
  }
  log(`启动内网穿透 [${TUNNEL_TOOL}]`);
  try {
    tunnelProc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    tunnelProc.stdout.on('data', (data) => process.stdout.write(`[${TUNNEL_TOOL}] ${data}`));
    tunnelProc.stderr.on('data', (data) => process.stderr.write(`[${TUNNEL_TOOL}] ${data}`));
    tunnelProc.on('close', (code) => log(`${TUNNEL_TOOL} 进程退出 (code=${code})`));
    tunnelProc.on('error', (err) => log(`[${TUNNEL_TOOL} 启动失败]`));
    childProcs.push(tunnelProc);
  } catch (e) {
    log(`启动 ${TUNNEL_TOOL} 异常`);
  }
}

// ---------- 5. 优雅退出 ----------
function cleanup(signal) {
  log(`收到 ${signal}，正在关闭所有子进程...`);
  childProcs.forEach((p) => {
    try { if (p && !p.killed) p.kill('SIGTERM'); } catch (_) {}
  });
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));
process.on('exit', () => log('WebPanel 已退出'));

// ---------- 6. 启动主服务 ----------
function bootstrap() {
  log('====================================');
  log(`    WebPanel 正在启动...`);
  log('====================================');

  // 提示登录凭据（如果使用默认/随机密码）
  if (!process.env.ADMIN_PASSWORD) {
    log('');
    log('⚠️  未设置 ADMIN_PASSWORD，已自动生成随机密码：');
    log(`    用户名: ${ADMIN_USERNAME}`);
    log(`    密码:   ${ADMIN_PASSWORD}`);
    log('    建议在 .env 中设置 ADMIN_USERNAME 和 ADMIN_PASSWORD');
    log('');
  }

  startTtyd();
  startTunnel();
  server.listen(PORT, () => {
    log(`✅ 管理面板: http://localhost:${PORT}`);
    log(`✅ Web 终端: http://localhost:${PORT}/terminal/`);
    log(`✅ 状态检查: http://localhost:${PORT}/api/status`);
    log(`提示: 按 Ctrl+C 停止所有服务`);
  });
}

bootstrap();
