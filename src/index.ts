/**
 * dsh-doctor, host half: registers the `dsh_doctor` tool on `ctx.tools`.
 * Host-only: no client bundle, no web surface. The tool result renders as
 * ordinary text on every surface (TUI, headless, web).
 *
 * @module @dsh-external/dsh-doctor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { doctorTool } from './tool.ts'

export { DOCTOR_TOOL_NAME } from './tool.ts'
export type { DiagnosticCheck, DiagnosticReport } from './diagnose.ts'

/** Cordis plugin name. */
export const name = 'dsh-doctor'
/** Required services: the tool registry only. */
export const inject = ['tools']

/** Deployment configuration. */
export interface Config {
  /** Web port checked by default. */
  defaultPort: number
}

/** Schemastery configuration validated by the Loader. */
export const Config: z<Config> = z.object({
  defaultPort: z.natural().default(3080),
})

/**
 * Register the dsh_doctor tool.
 * @param ctx - registrant context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(doctorTool())
}
