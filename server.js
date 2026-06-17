// ============================================================
// WebPanel — Node.js 一体化服务（替代 Nginx）
// 功能：
//   1. 提供管理面板静态文件（index.html 等）
//   2. 反向代理 /terminal/ 到本地 ttyd（含 WebSocket）
//   3. 自动启动 ttyd 子进程
//   4. 可选启动内网穿透工具（cpolar / chmlfrp / frp / ngrok）
// 启动：npm install && npm start
// ============================================================

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const httpProxy = require('http-proxy');

// ---------- 读取配置 ----------
const PORT = parseInt(process.env.PORT) || 9999;
const TTYD_PORT = parseInt(process.env.TTYD_PORT) || 7681;
const TTYD_EXEC = process.env.TTYD_EXEC || path.join(__dirname, (process.platform === 'win32' ? 'ttyd.exe' : 'ttyd'));
const TTYD_SHELL = process.env.TTYD_SHELL || (process.platform === 'win32' ? 'cmd.exe' : 'bash');
const TUNNEL_TOOL = process.env.TUNNEL_TOOL || 'cpolar'; // cpolar | chmlfrp | frp | ngrok
const TUNNEL_ENABLE = process.env.TUNNEL_ENABLE !== 'false'; // 默认启用内网穿透

// ---------- 子进程引用 ----------
let ttydProc = null;
let tunnelProc = null;
const childProcs = [];

// 记录正在使用哪些子进程
function log(msg) {
  const time = new Date().toLocaleString();
  console.log(`[${time}] ${msg}`);
}

// ---------- 1. 创建反向代理（把 /terminal/* -> ttyd） ----------
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${TTYD_PORT}`,
  ws: true,
  changeOrigin: true
});

proxy.on('error', (err, req, res) => {
  log(`[代理错误] ${err.message}`);
  try {
    if (res && res.writeHead) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ttyd 尚未就绪，请稍后刷新页面重试');
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

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let reqUrl = decodeURIComponent(req.url.split('?')[0]);

  // ---- 2.1 /terminal/* → 反向代理到 ttyd ----
  if (reqUrl.startsWith('/terminal')) {
    const originalUrl = reqUrl.replace(/^\/terminal/, '') || '/';
    req.url = originalUrl + (req.url.split('?')[1] ? '?' + req.url.split('?')[1] : '');
    proxy.web(req, res);
    return;
  }

  // ---- 2.2 /api/status → 状态检查 ----
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

  // ---- 2.3 其他 → 静态文件服务（管理面板）----
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
      sendFile(res, path.join(__dirname, 'index.html'));
      return;
    }
    sendFile(res, normalized);
  });
});

// WebSocket 升级请求也代理到 ttyd
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/terminal')) {
    req.url = req.url.replace(/^\/terminal/, '') || '/';
    proxy.ws(req, socket, head);
  }
});

// ---------- 3. 启动 ttyd 子进程 ----------
function startTtyd() {
  log(`启动 ttyd 终端服务 → 端口 ${TTYD_PORT}，shell: ${TTYD_SHELL}`);
  const args = ['-p', String(TTYD_PORT), TTYD_SHELL];
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
      log(`[ttyd 启动失败] ${err.message} — 请检查 ttyd 可执行文件是否存在，或执行 npm install 后重试`);
    });
    childProcs.push(ttydProc);
  } catch (e) {
    log(`启动 ttyd 异常: ${e.message}`);
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
      // chmlfrp 使用标准 frp 客户端 (frpc)，支持 frpc.ini 和 frpc.toml 配置
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
        log('   3. 将 frpc.ini 保存到项目根目录（与 server.js 同目录）');
        log('   4. 重启 WebPanel 即可自动启动内网穿透');
        return;
      }
      break;
    case 'cpolar':
      cmd = path.join(__dirname, process.platform === 'win32' ? 'cpolar.exe' : 'cpolar');
      // cpolar 支持两种启动方式：
      // 1. 有 cpolar.yml 配置文件时使用配置文件
      // 2. 无配置时使用 authtoken（从环境变量 CPOLAR_AUTH_TOKEN 读取）
      const cpolarConfig = path.join(__dirname, 'cpolar.yml');
      if (fs.existsSync(cpolarConfig)) {
        log('检测到 cpolar.yml，使用配置文件启动');
        args = ['-c', cpolarConfig];
      } else {
        const authToken = process.env.CPOLAR_AUTH_TOKEN;
        if (authToken) {
          log('使用 CPOLAR_AUTH_TOKEN 启动 cpolar');
          args = ['authtoken', authToken, 'http', String(PORT)];
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
  log(`启动内网穿透 [${TUNNEL_TOOL}] → ${cmd} ${args.join(' ')}`);
  try {
    tunnelProc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    tunnelProc.stdout.on('data', (data) => process.stdout.write(`[${TUNNEL_TOOL}] ${data}`));
    tunnelProc.stderr.on('data', (data) => process.stderr.write(`[${TUNNEL_TOOL}] ${data}`));
    tunnelProc.on('close', (code) => log(`${TUNNEL_TOOL} 进程退出 (code=${code})`));
    tunnelProc.on('error', (err) => log(`[${TUNNEL_TOOL} 启动失败] ${err.message}`));
    childProcs.push(tunnelProc);
  } catch (e) {
    log(`启动 ${TUNNEL_TOOL} 异常: ${e.message}`);
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
