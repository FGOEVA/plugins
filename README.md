# 🧩 FGOEVA 插件合集 — Monorepo

OpenClaw / DSH 插件合集。**一个大仓**，按功能分类，每个插件在独立子目录里。

## 安装方式

```bash
# DSH — 从 GitHub 子路径安装（语法：github:user/repo#plugins/<分类>/<插件名>）
cd ~/.dsh
dsh plugin --profile web add github:FGOEVA/plugins#plugins/memory/dsh-memory
```

然后编辑 `~/.dsh/web/cordis.patch.yml` 注入配置（见各插件 README）。

## 可用插件

| 分类 | 插件 | 说明 | 安装路径 |
|------|------|------|---------|
| `memory` | [dsh-memory](https://github.com/FGOEVA/plugins/tree/main/plugins/memory/dsh-memory) | MCP 记忆服务器 + 梦境整理，零外部依赖 | `github:FGOEVA/plugins#plugins/memory/dsh-memory` |

<!-- 新插件格式：复制下方行，改分类/名称/描述 -->
<!-- | `分类` | [名称](链接) | 说明 | `github:FGOEVA/plugins#plugins/分类/插件名` | -->

## 本地开发

本仓是 monorepo，用 pnpm/npm workspaces 管理：

```bash
git clone https://github.com/FGOEVA/plugins.git
cd plugins
pnpm install          # 或 npm install
# 各插件源码在 plugins/<分类>/<插件名>/ 下
```

## 添加新插件

1. 在 `plugins/<分类>/<插件名>/` 下创建插件
2. 每个插件必须有：
   - `package.json`（含 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`）
   - `src/` 或根目录的 JS/MJS 主入口
   - `README.md`
3. 更新本文档的表格
