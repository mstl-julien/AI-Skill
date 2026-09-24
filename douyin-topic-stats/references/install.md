# 安装指南（跨平台）

> 首次安装只需三步：① 装 Node LTS → ② 把本 Skill 目录放进 skills 目录 → ③ 跑一次环境自检。
> 环境自检（`node scripts/check-env.js`）会自动补齐其余依赖，本页只在自动修复失败时用。

## 1. 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 18**（推荐 20/22 LTS） | 下载: https://nodejs.org —— Windows 安装时勾选「Add to PATH」 |
| npm | 随 Node 一起装 | 自检脚本会优先用 Node 自带的 npm-cli.js，不依赖 PATH |
| 浏览器 | Edge 或 Chrome 任一 | Windows 10/11 与 macOS 自带 Edge；Linux 见下。都没有时自检脚本会自动下载 Chromium |
| 磁盘 | ≥ 1 GB | Skill 本体 + 浏览器 + 登录态 profile（约 600MB） |
| 网络 | 能访问 douyin.com | 采集为被动监听真实浏览器请求，需正常访问抖音网页版 |

## 2. 安装 Skill

- **WorkBuddy 用户**：把 `douyin-topic-stats` 整个目录放进 `~/.workbuddy/skills/`（全局）或
  `<工作区>/.workbuddy/skills/`（工作空间），重启会话即可被识别。
- **手动使用**：目录放哪都行，直接按 SKILL.md 的命令运行。

## 3. 环境自检（自动修依赖）

```bash
node scripts/check-env.js
```

自动处理清单：
- playwright 依赖缺失 → 自动 `npm install`（npmmirror 源，失败回退官方源）
- 找不到 Edge / Chrome → 自动 `playwright install chromium`（约 130MB）
- 无图形环境（Linux 服务器）→ 提示采集时加 `--headless`

## 4. 手动排障（自动修复失败时）

### Windows
- Node 安装后 CMD 里 `node -v` 无效 → 重开终端；仍无效则检查系统 PATH 里有
  `C:\Program Files\nodejs\`
- 手动装依赖：`cd <skill>/scripts/collector && npm install --registry=https://registry.npmmirror.com`
- Edge 下载: https://www.microsoft.com/edge/download

### macOS
- Node: `brew install node` 或官网 pkg
- Edge 自带；无 Edge 无 Chrome 时脚本会自动下载 Chromium
- 首次运行若提示"无法打开应用"：系统设置 → 隐私与安全性 → 允许

### Linux（含无桌面服务器）
- Node: `apt install nodejs npm` 或 nvm
- 浏览器依赖库：`npx playwright install-deps chromium`（需要 sudo），
  或直接 `npx playwright install chromium`
- 无桌面环境必须用 `--headless` 运行采集（自检脚本会提示）；无头模式风控更严，建议本地有桌面机器采集

## 5. 登录与数据目录

- 数据目录由环境变量 `DC_HOME` 指定（建议放在任务目录下）：
  - bash: `export DC_HOME="<工作目录>/douyin-data"`
  - Windows CMD: `set DC_HOME=<工作目录>\douyin-data`
  - PowerShell: `$env:DC_HOME="<工作目录>\douyin-data"`
- 首次采集会自动弹出扫码窗口，登录确认后才开始采（访客态不放行）
- `$DC_HOME/browser-profile/` 存登录 Cookie（约 600MB），**勿提交仓库、勿外传**

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| 采集时弹出验证码 | 立即停止，换时段再试；不要并发、不要多开 |
| 作品只采到首页 | 检查是否真的登录（自检第 6 项）；访客态必被限流 |
| 评论只采到几条 | 带 `DEBUG_COMMENTS=1` 重跑看逐轮打点；确认接口请求数是否在正常区间 |
| Linux 启动浏览器失败 | `npx playwright install-deps chromium` 补系统库 |
