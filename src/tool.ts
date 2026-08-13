/**
 * The model-facing `dsh_doctor` tool: run a read-only diagnostic across
 * environment, profile, config, bundles, mount, port, health, and disk,
 * returning a structured report with fix hints.
 *
 * @module @dsh-external/dsh-doctor/tool
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { runDiagnostic } from './diagnose.ts'

export const DOCTOR_TOOL_NAME = 'dsh_doctor'

const DESCRIPTION =
  'Diagnose the DeepSeek Harness (DSH) environment and report startup issues. '
  + 'Checks: Node.js/pnpm/dsh versions, DSH home structure, profile files, config syntax, '
  + 'bundle dependencies and links, config mount (--dump-config), port availability, '
  + 'HTTP health, and disk space. Read-only: returns a structured report with per-check '
  + 'pass/fail/warn status and fix hints. Use before debugging why DSH will not start, '
  + 'or to verify a healthy installation. Apply repairs through the shell tool, not here.'

export function doctorTool(): ToolDefinition {
  return defineTool({
    name: DOCTOR_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      profile: {
        type: 'string',
        description: 'DSH profile to inspect. Defaults to "web".',
      },
      port: {
        type: 'integer',
        description: 'Web port to check. Defaults to 3080.',
      },
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
      render: (_args, value) => [{
        type: 'text',
        text: renderReport(value),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const profile = args.profile?.trim() || 'web'
      const port = args.port ?? 3080
      return await runDiagnostic(profile, port)
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Diagnose DSH',
      kind: 'other',
    }),
  })
}

function renderReport(value: any): string {
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
