/**
 * dsh-doctor, host half: registers `dsh_doctor` (diagnose) and
 * `dsh_doctor_fix` (repair) tools on `ctx.tools`.
 * Host-only: no client bundle, no web surface.
 *
 * @module @dsh-external/dsh-doctor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { doctorTool, doctorFixTool } from './tool.ts'

export { DOCTOR_TOOL_NAME, DOCTOR_FIX_TOOL_NAME } from './tool.ts'
export type { DiagnosticCheck, DiagnosticReport } from './diagnose.ts'
export type { RepairAction, RepairReport, RepairScope } from './repair.ts'

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
 * Register the dsh_doctor and dsh_doctor_fix tools.
 * @param ctx - registrant context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(doctorTool())
  ctx.tools.register(doctorFixTool())
}
