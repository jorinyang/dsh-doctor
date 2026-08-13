# dsh-doctor

DeepSeek Harness environment diagnostic and repair tool. Two tools:

- **`dsh_doctor`** - read-only diagnostic across environment, profile, config, bundles, mount, port, health, and disk. Returns a structured report with per-check pass/fail/warn status and fix hints.
- **`dsh_doctor_fix`** - applies repairs with a risk-graded scope: `safe` (files/config only), `deps` (adds `pnpm install`), `full` (adds residual process cleanup, skipped when DSH is healthy).

DSH does not ship a built-in `doctor` command. This plugin fills that gap: when DSH will not start, ask the agent to run `dsh_doctor` to see what is broken, then `dsh_doctor_fix` to repair it.

## Install

```sh
dsh plugin --profile web add github:jorinyang/dsh-doctor
# then restart dsh web
```

## Usage

In a DSH conversation:

```text
# diagnose first (read-only)
run dsh_doctor

# then repair (safe scope recommended first)
run dsh_doctor_fix with scope safe

# escalate only if needed
run dsh_doctor_fix with scope deps   # adds pnpm install
run dsh_doctor_fix with scope full   # adds residual process cleanup
```

## What dsh_doctor checks

- **Environment** - Node.js, pnpm, and dsh versions.
- **DSH home** - home directory and required subdirectories.
- **Profile** - profile directory, key files, and node_modules.
- **Config syntax** - package.json JSON validity and pnpm-workspace.yaml allowBuilds placeholders.
- **Bundle dependencies** - declared bundles present, link dependencies resolvable.
- **Config mount** - `dsh --dump-config` succeeds and core bundles mount.
- **Port** - requested port is free.
- **Health** - HTTP 200 on the web URL.
- **Disk** - available space on the DSH home drive.

## What dsh_doctor_fix repairs

- **safe** - creates missing DSH home/profile directories, fixes `pnpm-workspace.yaml` allowBuilds placeholders, creates a missing `cordis.patch.yml`, backs up a corrupted `package.json`.
- **deps** - everything in `safe` plus `pnpm install --fix-lockfile`.
- **full** - everything in `deps` plus stops residual DSH processes (skipped when DSH is healthy to avoid disruption).

Every mutating action is idempotent and backs up before overwriting.

## Design

- **Host-only** - two tools on `ctx.tools`; no client bundle, no web surface.
- **Cross-platform** - implemented on Node.js primitives (`child_process`, `fs`, `net`, `http`).
- **Read-only diagnosis** - `dsh_doctor` never mutates state.
- **Graded repair** - `dsh_doctor_fix` scope controls risk.

## License

MIT
