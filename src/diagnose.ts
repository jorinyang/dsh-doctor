/**
 * dsh-doctor diagnosis engine: read-only checks returning a structured report.
 * All checks are read-only; the tool returns fix hints rather than mutating state.
 *
 * @module @dsh-external/dsh-doctor/diagnose
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import http from 'node:http'

const execFileAsync = promisify(execFile)

export interface DiagnosticCheck {
  kind: string
  status: 'ok' | 'fail' | 'warn'
  detail: string
  fixHint?: string
}

export interface DiagnosticReport {
  profile: string
  port: number
  dshHome: string
  checks: DiagnosticCheck[]
  passCount: number
  failCount: number
  warnCount: number
  summary: string
}

function resolveDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

async function runVersion(cmd: string, args: string[]): Promise<string | null> {
  try {
    // shell: true on Windows resolves npm global .cmd shims (pnpm, dsh);
    // cmd is hardcoded here, never user input, so injection is not a concern.
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10000, shell: process.platform === 'win32' })
    return stdout.trim()
  } catch {
    return null
  }
}

function checkPort(port: number): Promise<{ free: boolean; error?: string }> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve({ free: false, error: 'port ' + port + ' is in use' })
      } else {
        resolve({ free: true })
      }
    })
    server.once('listening', () => {
      server.close(() => resolve({ free: true }))
    })
    server.listen(port, '127.0.0.1')
  })
}

function checkHealth(port: number): Promise<{ ok: boolean; status?: number }> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, (res) => {
      resolve({ ok: res.statusCode === 200, status: res.statusCode })
      res.resume()
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }) })
    req.on('error', () => resolve({ ok: false }))
  })
}

function readPackageJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
  } catch {
    return null
  }
}

export async function runDiagnostic(profile: string, port: number): Promise<DiagnosticReport> {
  const dshHome = resolveDshHome()
  const profileDir = join(dshHome, 'profiles', profile)
  const checks: DiagnosticCheck[] = []

  // 1. Environment
  const nodeVersion = await runVersion('node', ['--version'])
  const pnpmVersion = await runVersion('pnpm', ['--version'])
  const dshVersion = await runVersion('dsh', ['--version'])

  if (nodeVersion) checks.push({ kind: 'env', status: 'ok', detail: 'Node.js ' + nodeVersion })
  else checks.push({ kind: 'env', status: 'fail', detail: 'Node.js not found in PATH', fixHint: 'Install Node.js >= 20' })
  if (pnpmVersion) checks.push({ kind: 'env', status: 'ok', detail: 'pnpm ' + pnpmVersion })
  else checks.push({ kind: 'env', status: 'fail', detail: 'pnpm not found in PATH', fixHint: 'npm install -g pnpm' })
  if (dshVersion) checks.push({ kind: 'env', status: 'ok', detail: 'DSH ' + dshVersion })
  else checks.push({ kind: 'env', status: 'fail', detail: 'dsh command unavailable', fixHint: 'npm install -g @deepseek-ai/dsh' })

  // 2. DSH Home
  if (existsSync(dshHome)) {
    checks.push({ kind: 'home', status: 'ok', detail: 'DSH home exists: ' + dshHome })
    for (const dir of ['profiles', 'sessions', 'storages', 'skills', 'scripts', 'cache']) {
      const p = join(dshHome, dir)
      if (existsSync(p)) checks.push({ kind: 'home', status: 'ok', detail: 'dir exists: ' + dir })
      else checks.push({ kind: 'home', status: 'warn', detail: 'dir missing: ' + dir + ' (auto-created on first launch)' })
    }
  } else {
    checks.push({ kind: 'home', status: 'fail', detail: 'DSH home missing: ' + dshHome, fixHint: 'First dsh run auto-creates it' })
  }

  // 3. Profile structure
  if (existsSync(profileDir)) {
    checks.push({ kind: 'profile', status: 'ok', detail: 'profile dir exists: ' + profile })
    for (const f of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'cordis.yml', 'cordis.patch.yml']) {
      const p = join(profileDir, f)
      if (existsSync(p)) checks.push({ kind: 'profile', status: 'ok', detail: 'file exists: ' + f })
      else checks.push({ kind: 'profile', status: 'fail', detail: 'file missing: ' + f, fixHint: 'Re-run dsh --profile ' + profile + ' to re-init' })
    }
    if (existsSync(join(profileDir, 'node_modules'))) checks.push({ kind: 'profile', status: 'ok', detail: 'node_modules exists' })
    else checks.push({ kind: 'profile', status: 'warn', detail: 'node_modules missing', fixHint: 'Run pnpm install in profile dir' })
  } else {
    checks.push({ kind: 'profile', status: 'fail', detail: 'profile dir missing: ' + profileDir, fixHint: 'Run dsh --profile ' + profile + ' to init' })
  }

  // 4. Config syntax
  const pkgPath = join(profileDir, 'package.json')
  const pkg = readPackageJson(pkgPath)
  if (pkg === null) {
    if (existsSync(pkgPath)) checks.push({ kind: 'config', status: 'fail', detail: 'package.json JSON parse error', fixHint: 'Backup and rebuild package.json' })
  } else {
    checks.push({ kind: 'config', status: 'ok', detail: 'package.json JSON valid' })
  }

  const wsPath = join(profileDir, 'pnpm-workspace.yaml')
  if (existsSync(wsPath)) {
    const ws = readFileSync(wsPath, 'utf8')
    if (ws.includes('set this to true or false')) {
      checks.push({ kind: 'config', status: 'fail', detail: 'pnpm-workspace.yaml has allowBuilds placeholder', fixHint: 'Replace placeholder with true/false' })
    } else {
      checks.push({ kind: 'config', status: 'ok', detail: 'pnpm-workspace.yaml no allowBuilds placeholder' })
    }
  }

  // 5. Bundle dependencies
  if (pkg?.dsh?.profile?.bundles) {
    const bundles: string[] = pkg.dsh.profile.bundles
    checks.push({ kind: 'deps', status: 'warn', detail: 'declared bundles: ' + bundles.join(', ') })
    const nm = join(profileDir, 'node_modules')
    const coreBundles = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    for (const b of bundles) {
      if (coreBundles.has(b)) {
        checks.push({ kind: 'deps', status: 'ok', detail: 'core bundle (provided by global dsh): ' + b })
        continue
      }
      if (existsSync(join(nm, b))) checks.push({ kind: 'deps', status: 'ok', detail: 'bundle installed: ' + b })
      else checks.push({ kind: 'deps', status: 'fail', detail: 'bundle missing: ' + b, fixHint: 'Run pnpm install in profile dir' })
    }
    const deps = pkg.dependencies as Record<string, string> | undefined
    if (deps) {
      for (const [depName, depSpec] of Object.entries(deps)) {
        if (depSpec.startsWith('link:')) {
          const target = depSpec.slice('link:'.length)
          const resolved = target.startsWith('.') ? join(profileDir, target) : target
          if (existsSync(resolved)) checks.push({ kind: 'deps', status: 'ok', detail: 'link dependency valid: ' + depName })
          else checks.push({ kind: 'deps', status: 'fail', detail: 'link dependency broken: ' + depName + ' -> ' + resolved, fixHint: 'Re-link or remove the dependency' })
        }
      }
    }
  }

  // 6. Config mount
  try {
    const { stdout } = await execFileAsync('dsh', ['--profile', profile, '--dump-config'], { timeout: 30000, shell: process.platform === 'win32' })
    checks.push({ kind: 'mount', status: 'ok', detail: '--dump-config succeeded' })
    for (const core of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
      if (stdout.includes(core)) checks.push({ kind: 'mount', status: 'ok', detail: 'core bundle mounted: ' + core })
      else checks.push({ kind: 'mount', status: 'fail', detail: 'core bundle not mounted: ' + core, fixHint: 'Check package.json dsh.profile.bundles' })
    }
  } catch (err: any) {
    checks.push({ kind: 'mount', status: 'fail', detail: '--dump-config failed: ' + (err?.message ?? String(err)), fixHint: 'Check cordis.patch.yml and bundle config' })
  }

  // 7. Port
  const portResult = await checkPort(port)
  if (portResult.free) checks.push({ kind: 'port', status: 'ok', detail: 'port ' + port + ' is free' })
  else checks.push({ kind: 'port', status: 'warn', detail: portResult.error ?? 'port ' + port + ' in use', fixHint: 'Stop the occupying process or use --port' })

  // 8. Health
  const health = await checkHealth(port)
  if (health.ok) checks.push({ kind: 'health', status: 'ok', detail: 'HTTP ' + health.status + ' - DSH web running' })
  else checks.push({ kind: 'health', status: 'warn', detail: 'no HTTP 200 on port ' + port, fixHint: 'Start DSH: dsh web' })

  // 9. Disk space (best-effort)
  try {
    const { execFileSync } = await import('node:child_process')
    if (process.platform === 'win32') {
      const drive = dshHome.slice(0, 2)
      const out = execFileSync('wmic', ['logicaldisk', 'where', 'DeviceID=\'' + drive + '\'', 'get', 'FreeSpace,Size', '/value'], { timeout: 10000 }).toString()
      const free = Number(out.match(/FreeSpace=(\d+)/)?.[1] ?? '0')
      const freeGB = free / 1024 ** 3
      checks.push({ kind: 'disk', status: freeGB < 1 ? 'fail' : 'ok', detail: 'disk ' + drive + ' free: ' + freeGB.toFixed(2) + ' GB', fixHint: freeGB < 1 ? 'Clean disk or migrate DSH_HOME' : undefined })
    } else {
      const { stdout } = await execFileAsync('df', ['-h', dshHome], { timeout: 10000 })
      checks.push({ kind: 'disk', status: 'ok', detail: 'disk: ' + stdout.trim().split('\n').pop() })
    }
  } catch {
    checks.push({ kind: 'disk', status: 'warn', detail: 'disk space check skipped' })
  }

  // Summary
  const passCount = checks.filter((c) => c.status === 'ok').length
  const failCount = checks.filter((c) => c.status === 'fail').length
  const warnCount = checks.filter((c) => c.status === 'warn').length
  const summary = failCount === 0
    ? 'No blocking issues found; DSH should start normally.'
    : failCount + ' blocking issue(s) found; review fix hints.'

  return { profile, port, dshHome, checks, passCount, failCount, warnCount, summary }
}
