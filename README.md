# AI-Skill

AI Agent 能力模块（Skill）集合仓库。

本仓库由 **WorkBuddy GitHub 全自动接管系统 V1.0** 初始化并接管维护。

## 用途

集中存放可复用的 AI Agent Skill：每个 Skill 一个独立目录，包含 `SKILL.md`（能力说明）及配套脚本、模板、资源。

## 已收录 Skills

| 目录 | Skill | 用途 |
|------|-------|------|
| `douyin-benchmark-analysis/` | 抖音对标账号采集与对标分析 | 采集对标账号公开展示信息 + 六节对标报告 + 可迁移选题清单（含评论区洞察） |
| `douyin-topic-stats/` | 抖音选题清单与数据统计 | 快速盘点账号最近 N 条视频选题 + 四项互动数据，产出可排序 HTML（不采评论） |

> 每个 Skill 目录相互独立、自包含。首次使用前请按各自 `SKILL.md` 的「环境准备」运行 `node scripts/check-env.js` 自动装依赖（playwright 等，`node_modules` 已按仓库 `.gitignore` 忽略，不入库）。

## 目录结构

```
<skill-name>/
  SKILL.md          # Skill 定义（必填）
  scripts/          # 可选：执行脚本
  references/       # 可选：参考资料
  assets/           # 可选：资源文件
.github/
  workflows/        # CI 流水线
README.md
CHANGELOG.md
.gitignore
```

## 分支规范

| 类型 | 前缀 |
|------|------|
| 功能 | `feature/*` |
| 修复 | `fix/*` |
| 重构 | `refactor/*` |
| 维护 | `chore/*` |

主分支为 `main`，禁止直接在 `main` 上进行普通开发。

## 提交规范（Conventional Commits）

`feat:` `fix:` `refactor:` `docs:` `test:` `chore:` `perf:` `build:` `ci:`

## PR 规范

- 标题：`[feature] xxx` / `[fix] xxx` / `[refactor] xxx`
- 内容需包含：Changes / Validation / Risk / Files

## 维护分工

- **WorkBuddy 接管**：Git、GitHub、CI、Release、日常维护。
- **用户保留最终确认权**：删除仓库、force push main、删除 main、重写历史、修改可见性、泄露 Secret、删除 Actions、修改核心权限等高风险操作一律先 STOP 确认。
