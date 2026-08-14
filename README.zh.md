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

自带 CLI，安装自动注册到系统 PATH，直接执行即可。

**无痛折腾 DeepSeek Harness**

---

## 为什么需要它

DeepSeek Harness 没有内置 `doctor` 命令。当 DSH 崩溃、无法启动、或某个插件破坏了 profile 时，没有一条命令能告诉你问题出在哪并修复它。

`dsh-doctor` 用两个工具填补这个空缺：

- **`dsh_doctor`** — 只读诊断。绝不改动任何东西，只报告哪里坏了、为什么。
- **`dsh_doctor_fix`** — 按风险分级修复。每个动作幂等，覆盖前先备份。

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

安装后，两个工具会注册到 `ctx.tools`。需要重启 web profile，让 bundle 层在启动时完成合成。

### 作为全局 CLI（命令行直接使用）

```sh
# 全局安装
npm install -g @jorinyang/dsh-doctor

# 或直接用 npx
npx @jorinyang/dsh-doctor
```

安装后可直接在命令行使用。

```sh
# 只读诊断（默认）
dsh-doctor

# 修复（safe 范围，推荐）
dsh-doctor fix

# 修复（deps 范围，包含 pnpm install）
dsh-doctor fix --scope deps

# 指定 profile 和端口
dsh-doctor diagnose --profile headless --port 8080
```

CLI 选项：

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `diagnose` / `check` | 只读诊断（默认命令） | ✓ |
| `fix` / `repair` | 执行修复 | |
| `--profile <name>` | DSH profile 名称 | `web` |
| `--port <number>` | Web 端口 | `3080` |
| `--scope <level>` | 修复范围：safe / deps / full | `safe` |
| `-h, --help` | 显示帮助 | |
| `-V, --version` | 显示版本 | |

退出码：`0` = 全部通过，`1` = 有失败项，`2` = 运行错误。

## PATH 注册

当通过 `dsh plugin add` 安装时，插件会在 `postinstall` 阶段自动注册 `dsh-doctor` 命令到系统 PATH。

如果自动注册失败，可以手动执行：

```sh
# 在 DSH profile 目录下执行
node node_modules/@jorinyang/dsh-doctor/lib/cli.js setup

# 或者如果 dsh-doctor 已经在 PATH 中
dsh-doctor setup
```

注册后，你可以在任何终端使用 `dsh-doctor` 命令。

## 使用方式

在 DSH 对话中告诉 agent：

```text
# 1. 先诊断（只读，永远安全）
运行 dsh_doctor

# 2. 用推荐的范围修复
用 safe 范围运行 dsh_doctor_fix

# 3. 只有 safe 未解决时才升级
用 deps 范围运行 dsh_doctor_fix   # 追加 pnpm install
用 full 范围运行 dsh_doctor_fix   # 追加残留进程清理
```

两个工具都接受可选的 `profile`（默认 `web`）和 `port`（默认 `3080`）参数：

```text
用 profile headless port 8080 运行 dsh_doctor
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

每项检查返回 `ok` / `fail` / `warn`，附带可读详情；失败时还会给出 `fixHint` 修复建议。

## dsh_doctor_fix 修复什么

`scope` 参数控制修复的深入程度：

| 范围 | 动作 | 风险 |
|------|------|------|
| `safe`（默认） | 创建缺失的 DSH home/profile 目录；修复 `pnpm-workspace.yaml` 的 allowBuilds 占位符；创建缺失的 `cordis.patch.yml`；备份损坏的 `package.json` | 低——仅文件/配置 |
| `deps` | safe 全部，外加 `pnpm install --fix-lockfile` | 中——网络 + 依赖变更 |
| `full` | deps 全部，外加停止残留 DSH 进程（DSH 健康时跳过） | 较高——进程终止 |

每个改动动作都幂等，覆盖前先备份（`.bak.<时间戳>`）。

## 设计

- **仅 host** — 两个工具注册在 `ctx.tools`；无 client bundle、无 Web 界面。结果在所有界面（TUI、headless、web）都以普通文本呈现。
- **跨平台** — 基于 Node.js 原生模块（`child_process`、`fs`、`net`、`http`）实现，不依赖 shell 脚本。
- **只读诊断** — `dsh_doctor` 绝不改动状态。
- **分级修复** — `dsh_doctor_fix` 的 scope 控制风险；优先用 `safe`。
- **幂等** — 修复可安全重复执行。

## 故障排查

如果 DSH 本身坏到连插件都无法加载，同样的诊断逻辑也提供了独立的 PowerShell 脚本：`scripts/dsh-doctor.ps1`（见更早的独立工具版本）。

## 许可证

MIT