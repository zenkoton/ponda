# ponda

基于 [pi coding agent](https://github.com/earendil-works/pi)（本仓库为其 fork）的环境管理与长时任务运行时。

- 设计文档：`docs/design/`（从 [README](docs/design/README.md) 进入）
- 需求原文：`docs/requirements.md`
- fork 补丁区域登记：[PATCHES.md](PATCHES.md)

## 快速开始

```bash
# 1) 构建 monorepo（含上游 pi，约 3-5 分钟；此后可跳过）
npm install && npm run build

# 2) ponda CLI（Node ≥ 22 原生 TS 执行）
node packages/cli/src/bin.ts init              # default 环境 + shell 集成（--print 预览）
node packages/cli/src/bin.ts env create web-dev --base default
node packages/cli/src/bin.ts env activate web-dev
node packages/cli/src/bin.ts env list

# 3) 以当前环境运行真正的 pi（透传，agent dir = 环境目录）
node packages/cli/src/bin.ts pi --version
node packages/cli/src/bin.ts pi                 # 交互 TUI

# 4) 资源管理 / 免切换操作
node packages/cli/src/bin.ts skills add <本地skill目录> <name>
node packages/cli/src/bin.ts web-dev skills list   # 不切环境直接查

# 5) 测试（node:test，零额外依赖）
for p in core cli sandbox metrics; do (cd packages/$p && node --test test/*.test.ts); done
```

`PONDA_HOME` 环境变量可覆盖 `~/.ponda` 根目录（测试与多实例隔离用）。

## 里程碑

见 `docs/design/09-roadmap.md`（含实施进度标记）。当前：M0-M2 完成，M3/M7/M10 核心完成。
