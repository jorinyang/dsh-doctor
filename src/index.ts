/**
 * dsh-doctor, host half: a diagnostic/repair plugin that is both a set of
 * model-facing tools AND a Cordis runtime service.
 *
 * Tools (dsh_doctor / dsh_doctor_fix / dsh_doctor_rollback) are usable by the
 * agent; the `dsh-doctor` service (diagnose / repair / rollback / journals /
 * failures) is provided for other plugins and runtime self-healing.
 *
 * Host-only: no client bundle, no web surface.
 *
 * @module @jorinyang/dsh-doctor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { doctorTool, doctorFixTool, doctorRollbackTool } from './tool.ts'
import { installRuntime } from './runtime.ts'

export { DOCTOR_TOOL_NAME, DOCTOR_FIX_TOOL_NAME, DOCTOR_ROLLBACK_TOOL_NAME } from './tool.ts'
export { runDiagnostic } from './diagnose.ts'
export type { DiagnosticCheck, DiagnosticReport } from './diagnose.ts'
export { runRepair } from './repair.ts'
export type { RepairAction, RepairReport, RepairScope } from './repair.ts'
export { listJournals, rollbackJournal, JournalCollector } from './journal.ts'
export type { Journal, JournalEntry, UndoOp, RollbackResult } from './journal.ts'
export { installRuntime } from './runtime.ts'
export type { DoctorService, FiberFailure } from './runtime.ts'

/** Cordis plugin name. */
export const name = 'dsh-doctor'
/** Required services: the tool registry only (runtime service uses ctx.provide). */
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
 * Register the dsh_doctor / dsh_doctor_fix / dsh_doctor_rollback tools and
 * install the runtime service on the Cordis context.
 * @param ctx - registrant context.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(doctorTool())
  ctx.tools.register(doctorFixTool())
  ctx.tools.register(doctorRollbackTool())
  installRuntime(ctx, config)
}