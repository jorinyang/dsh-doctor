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

Built-in CLI, auto-registered to system PATH on install. Just run it.

**DeepSeek Harness, painlessly.**

---

## Why

DeepSeek Harness does not ship a built-in `doctor` command. When DSH crashes, fails to start, or a plugin breaks the profile, there is no single command to tell you what is wrong and fix it.

`dsh-doctor` fills that gap with two tools:

- **`dsh_doctor`** — read-only diagnostic. Never mutates anything. Reports what is broken and why.
- **`dsh_doctor_fix`** — repair with a risk-graded scope. Every action is idempotent and backs up before overwriting.

## Install

```sh
# from npm
dsh plugin --profile web add @jorinyang/dsh-doctor

# or from GitHub
dsh plugin --profile web add github:jorinyang/dsh-doctor

# then restart dsh web
dsh web
```

After install, the two tools register on `ctx.tools`. Restart the web profile so the bundle layer is composed at boot.

## Usage

In a DSH conversation, ask the agent:

```text
# 1. diagnose first (read-only, always safe)
run dsh_doctor

# 2. repair with the recommended scope
run dsh_doctor_fix with scope safe

# 3. escalate only if the safe pass did not resolve it
run dsh_doctor_fix with scope deps   # adds pnpm install
run dsh_doctor_fix with scope full   # adds residual process cleanup
```

Both tools accept optional `profile` (default `web`) and `port` (default `3080`) parameters:

```text
run dsh_doctor with profile headless port 8080
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
| `safe` (default) | create missing DSH home/profile directories; fix `pnpm-workspace.yaml` allowBuilds placeholders; create a missing `cordis.patch.yml`; back up a corrupted `package.json` | Low — files/config only |
| `deps` | everything in `safe`, plus `pnpm install --fix-lockfile` | Medium — network + dependency changes |
| `full` | everything in `deps`, plus stop residual DSH processes (skipped when DSH is healthy) | Higher — process termination |

Every mutating action is idempotent and backs up before overwriting (`.bak.<timestamp>`).

## Design

- **Host-only** — two tools on `ctx.tools`; no client bundle, no web surface. Results render as ordinary text on every surface (TUI, headless, web).
- **Cross-platform** — implemented on Node.js primitives (`child_process`, `fs`, `net`, `http`), no shell scripts.
- **Read-only diagnosis** — `dsh_doctor` never mutates state.
- **Graded repair** — `dsh_doctor_fix` scope controls risk; prefer `safe` first.
- **Idempotent** — repairs are safe to re-run.

## Troubleshooting

If DSH itself is so broken that the plugin cannot load, the same diagnosis logic is also available as a standalone PowerShell script: `scripts/dsh-doctor.ps1` (see the earlier standalone tool).

## License

MIT