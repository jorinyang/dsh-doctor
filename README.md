# dsh-doctor

> **DSH crashed? Can't start? Use: [dsh-doctor](https://github.com/jorinyang/dsh-doctor)**

[![license](https://badgen.net/badge/license/MIT/green)](LICENSE) [![topic](https://badgen.net/badge/topic/dsh-plugin/8257D0)](https://github.com/topics/dsh-plugin)

中文文档见 [README.zh.md](./README.zh.md)。

---

## Two commands to fix your DSH

```sh
# Install
dsh plugin --profile web add @jorinyang/dsh-doctor

# Fix
dsh-doctor
```

Built-in CLI, auto-registered to system PATH on install. Repairs are fully reversible.

**DeepSeek Harness, painlessly.**

---

## Why

DeepSeek Harness does not ship a built-in `doctor` command. When DSH crashes, fails to start, or a plugin breaks the profile, there is no single command to tell you what is wrong and fix it.

`dsh-doctor` fills that gap with three tools and one runtime service:

- **`dsh_doctor`** — read-only diagnostic. Never mutates anything. Reports what is broken and why.
- **`dsh_doctor_fix`** — repair with a risk-graded scope; every reversible change is journaled with an undo step.
- **`dsh_doctor_rollback`** — undo a repair (LIFO), restoring the environment to its pre-repair state.
- **`dsh-doctor` runtime service** — diagnose/repair/rollback API plus reactive plugin-lifecycle monitoring while DSH is alive.

## Install

### As a DSH plugin (used by the agent)

```sh
# from npm
dsh plugin --profile web add @jorinyang/dsh-doctor

# or from GitHub
dsh plugin --profile web add github:jorinyang/dsh-doctor

# then restart dsh web
dsh web
```

After install, the three tools register on `ctx.tools` and the `dsh-doctor` service mounts on the Cordis context.

### As a global CLI (direct command line use)

```sh
# install globally
npm install -g @jorinyang/dsh-doctor

# or use npx
npx @jorinyang/dsh-doctor
```

Then use it directly:

```sh
# read-only diagnosis (default)
dsh-doctor

# repair (safe scope, recommended)
dsh-doctor fix

# repair + reinstall deps
dsh-doctor fix --scope deps

# undo the most recent repair
dsh-doctor rollback

# list all repair journals
dsh-doctor rollback --list

# undo a specific journal
dsh-doctor rollback --id <journal-id>

# specify profile and port
dsh-doctor diagnose --profile headless --port 8080
```

CLI commands and options:

| Command/option | Description | Default |
|----------------|-------------|---------|
| `diagnose` / `check` | Read-only diagnosis (default) | ✓ |
| `fix` / `repair` | Apply journaled repairs (reversible) | |
| `rollback` / `undo` | Undo a repair (LIFO) | |
| `setup` / `install` | Register to system PATH | |
| `--profile <name>` | DSH profile name | `web` |
| `--port <number>` | Web port | `3080` |
| `--scope <level>` | safe / deps / full | `safe` |
| `--id <id>` | Journal id to roll back | most recent |
| `--list` | List journals instead of rolling back | |
| `-h, --help` | Show help | |
| `-V, --version` | Show version | |

Exit codes: `0` = all passed, `1` = failures found, `2` = runtime error.

## PATH registration

When installed via `dsh plugin add`, the plugin auto-registers the `dsh-doctor` command on system PATH during `postinstall` (Windows / macOS / Linux / fish).

To register manually:

```sh
dsh-doctor setup
```

## Rollback: reversible repairs

Every `fix` writes a **journal** (under `$DSH_HOME/dsh-doctor/journal/`) recording the undo step of each reversible change:

- overwritten file → original content saved, restored on rollback;
- created file/dir → deleted on rollback (empty dirs only);
- system-boundary ops (pnpm install, killed processes) → flagged for manual compensation.

Rollback replays these in **LIFO** (reverse) order to restore the pre-repair environment.

## Runtime service (dynamic adjustment)

While DSH is alive, `dsh-doctor` wires into Cordis's native runtime primitives:

- **`ctx.provide('dsh-doctor')`** — exposes `diagnose` / `repair` / `rollback` / `journals` / `failures` to other plugins and the agent.
- **`ctx.on('internal/status')`** — reactive coeffects: watches plugin-fiber lifecycle and emits `dsh-doctor/fiber-failed` when a fiber enters FAILED.
- **`ctx.effect()`** — reversible effects: every resource the service owns is wrapped in a disposer, so unloading dsh-doctor leaves no residue.

Other plugins can read the service via `ctx.get('dsh-doctor')` or listen to `dsh-doctor/fiber-failed` for self-healing.

## Usage

In a DSH conversation, ask the agent:

```text
# 1. diagnose first (read-only, always safe)
run dsh_doctor

# 2. repair with the recommended scope
run dsh_doctor_fix with scope safe

# 3. undo if needed
run dsh_doctor_rollback

# 4. escalate only if the safe pass did not resolve it
run dsh_doctor_fix with scope deps   # adds pnpm install
run dsh_doctor_fix with scope full   # adds residual process cleanup
```

## What dsh_doctor checks

| Category | What it checks |
|----------|----------------|
| Environment | Node.js, pnpm, and dsh versions |
| DSH home | home directory and required subdirectories |
| Profile | profile directory, key files, node_modules |
| Config syntax | package.json JSON validity, pnpm-workspace.yaml allowBuilds placeholders |
| Bundle dependencies | declared bundles present, link dependencies resolvable |
| Config mount | `dsh --dump-config` succeeds, core bundles mount |
| Port | requested port is free |
| Health | HTTP 200 on the web URL |
| Disk | available space on the DSH home drive |

Each check returns `ok` / `fail` / `warn` with a human-readable detail and, when it fails, a `fixHint`.

## What dsh_doctor_fix repairs

The `scope` parameter controls how far the repair goes:

| Scope | Actions | Risk |
|-------|---------|------|
| `safe` (default) | create missing dirs/files; fix allowBuilds placeholders | Low — files/config only |
| `deps` | everything in `safe`, plus `pnpm install --fix-lockfile` | Medium — network + dependency changes |
| `full` | everything in `deps`, plus stop residual DSH processes (skipped when DSH is healthy) | Higher — process termination |

Every reversible action is journaled for rollback.

## Design

- **Spatiotemporal composability** — aligned with DeepSeek Harness / Cordis's paradigm: reversible effects for repairs (temporal), reactive coeffects for the runtime service (spatial).
- **Reversible repairs** — every change records an undo step; rollback restores via LIFO.
- **Runtime service** — `ctx.provide` / `ctx.on` / `ctx.effect` for dynamic monitoring and self-healing.
- **Host-only** — tools + service on the host side; no client bundle, no web surface.
- **Cross-platform** — Node.js primitives, no shell scripts.
- **Idempotent** — repairs and rollbacks are safe to re-run.

## License

MIT
