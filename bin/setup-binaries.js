#!/usr/bin/env node
// ============================================================
// WebPanel 自动下载依赖二进制（ttyd、chmlfrp）
// 由 npm postinstall 自动调用，也可以手动运行
// 用法: node bin/setup-binaries.js
// ============================================================

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ---------- 项目根目录 ----------
const ROOT = path.resolve(__dirname, '..');
const LOG = (...args) => console.log(`[setup]`, ...args);
const WARN = (...args) => console.warn(`[setup] ⚠️`, ...args);
const ERR = (...args) => console.error(`[setup] ❌`, ...args);

// ---------- 检测系统 ----------
function getPlatform() {
  const p = process.platform;
  const arch = process.arch;
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  return null;
}

// ---------- 获取最新 ttyd 版本号 ----------
function getLatestTtydVersion() {
  return new Promise((resolve) => {
    LOG('正在查询 ttyd 最新版本...');
    https.get('https://api.github.com/repos/tsl0922/ttyd/releases/latest', {
      headers: { 'User-Agent': 'WebPanel/1.0' }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.tag_name?.replace('v', '') || '1.7.3');
        } catch (_) {
          resolve('1.7.3'); // fallback
        }
      });
    }).on('error', () => resolve('1.7.3'));
  });
}

// ---------- 下载文件 ----------
function downloadFile(url, destPath, label) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath)) {
      LOG(`✅ ${label} 已存在，跳过下载: ${destPath}`);
      return resolve();
    }

    LOG(`📥 正在下载 ${label}: ${url}`);
    const file = fs.createWriteStream(destPath);
    let total = 0;

    https.get(url, { headers: { 'User-Agent': 'WebPanel/1.0' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const redirectUrl = res.headers.location;
        LOG(`🔀 重定向到: ${redirectUrl}`);
        https.get(redirectUrl, { headers: { 'User-Agent': 'WebPanel/1.0' } }, (res2) => {
          downloadStream(res2);
        }).on('error', reject);
        return;
      }
      downloadStream(res);
    }).on('error', reject);

    function downloadStream(res) {
      const totalSize = parseInt(res.headers['content-length'], 10);
      res.on('data', (chunk) => {
        total += chunk.length;
        if (totalSize) {
          const pct = ((total / totalSize) * 100).toFixed(1);
          process.stdout.write(`\r    下载进度: ${pct}%`);
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        process.stdout.write('\n');
        resolve();
      });
    }
  });
}

// ---------- 设置可执行权限 ----------
function makeExecutable(filePath) {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(filePath, 0o755);
    LOG(`🔧 已设置可执行权限: ${filePath}`);
  } catch (e) {
    WARN(`无法设置可执行权限（可能需要 sudo）: ${e.message}`);
  }
}

// ---------- 下载 ttyd ----------
async function downloadTtyd() {
  const version = await getLatestTtydVersion();
  const plat = getPlatform();

  const filenameMap = {
    windows: `ttyd_${version}_windows_x86_64.exe`,
    macos: `ttyd_${version}_macos_x86_64`,
    linux: `ttyd_${version}_linux_x86_64`,
  };
  const filename = filenameMap[plat];

  if (!filename) {
    WARN(`不支持的平台: ${process.platform}，请手动下载 ttyd`);
    return;
  }

  const url = `https://github.com/tsl0922/ttyd/releases/download/${version}/${filename}`;
  const dest = path.join(ROOT, plat === 'windows' ? 'ttyd.exe' : 'ttyd');

  await downloadFile(url, dest, `ttyd ${version}`);
  if (plat !== 'windows') makeExecutable(dest);
}

// ---------- 下载 chmlfrp ----------
async function downloadChmlfrp() {
  const plat = getPlatform();

  const filenameMap = {
    windows: 'chmlfrp.exe',
    macos: 'chmlfrp',
    linux: 'chmlfrp',
  };
  const filename = filenameMap[plat];
  const dest = path.join(ROOT, filename);

  if (fs.existsSync(dest)) {
    LOG(`✅ chmlfrp 已存在，跳过下载: ${dest}`);
    return;
  }

  // chmlfrp 的下载地址需要从官网获取，这里用已知的最新的 CDN URL
  const urlMap = {
    windows: 'https://cdn.chmlfrp.cn/chmlfrp/windows/chmlfrp.exe',
    macos: 'https://cdn.chmlfrp.cn/chmlfrp/macos/chmlfrp',
    linux: 'https://cdn.chmlfrp.cn/chmlfrp/linux/chmlfrp',
  };

  const url = urlMap[plat];
  if (!url) {
    WARN(`不支持的平台: ${process.platform}，请手动下载 chmlfrp`);
    return;
  }

  await downloadFile(url, dest, 'chmlfrp');
  if (plat !== 'windows') makeExecutable(dest);
}

// ---------- 主流程 ----------
async function main() {
  LOG('======================================');
  LOG('  WebPanel 依赖下载工具');
  LOG('  平台:', process.platform, '/', process.arch);
  LOG('======================================');

  try {
    await downloadTtyd();
    await downloadChmlfrp();

    LOG('');
    LOG('======================================');
    LOG('  ✅ 所有依赖下载完成！');
    LOG('  现在可以运行: npm start');
    LOG('======================================');
  } catch (e) {
    ERR('下载失败:', e.message);
    ERR('你可以手动下载以下文件放到项目根目录:');
    ERR('  - ttyd: https://github.com/tsl0922/ttyd/releases');
    ERR('  - chmlfrp: https://www.chmlfrp.cn');
    process.exit(1);
  }
}

main();
