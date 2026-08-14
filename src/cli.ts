#!/usr/bin/env node
/**
 * dsh-doctor CLI: standalone command-line entry for diagnose, repair, and rollback.
 *
 * Usage:
 *   dsh-doctor                     # diagnose (read-only)
 *   dsh-doctor diagnose            # same
 *   dsh-doctor fix                 # repair with scope=safe (journaled)
 *   dsh-doctor fix --scope deps    # repair with scope=deps
 *   dsh-doctor fix --scope full    # repair with scope=full
 *   dsh-doctor rollback            # undo the most recent repair (LIFO)
 *   dsh-doctor rollback --list     # list journals
 *   dsh-doctor rollback --id <id>  # undo a specific journal
 *   dsh-doctor setup               # register to system PATH
 *
 * Options:
 *   --profile <name>   DSH profile (default: web)
 *   --port <number>    web port to check (default: 3080)
 *   --scope <level>    repair scope: safe | deps | full (default: safe)
 *   -h, --help         show help
 *   -V, --version      show version
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { runDiagnostic } from './diagnose.js'
import { runRepair, type RepairScope } from './repair.js'
import { listJournals, rollbackJournal } from './journal.js'

// ── ANSI helpers (zero-dep) ────────────────────────────────
const isTTY = process.stdout.isTTY
const c = {
  reset:   isTTY ? '[0m'  : '',
  bold:    isTTY ? '[1m'  : '',
  dim:     isTTY ? '[2m'  : '',
  red:     isTTY ? '[31m' : '',
  green:   isTTY ? '[32m' : '',
  yellow:  isTTY ? '[33m' : '',
  cyan:    isTTY ? '[36m' : '',
  white:   isTTY ? '[37m' : '',
}

function mark(status: string): string {
  switch (status) {
    case 'ok':      return c.green  + '[OK] ' + c.reset
    case 'fail':    return c.red    + '[XX] ' + c.reset
    case 'warn':    return c.yellow + '[--] ' + c.reset
    case 'applied': return c.green  + '[FIX]' + c.reset
    case 'skipped': return c.dim    + '[SKIP]' + c.reset
    case 'failed':  return c.red    + '[XX] ' + c.reset
    case 'info':    return c.dim    + '[--] ' + c.reset
    case 'undone':  return c.green  + '[UNDO]' + c.reset
    case 'manual':  return c.yellow + '[MANUAL]' + c.reset
    default:        return '     '
  }
}

// ── Version (embedded at build time) ────────────────────────
const VERSION = '0.3.1'

// ── Setup: register to system PATH ─────────────────────────
function getNpmGlobalBin(): string | null {
  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf8', stdio: 'pipe' }).trim()
    return process.platform === 'win32' ? prefix : join(prefix, 'bin')
  } catch {
    return null
  }
}

function isInPath(dir: string): boolean {
  const pathEnv = process.env.PATH || process.env.Path || ''
  const paths = pathEnv.split(path.delimiter)
  const normalizedDir = dir.replace(/\\/g, '/').toLowerCase()
  return paths.some(p => p.replace(/\\/g, '/').toLowerCase() === normalizedDir)
}

function getShellConfig(): { file: string; name: string } {
  const home = homedir()
  const shell = process.env.SHELL || ''
  if (shell.includes('zsh') || existsSync(join(home, '.zshrc'))) {
    return { file: join(home, '.zshrc'), name: '.zshrc' }
  }
  if (shell.includes('bash') || existsSync(join(home, '.bashrc'))) {
    return { file: join(home, '.bashrc'), name: '.bashrc' }
  }
  if (shell.includes('fish')) {
    return { file: join(home, '.config', 'fish', 'config.fish'), name: 'fish config' }
  }
  return { file: join(home, '.profile'), name: '.profile' }
}

function runSetup(): void {
  const globalBin = getNpmGlobalBin()
  if (!globalBin) {
    console.error(c.red + 'Error: Could not determine npm global bin directory.' + c.reset)
    console.error(c.dim + 'Make sure npm is installed: https://nodejs.org/' + c.reset)
    process.exit(2)
  }

  if (!existsSync(globalBin)) {
    mkdirSync(globalBin, { recursive: true })
  }

  const bundleSource = join(dirname(fileURLToPath(import.meta.url)), 'cli.bundle.js')
  if (existsSync(bundleSource)) {
    const bundleDest = join(globalBin, 'dsh-doctor-bundle.js')
    copyFileSync(bundleSource, bundleDest)
    if (process.platform === 'win32') {
      writeFileSync(join(globalBin, 'dsh-doctor.cmd'), '@ECHO off\nnode "' + bundleDest + '" %*\n')
      writeFileSync(join(globalBin, 'dsh-doctor.ps1'), '& node "' + bundleDest + '" @args\n')
    } else {
      const binPath = join(globalBin, 'dsh-doctor')
      writeFileSync(binPath, '#!/bin/sh\nexec node "' + bundleDest + '" "$@"\n', { mode: 0o755 })
    }
    console.log(c.green + '✓ Installed CLI to: ' + globalBin + c.reset)
  } else {
    console.error(c.red + 'Error: CLI bundle not found at ' + bundleSource + c.reset)
    process.exit(2)
  }

  if (!isInPath(globalBin)) {
    console.log('')
    console.log(c.yellow + '⚠ ' + globalBin + ' is not in your PATH.' + c.reset)
    console.log('')
    if (process.platform === 'win32') {
      console.log('To add it, run in PowerShell (as Admin):')
      console.log(c.cyan + '  [Environment]::SetEnvironmentVariable("Path", $env:Path + ";' + globalBin + '", [EnvironmentVariableTarget]::User)' + c.reset)
    } else {
      const shell = getShellConfig()
      console.log('To add it, add this line to your ' + shell.name + ':')
      if (shell.name === 'fish config') {
        console.log(c.cyan + '  set -gx PATH ' + globalBin + ' $PATH' + c.reset)
      } else {
        console.log(c.cyan + '  export PATH="' + globalBin + ':$PATH"' + c.reset)
      }
    }
    console.log('')
  } else {
    console.log(c.green + c.bold + '✓ dsh-doctor is ready to use.' + c.reset)
  }
}

// ── Arg parsing (minimal, no deps) ─────────────────────────
interface CliArgs {
  command: 'diagnose' | 'fix' | 'rollback' | 'setup'
  profile: string
  port: number
  scope: RepairScope
  id: string
  list: boolean
  help: boolean
  version: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'diagnose',
    profile: 'web',
    port: 3080,
    scope: 'safe',
    id: '',
    list: false,
    help: false,
    version: false,
  }

  let i = 0
  while (i < argv.length && !argv[i].startsWith('-')) {
    const tok = argv[i]
    if (tok === 'diagnose' || tok === 'diag' || tok === 'check') {
      args.command = 'diagnose'
    } else if (tok === 'fix' || tok === 'repair') {
      args.command = 'fix'
    } else if (tok === 'rollback' || tok === 'undo') {
      args.command = 'rollback'
    } else if (tok === 'journals' || tok === 'list') {
      args.command = 'rollback'
      args.list = true
    } else if (tok === 'setup' || tok === 'install' || tok === 'register') {
      args.command = 'setup'
    }
    i++
  }

  while (i < argv.length) {
    const tok = argv[i]
    if (tok === '-h' || tok === '--help') {
      args.help = true
    } else if (tok === '-V' || tok === '--version') {
      args.version = true
    } else if (tok === '--list') {
      args.list = true
    } else if (tok === '--profile' && i + 1 < argv.length) {
      args.profile = argv[++i]
    } else if (tok.startsWith('--profile=')) {
      args.profile = tok.slice('--profile='.length)
    } else if (tok === '--port' && i + 1 < argv.length) {
      args.port = Number(argv[++i])
    } else if (tok.startsWith('--port=')) {
      args.port = Number(tok.slice('--port='.length))
    } else if (tok === '--scope' && i + 1 < argv.length) {
      args.scope = argv[++i] as RepairScope
    } else if (tok.startsWith('--scope=')) {
      args.scope = tok.slice('--scope='.length) as RepairScope
    } else if (tok === '--id' && i + 1 < argv.length) {
      args.id = argv[++i]
    } else if (tok.startsWith('--id=')) {
      args.id = tok.slice('--id='.length)
    }
    i++
  }

  return args
}

// ── Help text ──────────────────────────────────────────────
const HELP = `
${c.bold}dsh doctor${c.reset} — DeepSeek Harness diagnostic, repair & rollback CLI

${c.bold}Usage:${c.reset}
  dsh-doctor [command] [options]

${c.bold}Commands:${c.reset}
  diagnose, diag, check   Read-only diagnosis (default)
  fix, repair             Apply journaled repairs (reversible)
  rollback, undo          Undo a repair (LIFO); --list to show journals
  setup, install          Register dsh-doctor command to system PATH

${c.bold}Options:${c.reset}
  --profile <name>        DSH profile to inspect (default: web)
  --port <number>         Web port to check (default: 3080)
  --scope <level>         Repair scope: safe | deps | full (default: safe)
  --id <id>               Journal id for rollback (default: most recent)
  --list                  List journals instead of rolling back
  -h, --help              Show this help
  -V, --version           Show version

${c.bold}Repair scopes:${c.reset}
  safe    Files & config only (recommended first)
  deps    + pnpm install --fix-lockfile
  full    + stop residual DSH processes (skipped when healthy)

${c.bold}Examples:${c.reset}
  dsh-doctor                          # diagnose web profile
  dsh-doctor fix                      # safe repair (journaled)
  dsh-doctor fix --scope deps         # repair + reinstall deps
  dsh-doctor rollback                 # undo the most recent repair
  dsh-doctor rollback --list          # list all repair journals
  dsh-doctor rollback --id doctor-... # undo a specific journal
  dsh-doctor setup                    # register to PATH manually
`

// ── Renderers ──────────────────────────────────────────────
function renderDiagnostic(value: Awaited<ReturnType<typeof runDiagnostic>>): void {
  console.log()
  console.log(c.bold + 'DSH Diagnostic Report' + c.reset + c.dim + '  (profile: ' + value.profile + ', port: ' + value.port + ')' + c.reset)
  console.log(c.dim + 'DSH home: ' + value.dshHome + c.reset)
  console.log()
  for (const ch of value.checks) {
    console.log('  ' + mark(ch.status) + ' ' + ch.detail)
    if (ch.fixHint) console.log('      ' + c.cyan + 'fix: ' + ch.fixHint + c.reset)
  }
  console.log()
  const pass = c.green + value.passCount + ' pass' + c.reset
  const fail = value.failCount > 0 ? c.red + value.failCount + ' fail' + c.reset : c.dim + '0 fail' + c.reset
  const warn = value.warnCount > 0 ? c.yellow + value.warnCount + ' warn' + c.reset : c.dim + '0 warn' + c.reset
  console.log('  ' + pass + '  ' + fail + '  ' + warn)
  console.log()
  if (value.failCount === 0) {
    console.log(c.green + c.bold + '✓ ' + value.summary + c.reset)
  } else {
    console.log(c.red + c.bold + '✗ ' + value.summary + c.reset)
  }
  console.log()
}

function renderRepair(value: Awaited<ReturnType<typeof runRepair>>): void {
  console.log()
  console.log(c.bold + 'DSH Repair Report' + c.reset + c.dim + '  (profile: ' + value.profile + ', scope: ' + value.scope + ')' + c.reset)
  console.log()
  for (const a of value.actions) {
    console.log('  ' + mark(a.status) + ' ' + (a.status === 'applied' ? c.green : '') + a.detail + c.reset)
    if (a.hint) console.log('      ' + c.cyan + 'hint: ' + a.hint + c.reset)
  }
  console.log()
  const applied = c.green + value.appliedCount + ' applied' + c.reset
  const failed = value.failedCount > 0 ? c.red + value.failedCount + ' failed' + c.reset : c.dim + '0 failed' + c.reset
  console.log('  ' + applied + '  ' + failed)
  if (value.journalId) {
    console.log('  ' + c.cyan + 'journal: ' + value.journalId + c.reset + c.dim + '  (undo with: dsh-doctor rollback --id ' + value.journalId + ')' + c.reset)
  }
  console.log()
  if (value.failedCount === 0) {
    console.log(c.green + c.bold + '✓ ' + value.summary + c.reset)
  } else {
    console.log(c.yellow + c.bold + '⚠ ' + value.summary + c.reset)
  }
  console.log()
}

function renderRollback(result: NonNullable<ReturnType<typeof rollbackJournal>>): void {
  console.log()
  console.log(c.bold + 'DSH Rollback Result' + c.reset + c.dim + '  (journal: ' + result.journalId + ')' + c.reset)
  console.log()
  for (const s of result.steps) {
    console.log('  ' + mark(s.status) + ' ' + s.detail)
  }
  console.log()
  const undone = c.green + result.undoneCount + ' undone' + c.reset
  const failed = result.failedCount > 0 ? c.red + result.failedCount + ' failed' + c.reset : c.dim + '0 failed' + c.reset
  const manual = result.manualCount > 0 ? c.yellow + result.manualCount + ' manual' + c.reset : c.dim + '0 manual' + c.reset
  console.log('  ' + undone + '  ' + failed + '  ' + manual)
  console.log()
  console.log(c.green + c.bold + '✓ ' + result.summary + c.reset)
  console.log()
}

function renderJournals(): void {
  const journals = listJournals()
  console.log()
  console.log(c.bold + 'DSH Repair Journals' + c.reset)
  console.log()
  if (journals.length === 0) {
    console.log('  (none)')
  } else {
    for (const j of journals) {
      console.log('  ' + c.cyan + j.id + c.reset)
      console.log('      ' + c.dim + j.createdAt + '  profile=' + j.profile + '  scope=' + j.scope + '  steps=' + j.entries.length + c.reset)
    }
  }
  console.log()
}

// ── Main ───────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.command === 'setup') {
    runSetup()
    process.exit(0)
  }

  if (args.version) {
    console.log(VERSION)
    process.exit(0)
  }

  if (args.help) {
    console.log(HELP)
    process.exit(0)
  }

  try {
    if (args.command === 'diagnose') {
      const report = await runDiagnostic(args.profile, args.port)
      renderDiagnostic(report)
      process.exit(report.failCount > 0 ? 1 : 0)
    } else if (args.command === 'fix') {
      const report = await runRepair(args.profile, args.port, args.scope)
      renderRepair(report)
      process.exit(report.failedCount > 0 ? 1 : 0)
    } else {
      // rollback
      if (args.list) {
        renderJournals()
        process.exit(0)
      }
      const result = args.id ? rollbackJournal(args.id) : (listJournals().length > 0 ? rollbackJournal(listJournals()[0].id) : null)
      if (result === null) {
        console.error(c.red + 'No journal found to roll back.' + c.reset)
        process.exit(1)
      }
      renderRollback(result)
      process.exit(result.failedCount > 0 ? 1 : 0)
    }
  } catch (err: any) {
    console.error(c.red + 'Error: ' + (err?.message ?? String(err)) + c.reset)
    process.exit(2)
  }
}

main()