# Changelog

本文件由 WorkBuddy 接管系统在每个正式 Release 时自动生成。

分类：Added / Changed / Fixed / Improved / Breaking Changes

## [Unreleased]

### Added
- 仓库初始化：README、.gitignore、CHANGELOG、CI 工作流（由接管系统创建）
- 收录两个抖音分析 Skill：douyin-benchmark-analysis（对标分析）、douyin-topic-stats（选题清单与统计）
- 建立分支规范（main / feature/* / fix/* / refactor/* / chore/*）
- 建立 Conventional Commits 与 PR 规范

### Changed
- 移除仓库根目录的两个预打包压缩包（douyin-benchmark-analysis.zip / douyin-topic-stats.zip）；Skills 改为以源码目录形式提供，克隆仓库后取用对应 `<skill-name>/` 目录即可（不再维护 `.zip` 整包）
