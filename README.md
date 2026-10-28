# 🧩 插件库

OpenClaw / dsh 插件集合。每个插件是一个独立的 npm package，放在 `plugins/<name>/` 下。

## 安装

### 方式一：直接装单个插件（最推荐）

```bash
# dsh — 从 GitHub 子目录直接加
dsh plugin --profile web add github:FGOEVA/plugins#plugins/dsh-memory

# OpenClaw — 用 npx 或 cd + dsh-memory 路径
cd ~/.openclaw/workspace && cp -r ./projects/dsh-memory ./plugins-dsh-memory
```

### 方式二：clone 后用本地路径

```bash
git clone https://github.com/FGOEVA/plugins.git ~/.local/share/plugins
# 然后用 file: 路径装
dsh plugin --profile web add file:~/.local/share/plugins/plugins/dsh-memory
```

### 方式三：npm publish 后直接 `npm i`

等我把插件发布到 npm 上后，就可以 `npm i @fgoeva/dsh-memory`。

---

## 可用插件

| 插件 | 说明 | 安装地址 |
|------|------|---------|
| [**dsh-memory**](plugins/dsh-memory/) | MCP 记忆服务器 + 梦境整理。零外部依赖，FTS5 + bigram 中文检索。 | `github:FGOEVA/plugins#plugins/dsh-memory` |

<!-- 后续新插件按此格式追加 -->

---

## 开发规范

- 每个插件是独立 npm package（有 `package.json`）
- 入口文件写 bin 字段，让 `node <pkg>` 可直接运行
- README 写在各自目录下
- 只用 Node.js 内置模块（`node:*`），不引入额外运行时依赖
- 需要编译时用 esbuild / rollup 打包成单文件；不强制编译的话保持 ESM + shebang
