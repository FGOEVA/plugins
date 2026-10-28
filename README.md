# 🧩 插件库

OpenClaw / dsh 插件集合。**每个插件是独立的 GitHub 仓库**，可直接通过地址安装。

## 可用插件

| 插件 | 安装地址 | 说明 |
|------|---------|------|
| [**dsh-memory**](https://github.com/FGOEVA/dsh-memory) | `github:FGOEVA/dsh-memory` | MCP 记忆服务器 + 梦境整理，零外部依赖 |

<!-- 新插件：复制对应仓库地址到上方表格即可 -->

## 安装示例

```bash
# dsh — 从 GitHub 直接加
cd ~/.dsh
dsh plugin --profile web add github:FGOEVA/dsh-memory
```

然后编辑 `~/.dsh/web/cordis.patch.yml` 注入配置（见各插件 README）。
