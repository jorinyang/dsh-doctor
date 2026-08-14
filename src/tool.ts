/**
 * Model-facing tools: dsh_doctor (diagnose), dsh_doctor_fix (journaled repair),
 * and dsh_doctor_rollback (LIFO undo of a repair).
 *
 * @module @jorinyang/dsh-doctor/tool
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { runDiagnostic } from './diagnose.ts'
import { runRepair, type RepairScope } from './repair.ts'
import { listJournals, rollbackJournal } from './journal.ts'

export const DOCTOR_TOOL_NAME = 'dsh_doctor'
export const DOCTOR_FIX_TOOL_NAME = 'dsh_doctor_fix'
export const DOCTOR_ROLLBACK_TOOL_NAME = 'dsh_doctor_rollback'

const DIAGNOSE_DESCRIPTION =
  'Diagnose the DeepSeek Harness (DSH) environment and report startup issues. '
  + 'Checks: Node.js/pnpm/dsh versions, DSH home structure, profile files, config syntax, '
  + 'bundle dependencies and links, config mount (--dump-config), port availability, '
  + 'HTTP health, and disk space. Read-only: returns a structured report with per-check '
  + 'pass/fail/warn status and fix hints. Use before debugging why DSH will not start. '
  + 'To actually fix issues, call dsh_doctor_fix.'

const FIX_DESCRIPTION =
  'Repair DeepSeek Harness (DSH) startup issues found by dsh_doctor. Mutating, idempotent, '
  + 'and JOURNALED: every reversible change (created dirs/files, edited config) is recorded '
  + 'with an undo step, so the whole run can be rolled back via dsh_doctor_rollback. '
  + 'Creates missing directories, fixes pnpm-workspace.yaml allowBuilds placeholders, '
  + 'creates a missing cordis.patch.yml, and (scope deps/full) runs pnpm install. '
  + 'Scope controls risk: safe = files/config only; deps = + pnpm install; full = + stop residual '
  + 'processes (skipped when DSH is healthy). Prefer safe first, then escalate. '
  + 'Run dsh_doctor first to see what is broken, then call this with the matching scope. '
  + 'The report returns a journalId; pass it to dsh_doctor_rollback to undo.'

const ROLLBACK_DESCRIPTION =
  'Undo a previous dsh_doctor_fix run by replaying its recorded reversible effects in reverse '
  + '(LIFO). Each fix is journaled; rollback restores overwritten files, deletes created files/dirs, '
  + 'and reports which steps need manual compensation (e.g. pnpm install, killed processes). '
  + 'Call with no id to roll back the most recent journal, or pass the journalId returned by '
  + 'dsh_doctor_fix. Use dsh_doctor_rollback with action=list to see all journals first.'

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
          journalId: { type: 'string' },
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

export function doctorRollbackTool(): ToolDefinition {
  return defineTool({
    name: DOCTOR_ROLLBACK_TOOL_NAME,
    description: ROLLBACK_DESCRIPTION,
    parameters: {
      id: { type: 'string', description: 'Journal id from dsh_doctor_fix. Omit to roll back the most recent.' },
      action: {
        type: 'string',
        enum: ['rollback', 'list'],
        description: 'rollback (default) undoes a journal; list shows all journals.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          journals: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                createdAt: { type: 'string', required: true },
                profile: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                entryCount: { type: 'integer', required: true },
              },
            },
          },
          result: {
            type: 'object',
            additionalProperties: false,
            properties: {
              journalId: { type: 'string', required: true },
              undoneCount: { type: 'integer', required: true },
              failedCount: { type: 'integer', required: true },
              manualCount: { type: 'integer', required: true },
              summary: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRollback(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, _exec) {
      const journals = listJournals().map((j) => ({
        id: j.id,
        createdAt: j.createdAt,
        profile: j.profile,
        scope: j.scope,
        entryCount: j.entries.length,
      }))
      if (args.action === 'list') {
        return { journals }
      }
      const raw = rollbackJournal(args.id || '')
      if (raw === null) {
        return { journals }
      }
      const result = {
        journalId: raw.journalId,
        undoneCount: raw.undoneCount,
        failedCount: raw.failedCount,
        manualCount: raw.manualCount,
        summary: raw.summary,
      }
      return { journals, result }
    },
    presentCall: () => ({ card: 'generic', title: 'Rollback DSH repair', kind: 'other' }),
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
  if (value.journalId) {
    lines.push('Journal: ' + value.journalId + '  (roll back with dsh_doctor_rollback)')
  }
  lines.push(value.summary)
  return lines.join('\n')
}

function renderRollback(value: any): string {
  const lines: string[] = []
  if (value.result) {
    const r = value.result
    lines.push('DSH rollback result (journal: ' + r.journalId + ')')
    lines.push('Undone: ' + r.undoneCount + '  Failed: ' + r.failedCount + '  Manual: ' + r.manualCount)
    lines.push(r.summary)
  } else {
    lines.push('DSH repair journals:')
    for (const j of value.journals) {
      lines.push('  ' + j.id + '  (' + j.profile + ', ' + j.scope + ', ' + j.entryCount + ' steps)')
    }
    if (value.journals.length === 0) lines.push('  (none)')
  }
  return lines.join('\n')
}