# dsh-doctor

DeepSeek Harness environment diagnostic tool. The `dsh_doctor` tool runs a read-only diagnostic across environment, profile, config, bundles, mount, port, health, and disk, returning a structured report with per-check pass/fail/warn status and fix hints.

DSH does not ship a built-in `doctor` command. This plugin fills that gap: when DSH will not start, ask the agent to run `dsh_doctor` and it reports what is broken and how to fix it. Repairs are applied through the normal shell tool, not by the plugin, so the diagnostic itself is always safe and side-effect-free.

## Install

```sh
dsh plugin --profile web add @dsh-external/dsh-doctor
# then restart dsh web
```

Or from Git:

```sh
dsh plugin --profile web add github:<owner>/dsh-doctor
```

## Usage

In a DSH conversation, ask:

```text
diagnose why dsh will not start
run dsh_doctor
```

The agent calls `dsh_doctor` and reports the findings. Optionally pass a profile or port:

```text
run dsh_doctor with profile headless port 8080
```

## What it checks

- **Environment** - Node.js, pnpm, and dsh versions.
- **DSH home** - home directory and required subdirectories.
- **Profile** - profile directory, key files, and node_modules.
- **Config syntax** - package.json JSON validity and pnpm-workspace.yaml allowBuilds placeholders.
- **Bundle dependencies** - declared bundles present, link dependencies resolvable.
- **Config mount** - `dsh --dump-config` succeeds and core bundles mount.
- **Port** - requested port is free.
- **Health** - HTTP 200 on the web URL.
- **Disk** - available space on the DSH home drive.

## Design

- **Host-only** - a single tool on `ctx.tools`; no client bundle, no web surface.
- **Read-only** - never mutates state; returns fix hints that the agent applies via the shell tool.
- **Cross-platform** - implemented on Node.js primitives (`child_process`, `fs`, `net`, `http`), not shell scripts.

## License

MIT
