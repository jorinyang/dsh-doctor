/**
 * Model-facing tools: dsh_doctor (read-only diagnostic) and
 * dsh_doctor_fix (repair with safe/deps/full scope).
 *
 * @module @dsh-external/dsh-doctor/tool
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { runDiagnostic } from './diagnose.ts'
import { runRepair, type RepairScope } from './repair.ts'

export const DOCTOR_TOOL_NAME = 'dsh_doctor'
export const DOCTOR_FIX_TOOL_NAME = 'dsh_doctor_fix'

const DIAGNOSE_DESCRIPTION =
  'Diagnose the DeepSeek Harness (DSH) environment and report startup issues. '
  + 'Checks: Node.js/pnpm/dsh versions, DSH home structure, profile files, config syntax, '
  + 'bundle dependencies and links, config mount (--dump-config), port availability, '
  + 'HTTP health, and disk space. Read-only: returns a structured report with per-check '
  + 'pass/fail/warn status and fix hints. Use before debugging why DSH will not start. '
  + 'To actually fix issues, call dsh_doctor_fix.'

const FIX_DESCRIPTION =
  'Repair DeepSeek Harness (DSH) startup issues found by dsh_doctor. Mutating and idempotent: '
  + 'creates missing directories, fixes pnpm-workspace.yaml allowBuilds placeholders, '
  + 'backs up and resets a corrupted cordis.patch.yml, and (scope deps/full) runs pnpm install. '
  + 'Scope controls risk: safe = files/config only; deps = + pnpm install; full = + stop residual '
  + 'processes (skipped when DSH is healthy). Prefer safe first, then escalate. '
  + 'Run dsh_doctor first to see what is broken, then call this with the matching scope.'

export function doctorTool(): ToolDefinition {
  return defineTool({
    name: DOCTOR_TOOL_NAME,
    description: DIAGNOSE_DESCRIPTION,
    parameters: {
      profile: { type: 'string', description: 'DSH profile to inspect. Defaults to "web".' },
      port: { type: 'integer', description: 'Web port to check. Defaults to 3080.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profile: { type: 'string', required: true },
          port: { type: 'integer', required: true },
          dshHome: { type: 'string', required: true },
          checks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['ok', 'fail', 'warn'] },
                detail: { type: 'string', required: true },
                fixHint: { type: 'string' },
              },
            },
          },
          passCount: { type: 'integer', required: true },
          failCount: { type: 'integer', required: true },
          warnCount: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDiagnostic(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      return await runDiagnostic(args.profile?.trim() || 'web', args.port ?? 3080)
    },
    presentCall: () => ({ card: 'generic', title: 'Diagnose DSH', kind: 'other' }),
  })
}

export function doctorFixTool(): ToolDefinition {
  return defineTool({
    name: DOCTOR_FIX_TOOL_NAME,
    description: FIX_DESCRIPTION,
    parameters: {
      profile: { type: 'string', description: 'DSH profile to repair. Defaults to "web".' },
      port: { type: 'integer', description: 'Web port used for the health guard. Defaults to 3080.' },
      scope: {
        type: 'string',
        enum: ['safe', 'deps', 'full'],
        description: 'Repair scope: safe (files/config only, recommended first), deps (adds pnpm install), full (adds residual process cleanup). Defaults to safe.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profile: { type: 'string', required: true },
          scope: { type: 'string', required: true, enum: ['safe', 'deps', 'full'] },
          actions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['applied', 'skipped', 'failed', 'info'] },
                detail: { type: 'string', required: true },
                hint: { type: 'string' },
              },
            },
          },
          appliedCount: { type: 'integer', required: true },
          failedCount: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRepair(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const scope = (args.scope ?? 'safe') as RepairScope
      return await runRepair(args.profile?.trim() || 'web', args.port ?? 3080, scope)
    },
    presentCall: () => ({ card: 'generic', title: 'Repair DSH', kind: 'other' }),
  })
}

function renderDiagnostic(value: any): string {
  const lines: string[] = []
  lines.push('DSH diagnostic report (profile: ' + value.profile + ', port: ' + value.port + ')')
  lines.push('DSH home: ' + value.dshHome)
  lines.push('')
  for (const c of value.checks) {
    const mark = c.status === 'ok' ? '[OK]' : c.status === 'fail' ? '[XX]' : '[--]'
    lines.push('  ' + mark + ' ' + c.detail)
    if (c.fixHint) lines.push('      fix: ' + c.fixHint)
  }
  lines.push('')
  lines.push('Pass: ' + value.passCount + '  Fail: ' + value.failCount + '  Warn: ' + value.warnCount)
  lines.push(value.summary)
  return lines.join('\n')
}

function renderRepair(value: any): string {
  const lines: string[] = []
  lines.push('DSH repair report (profile: ' + value.profile + ', scope: ' + value.scope + ')')
  lines.push('')
  for (const a of value.actions) {
    const mark = a.status === 'applied' ? '[FIX]' : a.status === 'failed' ? '[XX]' : a.status === 'skipped' ? '[SKIP]' : '[--]'
    lines.push('  ' + mark + ' ' + a.detail)
    if (a.hint) lines.push('      hint: ' + a.hint)
  }
  lines.push('')
  lines.push('Applied: ' + value.appliedCount + '  Failed: ' + value.failedCount)
  lines.push(value.summary)
  return lines.join('\n')
}
