/**
 * dsh-doctor repair engine: applies safe, dependency, and process repairs.
 * Every mutating action is idempotent and backs up before overwriting.
 *
 * @module @dsh-external/dsh-doctor/repair
 */

import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

/** Repair scope: safe (files/config only), deps (+pnpm install), full (+process cleanup). */
export type RepairScope = 'safe' | 'deps' | 'full'

/** One repair action result. */
export interface RepairAction {
  kind: string
  status: 'applied' | 'skipped' | 'failed' | 'info'
  detail: string
  hint?: string
}

/** Full repair report. */
export interface RepairReport {
  profile: string
  scope: RepairScope
  actions: RepairAction[]
  appliedCount: number
  failedCount: number
  summary: string
}

function resolveDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function backup(path: string): string | null {
  try {
    const bak = path + '.bak.' + timestamp()
    copyFileSync(path, bak)
    return bak
  } catch {
    return null
  }
}

/** Run the repair. All actions are idempotent. */
export async function runRepair(profile: string, port: number, scope: RepairScope): Promise<RepairReport> {
  const dshHome = resolveDshHome()
  const profileDir = join(dshHome, 'profiles', profile)
  const actions: RepairAction[] = []

  // ── Safe: DSH Home directories ───────────────────────────
  if (!existsSync(dshHome)) {
    try {
      mkdirSync(dshHome, { recursive: true })
      actions.push({ kind: 'home', status: 'applied', detail: 'created DSH home: ' + dshHome })
    } catch (e: any) {
      actions.push({ kind: 'home', status: 'failed', detail: 'failed to create DSH home: ' + dshHome, hint: e?.message })
    }
  } else {
    actions.push({ kind: 'home', status: 'info', detail: 'DSH home already exists' })
  }

  for (const dir of ['profiles', 'sessions', 'storages', 'skills', 'scripts', 'cache']) {
    const p = join(dshHome, dir)
    if (!existsSync(p)) {
      try {
        mkdirSync(p, { recursive: true })
        actions.push({ kind: 'home', status: 'applied', detail: 'created dir: ' + dir })
      } catch (e: any) {
        actions.push({ kind: 'home', status: 'failed', detail: 'failed to create dir: ' + dir, hint: e?.message })
      }
    }
  }

  // ── Safe: profile directory ───────────────────────────────
  if (!existsSync(profileDir)) {
    actions.push({ kind: 'profile', status: 'info', detail: 'profile dir missing, will init via dsh --dump-config' })
    try {
      await execAsync('dsh --profile ' + profile + ' --dump-default-config', { timeout: 30000 })
      if (existsSync(profileDir)) {
        actions.push({ kind: 'profile', status: 'applied', detail: 'initialized profile: ' + profile })
      }
    } catch (e: any) {
      actions.push({ kind: 'profile', status: 'failed', detail: 'profile init failed', hint: e?.message })
    }
  }

  // ── Safe: cordis.patch.yml ────────────────────────────────
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    // Validate: reset only if it is not a valid patch array. A simple
    // heuristic: file must exist; deeper YAML validation is done by dsh.
    actions.push({ kind: 'config', status: 'info', detail: 'cordis.patch.yml present, left untouched (backup-on-demand)' })
  } else {
    try {
      writeFileSync(patchPath, '[]\n')
      actions.push({ kind: 'config', status: 'applied', detail: 'created empty cordis.patch.yml' })
    } catch (e: any) {
      actions.push({ kind: 'config', status: 'failed', detail: 'failed to create cordis.patch.yml', hint: e?.message })
    }
  }

  // ── Safe: pnpm-workspace.yaml allowBuilds placeholder ─────
  const wsPath = join(profileDir, 'pnpm-workspace.yaml')
  if (existsSync(wsPath)) {
    try {
      let ws = readFileSync(wsPath, 'utf8')
      if (ws.includes('set this to true or false')) {
        const bak = backup(wsPath)
        ws = ws.replace(/cloudflared: set this to true or false/g, 'cloudflared: true')
        ws = ws.replace(/cpu-features: set this to true or false/g, 'cpu-features: true')
        ws = ws.replace(/ssh2: set this to true or false/g, 'ssh2: true')
        writeFileSync(wsPath, ws)
        actions.push({ kind: 'config', status: 'applied', detail: 'fixed allowBuilds placeholder' + (bak ? ' (backup: ' + bak + ')' : '') })
      } else {
        actions.push({ kind: 'config', status: 'info', detail: 'allowBuilds already configured' })
      }
    } catch (e: any) {
      actions.push({ kind: 'config', status: 'failed', detail: 'failed to fix allowBuilds', hint: e?.message })
    }
  }

  // ── Safe: package.json validity ───────────────────────────
  const pkgPath = join(profileDir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      JSON.parse(readFileSync(pkgPath, 'utf8'))
      actions.push({ kind: 'config', status: 'info', detail: 'package.json valid, left untouched' })
    } catch {
      const bak = backup(pkgPath)
      actions.push({ kind: 'config', status: 'failed', detail: 'package.json is corrupted' + (bak ? ' (backed up to ' + bak + ')' : ''), hint: 'Rebuild package.json manually or re-init the profile' })
    }
  }

  // ── Deps: pnpm install ───────────────────────────────────
  if (scope === 'deps' || scope === 'full') {
    if (existsSync(profileDir)) {
      actions.push({ kind: 'deps', status: 'info', detail: 'running pnpm install' })
      try {
        await execAsync('pnpm install --fix-lockfile', { timeout: 300000, cwd: profileDir })
        actions.push({ kind: 'deps', status: 'applied', detail: 'pnpm install succeeded' })
      } catch (e: any) {
        actions.push({ kind: 'deps', status: 'failed', detail: 'pnpm install failed', hint: e?.message ?? String(e) })
      }
    }
  }

  // ── Full: process cleanup (skip if DSH healthy) ───────────
  if (scope === 'full') {
    actions.push({ kind: 'process', status: 'info', detail: 'process cleanup requested (scope full)' })
    // Only stop processes if DSH is not healthy; otherwise skip.
    const healthy = await checkHealth(port)
    if (healthy) {
      actions.push({ kind: 'process', status: 'skipped', detail: 'DSH is healthy (HTTP 200), skipping process cleanup' })
    } else {
      try {
        await stopDshProcesses()
        actions.push({ kind: 'process', status: 'applied', detail: 'stopped residual DSH processes' })
      } catch (e: any) {
        actions.push({ kind: 'process', status: 'failed', detail: 'failed to stop residual processes', hint: e?.message })
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────
  const appliedCount = actions.filter((a) => a.status === 'applied').length
  const failedCount = actions.filter((a) => a.status === 'failed').length
  const summary = failedCount === 0
    ? 'Repair completed without failures.'
    : failedCount + ' repair action(s) failed; review hints.'

  return { profile, scope, actions, appliedCount, failedCount, summary }
}

async function checkHealth(port: number): Promise<boolean> {
  const http = await import('node:http')
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
      resolve(res.statusCode === 200)
      res.resume()
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

async function stopDshProcesses(): Promise<void> {
  if (process.platform === 'win32') {
    // Find node processes running dsh web and stop them.
    const { execFileSync } = await import('node:child_process')
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'dsh.*web|bin.js web' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { timeout: 30000 })
    } catch {
      // no process or stop failed; treat as no-op
    }
  } else {
    try {
      await execFileAsync('pkill', ['-f', 'dsh.*web'], { timeout: 15000 })
    } catch {
      // no process or pkill unavailable
    }
  }
}
