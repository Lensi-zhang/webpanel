#!/usr/bin/env node
// ============================================================
// WebPanel 自动下载依赖二进制（ttyd、cpolar）
// cpolar 从官方下载页获取链接并下载
// 由 npm postinstall 自动调用，也可以手动运行
// 用法: node bin/setup-binaries.js
// ============================================================

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

// ---------- 项目根目录 ----------
const ROOT = path.resolve(__dirname, '..');
const LOG = (...args) => console.log(`[setup]`, ...args);
const WARN = (...args) => console.warn(`[setup] ⚠️`, ...args);
const ERR = (...args) => console.error(`[setup] ❌`, ...args);

// ---------- 检测系统 ----------
function getPlatform() {
  const p = process.platform;
  const arch = process.arch;
  if (p === 'win32') {
    // Windows: x64 → amd64, arm64 → arm64
    const winArch = arch === 'x64' ? 'amd64' : (arch === 'arm64' ? 'arm64' : '386');
    return { os: 'windows', arch: winArch, ext: '.exe' };
  }
  if (p === 'darwin') return { os: 'macos', arch: arch === 'arm64' ? 'arm64' : 'amd64', ext: '' };
  if (p === 'linux') return { os: 'linux', arch: arch === 'arm64' ? 'arm64' : (arch === 'x64' ? 'amd64' : 'amd64'), ext: '' };
  return null;
}

// ---------- HTTP/HTTPS 下载（支持重定向） ----------
function downloadFile(url, destPath, label) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath)) {
      LOG(`✅ ${label} 已存在，跳过下载`);
      return resolve();
    }

    LOG(`📥 正在下载 ${label}: ${url}`);
    const file = fs.createWriteStream(destPath);
    let total = 0;

    function doDownload(fullUrl) {
      const protocol = fullUrl.startsWith('https') ? https : http;
      protocol.get(fullUrl, { headers: { 'User-Agent': 'WebPanel/1.0', 'Accept': '*/*' } }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          const redirectUrl = res.headers.location;
          LOG(`🔀 重定向到: ${redirectUrl.substring(0, 60)}...`);
          return doDownload(redirectUrl);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const totalSize = parseInt(res.headers['content-length'], 10);
        res.on('data', (chunk) => {
          total += chunk.length;
          if (totalSize) {
            const pct = ((total / totalSize) * 100).toFixed(1);
            process.stdout.write(`\r    下载进度: ${pct}% (${(total / 1024 / 1024).toFixed(2)}MB)`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          process.stdout.write('\n');
          resolve();
        });
      }).on('error', reject);
    }

    doDownload(url);
  });
}

// ---------- 设置可执行权限 ----------
function makeExecutable(filePath) {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(filePath, 0o755);
    LOG(`🔧 已设置可执行权限: ${filePath}`);
  } catch (e) {
    WARN(`无法设置可执行权限: ${e.message}`);
  }
}

// ---------- 获取 GitHub latest release 版本号 ----------
function getLatestVersion(repo) {
  return new Promise((resolve) => {
    LOG(`正在查询 ${repo} 最新版本...`);
    https.get(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'WebPanel/1.0' }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const version = json.tag_name?.replace(/^v/, '') || null;
          if (version) {
            LOG(`   最新版本: v${version}`);
            resolve(version);
          } else {
            resolve(null);
          }
        } catch (_) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

// ---------- 解压函数 ----------
function extractArchive(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(archivePath).toLowerCase();
    LOG(`📦 正在解压: ${archivePath}`);

    try {
      if (ext === '.zip') {
        // Windows: 使用 PowerShell Expand-Archive
        if (process.platform === 'win32') {
          execSync(`powershell -Command "Expand-Archive -Force -LiteralPath '${archivePath}' -DestinationPath '${destDir}'"`, { stdio: 'pipe' });
        } else {
          // macOS/Linux: 使用 unzip
          execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'pipe' });
        }
      } else if (ext === '.gz' || archivePath.endsWith('.tar.gz')) {
        // tar.gz: 使用 tar
        execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'pipe' });
      } else {
        return reject(new Error(`不支持的压缩格式: ${ext}`));
      }
      LOG(`   ✅ 解压完成`);
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

// ---------- 在目录中查找 cpolar 二进制 ----------
function findCpolarInDir(dir) {
  const plat = getPlatform();
  const targetName = plat.os === 'windows' ? 'cpolar.exe' : 'cpolar';

  function walk(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const found = walk(fullPath);
        if (found) return found;
      } else if (entry.name === targetName) {
        return fullPath;
      }
    }
    return null;
  }

  return walk(dir);
}

// ---------- 下载 ttyd ----------
async function downloadTtyd() {
  const plat = getPlatform();
  if (!plat) { WARN('不支持的平台，跳过 ttyd'); return; }

  const version = await getLatestVersion('tsl0922/ttyd') || '1.7.7';

  // ttyd 发布文件名格式因版本而异
  // 新版本 (1.10.0+): ttyd.x86_64, ttyd.aarch64 等
  // 旧版本 (1.7.x): ttyd.win32.exe, ttyd.x86_64 等
  let filename;
  let dest = path.join(ROOT, plat.os === 'windows' ? 'ttyd.exe' : 'ttyd');

  if (plat.os === 'windows') {
    // Windows: ttyd.win32.exe 是 Windows 版本（32位，可用于64位系统）
    // 注意: ttyd 官方 release 没有专门的 arm64 Windows 版本
    filename = 'ttyd.win32.exe';
    dest = path.join(ROOT, 'ttyd.exe');
  } else if (plat.os === 'macos') {
    // macOS: ttyd.x86_64 或 ttyd.aarch64
    filename = plat.arch === 'arm64' ? 'ttyd.aarch64' : 'ttyd.x86_64';
  } else {
    // Linux: ttyd.x86_64 或 ttyd.aarch64
    filename = plat.arch === 'amd64' ? 'ttyd.x86_64' : (plat.arch === 'arm64' ? 'ttyd.aarch64' : 'ttyd.x86_64');
  }

  const url = `https://github.com/tsl0922/ttyd/releases/download/${version}/${filename}`;

  await downloadFile(url, dest, `ttyd v${version}`);
  if (plat.os !== 'windows') makeExecutable(dest);
}

// ---------- 下载 cpolar ----------
async function downloadCpolar() {
  const plat = getPlatform();
  if (!plat) { WARN('不支持的平台，跳过 cpolar'); return; }

  const cpolarName = plat.os === 'windows' ? 'cpolar.exe' : 'cpolar';
  const cpolarDest = path.join(ROOT, cpolarName);

  if (fs.existsSync(cpolarDest)) {
    LOG(`✅ cpolar 已存在，跳过下载`);
    return;
  }

  const tmpDir = path.join(os.tmpdir(), `webpanel-cpolar-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // cpolar 下载链接格式（来源: https://www.cpolar.com/download）
  // cpolar-stable-{os}-{arch}.zip（所有平台均为 zip）
  const cpolarVersion = '3.3.12';
  const osName = plat.os === 'windows' ? 'windows' : plat.os === 'macos' ? 'darwin' : 'linux';
  const cpolarFilename = `cpolar-stable-${osName}-${plat.arch}.zip`;
  const cpolarUrl = `https://www.cpolar.com/static/downloads/releases/${cpolarVersion}/${cpolarFilename}`;
  const cpolarArchivePath = path.join(tmpDir, cpolarFilename);

  LOG(`📥 正在下载 cpolar v${cpolarVersion}...`);

  try {
    await downloadFile(cpolarUrl, cpolarArchivePath, `cpolar v${cpolarVersion}`);
    await extractArchive(cpolarArchivePath, tmpDir);

    const cpolarPath = findCpolarInDir(tmpDir);
    if (!cpolarPath) {
      throw new Error('在解压后的文件中未找到 cpolar');
    }

    LOG(`   找到 cpolar: ${cpolarPath}`);
    fs.copyFileSync(cpolarPath, cpolarDest);
    if (plat.os !== 'windows') makeExecutable(cpolarDest);
    LOG(`✅ cpolar 已安装: ${cpolarDest}`);
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    LOG('');
    LOG('============================================================');
    LOG('  ❌ 自动下载 cpolar 失败，请手动下载：');
    LOG('     1. 访问 https://www.cpolar.com/download');
    LOG(`     2. 下载 ${osName} ${plat.arch} 版本`);
    LOG(`     3. 解压后将 cpolar（或 cpolar.exe）放到项目根目录: ${ROOT}`);
    LOG(`     下载直链: ${cpolarUrl}`);
    LOG('============================================================');
    LOG('');
    throw new Error('cpolar 自动下载失败，请按上方说明手动安装');
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

// ---------- 主流程 ----------
async function main() {
  const plat = getPlatform();
  LOG('======================================');
  LOG('  WebPanel 依赖下载工具');
  LOG(`  平台: ${plat ? plat.os + '/' + plat.arch : '未知'}`);
  LOG('======================================');

  try {
    await downloadTtyd();
    await downloadCpolar();

    LOG('');
    LOG('======================================');
    LOG('  ✅ 所有依赖下载完成！');
    LOG('  现在可以运行: npm start');
    LOG('======================================');
  } catch (e) {
    ERR('下载失败:', e.message);
    ERR('你可以手动下载以下文件放到项目根目录:');
    ERR('  - ttyd: https://github.com/tsl0922/ttyd/releases');
    ERR('  - cpolar: https://www.cpolar.com/download');
    process.exit(1);
  }
}

main();
