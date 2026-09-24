'use strict';

/**
 * check-env.js —— Skill 首次安装的运行环境自检 + 自动修依赖
 *
 * 用法: node scripts/check-env.js            （在本 Skill 根目录执行）
 *   或: node <skill>/scripts/check-env.js    （任意位置执行均可）
 *
 * 检查并尽量自动修复（90 于 2026-09-23 要求：首次安装先检查环境，不支持先解决依赖）：
 *   1. Node 版本        —— 需 >= 18（playwright 1.49 的要求）。不满足则给出安装指引后退出
 *   2. npm 可用性
 *   3. 采集器依赖       —— node_modules 缺失/损坏时自动 npm install（npmmirror 源，失败回退官方源）
 *   4. 浏览器           —— 依次找 Edge / Chrome（Windows/macOS/Linux 常见路径）；
 *                          全都没有时自动执行 playwright install chromium（约 130MB，需网络）
 *   5. 显示环境         —— Linux 无 DISPLAY/WAYLAND 时提示用 --headless
 *   6. 登录态           —— 报告 browser-profile 是否存在（只提示，不自动登录）
 *
 * 退出码：0 = 就绪；1 = 存在无法自动修复的阻塞项
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SKILL_ROOT = path.resolve(__dirname, '..');
const COLLECTOR_DIR = path.join(SKILL_ROOT, 'scripts', 'collector');

const ok = [];
const fixed = [];
const blockers = [];
const tips = [];

const line = (s) => console.log(s);
const mark = (good) => (good ? '✓' : '✗');

function run(cmd, args, opts = {}) {
  // Windows 下 spawnSync 不会自动解析 .cmd（Node 20+ 的安全变更），必须显式 shell
  const needShell = process.platform === 'win32' && /\.cmd$/i.test(cmd);
  const r = spawnSync(cmd, args, {
    stdio: opts.inherit ? 'inherit' : 'pipe',
    encoding: 'utf8',
    cwd: opts.cwd || COLLECTOR_DIR,
    shell: needShell || !!opts.shell,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ---------- 1. Node 版本 ----------
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 18) {
  ok.push(`Node ${process.versions.node}`);
} else {
  blockers.push(
    `Node 版本过低（当前 ${process.versions.node}，需 >= 18）。请到 https://nodejs.org 安装 LTS 版本后重试。`
  );
}

// ---------- 2. npm ----------
// npm 不一定在 PATH 上（例如只在 bash profile 里）。最稳的是用 Node 自带的 npm-cli.js：
//   <node 所在目录>/node_modules/npm/bin/npm-cli.js
const npmCli = (() => {
  const cands = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'.replace(/\//g, path.sep)),
  ];
  for (const p of cands) if (fs.existsSync(p)) return p;
  return null;
})();
let npmRun = null; // (args, inherit) => {code}
if (npmCli) {
  ok.push(`npm（经 npm-cli.js 调用: ${npmCli}）`);
  npmRun = (args, inherit) => run(process.execPath, [npmCli, ...args], { inherit });
} else {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmCheck = run(npmCmd, ['--version'], { shell: true });
  if (npmCheck.code === 0) {
    ok.push(`npm ${npmCheck.out.trim().split('\n')[0]}`);
    npmRun = (args, inherit) => run(npmCmd, args, { inherit, shell: process.platform === 'win32' });
  } else {
    blockers.push('npm 不可用（通常随 Node 一起安装，请先安装 Node LTS，安装时勾选“Add to PATH”）。');
  }
}

// ---------- 3. 采集器依赖（可自动修复） ----------
const pwPkg = path.join(COLLECTOR_DIR, 'node_modules', 'playwright', 'package.json');
let pwOk = false;
try {
  pwOk = !!require(pwPkg).version;
} catch {
  pwOk = false;
}
if (pwOk) {
  ok.push('playwright 依赖（随 Skill 自带）');
} else if (npmRun) {
  line('  → playwright 依赖缺失，自动安装中（npmmirror 源）…');
  let r = npmRun(['install', '--no-audit', '--no-fund', '--registry=https://registry.npmmirror.com'], true);
  if (r.code !== 0) {
    line('  → npmmirror 源失败，回退官方源…');
    r = npmRun(['install', '--no-audit', '--no-fund'], true);
  }
  try {
    pwOk = !!require(pwPkg).version;
  } catch {
    pwOk = false;
  }
  if (pwOk) fixed.push('playwright 依赖（已自动 npm install）');
  else blockers.push('playwright 依赖安装失败，请手动在 scripts/collector/ 下执行 npm install。');
}

// ---------- 4. 浏览器（可自动修复） ----------
const browserCandidates =
  process.platform === 'win32'
    ? [
        ['Edge', process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
        ['Edge', process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
        ['Chrome', process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')],
        ['Chrome', process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')],
      ]
    : process.platform === 'darwin'
      ? [
          ['Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
          ['Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
        ]
      : [
          ['Edge', '/usr/bin/microsoft-edge'],
          ['Edge', '/usr/bin/microsoft-edge-stable'],
          ['Chrome', '/usr/bin/google-chrome'],
          ['Chrome', '/usr/bin/google-chrome-stable'],
          ['Chromium', '/usr/bin/chromium'],
          ['Chromium', '/usr/bin/chromium-browser'],
        ];

let foundBrowser = null;
for (const [name, p] of browserCandidates) {
  if (p && fs.existsSync(p)) {
    foundBrowser = `${name}（${p}）`;
    break;
  }
}
if (!foundBrowser) {
  // PATH 里再找一轮（Linux 常见）
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const bin of ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']) {
      const p = path.join(dir, bin);
      if (fs.existsSync(p)) {
        foundBrowser = `${bin}（${p}）`;
        break;
      }
    }
    if (foundBrowser) break;
  }
}

// playwright 自带的 chromium（缓存目录）
const pwCacheRoot =
  process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright');
const hasPwChromium = fs.existsSync(pwCacheRoot) &&
  fs.readdirSync(pwCacheRoot).some((d) => d.startsWith('chromium-'));

if (foundBrowser || hasPwChromium) {
  ok.push(foundBrowser ? `浏览器：${foundBrowser}` : '浏览器：playwright 内置 Chromium（已下载）');
} else {
  line('  → 未找到 Edge / Chrome，自动下载 playwright 内置 Chromium（约 130MB，需网络）…');
  const cli = path.join(COLLECTOR_DIR, 'node_modules', 'playwright', 'cli.js');
  const r = run(process.execPath, [cli, 'install', 'chromium'], { inherit: true });
  const nowHas = fs.existsSync(pwCacheRoot) && fs.readdirSync(pwCacheRoot).some((d) => d.startsWith('chromium-'));
  if (r.code === 0 && nowHas) fixed.push('浏览器（已自动下载 playwright Chromium）');
  else blockers.push('未找到可用浏览器，且 Chromium 自动下载失败。请安装 Edge 或 Chrome 后重试。');
}

// ---------- 5. 显示环境（仅提示） ----------
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  tips.push('当前是无图形环境（无 DISPLAY）。采集时必须加 --headless 参数，且更容易触发风控；建议在有桌面的机器上运行。');
}

// ---------- 6. 登录态（仅提示） ----------
const profileDir = process.env.DC_HOME
  ? path.join(process.env.DC_HOME, 'browser-profile')
  : path.join(COLLECTOR_DIR, 'browser-profile');
const hasProfile = fs.existsSync(path.join(profileDir, 'Default')) || fs.existsSync(profileDir) && fs.readdirSync(profileDir).length > 0;
if (hasProfile) ok.push(`登录态 profile 已存在（${profileDir}）`);
else tips.push(`尚无登录态（首次采集前执行: node collector.js --login，数据目录由 DC_HOME 指定）`);

// ---------- 输出 ----------
line('');
line('================ 环境自检结果 ================');
for (const o of ok) line(`  ${mark(true)} ${o}`);
for (const f of fixed) line(`  ${mark(true)} ${f}  [已自动修复]`);
for (const t of tips) line(`  ⚠ ${t}`);
for (const b of blockers) line(`  ${mark(false)} ${b}`);
line('=============================================');

if (blockers.length) {
  line(`\n结论：存在 ${blockers.length} 项阻塞，请先按上方提示解决。`);
  process.exit(1);
}
line('\n结论：环境就绪，可以开始采集。下一步见 SKILL.md「环境准备」。');
process.exit(0);
