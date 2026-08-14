# dsh-doctor

> **崩溃报错，无法启动，请用：[dsh-doctor](https://github.com/jorinyang/dsh-doctor)**

[![license](https://badgen.net/badge/license/MIT/green)](LICENSE) [![topic](https://badgen.net/badge/topic/dsh-plugin/8257D0)](https://github.com/topics/dsh-plugin)

English docs: [README.md](./README.md)。

---

## 两行命令接住你的情绪，解决你崩溃的源头

```sh
# 安装
dsh plugin --profile web add @jorinyang/dsh-doctor

# 修复
dsh-doctor
```

自带 CLI，安装自动注册到系统 PATH，直接执行即可。修复全程可回滚。

**无痛折腾 DeepSeek Harness**

---

## 为什么需要它

DeepSeek Harness 没有内置 `doctor` 命令。当 DSH 崩溃、无法启动、或某个插件破坏了 profile 时，没有一条命令能告诉你问题出在哪并修复它。

`dsh-doctor` 用三个工具 + 一个运行时服务填补这个空缺：

- **`dsh_doctor`** — 只读诊断。绝不改动任何东西，只报告哪里坏了、为什么。
- **`dsh_doctor_fix`** — 按风险分级修复，每个可逆改动都记录 undo 步骤（journaled）。
- **`dsh_doctor_rollback`** — 撤销一次修复（LIFO 逆序回滚），恢复到修复前状态。
- **`dsh-doctor` 运行时服务** — 在 DSH 存活时提供诊断/修复/回滚 API，并响应式监控插件生命周期。

## 安装

### 作为 DSH 插件（Agent 内使用）

```sh
# 从 npm 安装
dsh plugin --profile web add @jorinyang/dsh-doctor

# 或从 GitHub 安装
dsh plugin --profile web add github:jorinyang/dsh-doctor

# 然后重启 dsh web
dsh web
```

安装后，三个工具会注册到 `ctx.tools`，同时 `dsh-doctor` 服务挂载到 Cordis 上下文。

### 作为全局 CLI（命令行直接使用）

```sh
# 全局安装
npm install -g @jorinyang/dsh-doctor

# 或直接用 npx
npx @jorinyang/dsh-doctor
```

安装后可直接在命令行使用：

```sh
# 只读诊断（默认）
dsh-doctor

# 修复（safe 范围，推荐）
dsh-doctor fix

# 修复（deps 范围，包含 pnpm install）
dsh-doctor fix --scope deps

# 回滚最近一次修复
dsh-doctor rollback

# 列出所有修复日志
dsh-doctor rollback --list

# 回滚指定日志
dsh-doctor rollback --id <journal-id>

# 指定 profile 和端口
dsh-doctor diagnose --profile headless --port 8080
```

CLI 选项：

| 命令/选项 | 说明 | 默认值 |
|-----------|------|--------|
| `diagnose` / `check` | 只读诊断（默认命令） | ✓ |
| `fix` / `repair` | 执行修复（可回滚） | |
| `rollback` / `undo` | 撤销修复（LIFO） | |
| `setup` / `install` | 注册到系统 PATH | |
| `--profile <name>` | DSH profile 名称 | `web` |
| `--port <number>` | Web 端口 | `3080` |
| `--scope <level>` | 修复范围：safe / deps / full | `safe` |
| `--id <id>` | 回滚目标 journal id | 最近一次 |
| `--list` | 列出 journal 而非回滚 | |
| `-h, --help` | 显示帮助 | |
| `-V, --version` | 显示版本 | |

退出码：`0` = 全部通过，`1` = 有失败项，`2` = 运行错误。

## PATH 注册

当通过 `dsh plugin add` 安装时，插件会在 `postinstall` 阶段自动注册 `dsh-doctor` 命令到系统 PATH（Windows / macOS / Linux / fish 全覆盖）。

如果自动注册失败，可以手动执行：

```sh
dsh-doctor setup
```

## 回滚：修复可逆

每次 `fix` 都会生成一个 **journal**（存放在 `$DSH_HOME/dsh-doctor/journal/`），记录每一个可逆改动的 undo 步骤：

- 覆盖文件 → 保存原始内容，回滚时恢复；
- 新建文件/目录 → 回滚时删除（仅空目录）；
- `pnpm install`、杀进程等系统边界操作 → 标记为「需手动补偿」。

回滚按 **LIFO（后进先出）** 逆序执行，把环境恢复到修复前。

## 运行时服务（动态调整）

当 DSH 存活时，`dsh-doctor` 通过 Cordis 原生能力提供运行时服务：

- **`ctx.provide('dsh-doctor')`** — 暴露 `diagnose` / `repair` / `rollback` / `journals` / `failures` 方法给其他插件和 agent。
- **`ctx.on('internal/status')`** — 响应式协效应：监控插件 fiber 生命周期，检测到 FAILED 时记录并发出 `dsh-doctor/fiber-failed` 事件。
- **`ctx.effect()`** — 可逆效应：服务持有的所有资源都挂在 disposer 上，卸载 dsh-doctor 时无残留。

其他插件可通过 `ctx.get('dsh-doctor')` 获取服务，或监听 `dsh-doctor/fiber-failed` 事件做自愈。

## 使用方式

在 DSH 对话中告诉 agent：

```text
# 1. 先诊断（只读，永远安全）
运行 dsh_doctor

# 2. 用推荐的范围修复
用 safe 范围运行 dsh_doctor_fix

# 3. 修复后如需撤销
运行 dsh_doctor_rollback

# 4. 只有 safe 未解决时才升级
用 deps 范围运行 dsh_doctor_fix   # 追加 pnpm install
用 full 范围运行 dsh_doctor_fix   # 追加残留进程清理
```

## dsh_doctor 检查什么

| 类别 | 检查内容 |
|------|----------|
| 环境 | Node.js、pnpm、dsh 版本 |
| DSH home | 主目录及必需子目录 |
| Profile | profile 目录、关键文件、node_modules |
| 配置语法 | package.json JSON 合法性、pnpm-workspace.yaml 的 allowBuilds 占位符 |
| Bundle 依赖 | 声明的 bundle 是否存在、link 依赖是否可解析 |
| 配置挂载 | `dsh --dump-config` 是否成功、核心 bundle 是否挂载 |
| 端口 | 指定端口是否空闲 |
| 健康 | Web URL 是否返回 HTTP 200 |
| 磁盘 | DSH home 所在盘剩余空间 |

## dsh_doctor_fix 修复什么

`scope` 参数控制修复的深入程度：

| 范围 | 动作 | 风险 |
|------|------|------|
| `safe`（默认） | 创建缺失目录/文件；修复 allowBuilds 占位符 | 低——仅文件/配置 |
| `deps` | safe 全部，外加 `pnpm install --fix-lockfile` | 中——网络 + 依赖变更 |
| `full` | deps 全部，外加停止残留 DSH 进程（DSH 健康时跳过） | 较高——进程终止 |

## 设计

- **时空可组合** — 对齐 DeepSeek Harness / Cordis 的「时空可组合」范式：修复是可逆效应（Temporal），运行时服务是响应式协效应（Spatial）。
- **可逆修复** — 每个改动记录 undo 步骤，回滚按 LIFO 恢复环境。
- **运行时服务** — 通过 `ctx.provide` / `ctx.on` / `ctx.effect` 接入 Cordis 运行时，动态监控与自愈。
- **仅 host** — 工具 + 服务都在 host 侧；无 client bundle、无 Web 界面。
- **跨平台** — 基于 Node.js 原生模块，不依赖 shell 脚本。
- **幂等** — 修复可安全重复执行；回滚同样幂等。

## 许可证

MIT
