import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/dsh-tools";
import { Context } from "@deepseek-ai/cordis";
//#region src/tool.d.ts
declare const DOCTOR_TOOL_NAME = "dsh_doctor";
declare const DOCTOR_FIX_TOOL_NAME = "dsh_doctor_fix";
//#endregion
//#region src/diagnose.d.ts
/**
 * dsh-doctor diagnosis engine: read-only checks returning a structured report.
 * All checks are read-only; the tool returns fix hints rather than mutating state.
 *
 * @module @dsh-external/dsh-doctor/diagnose
 */
interface DiagnosticCheck {
  kind: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
  fixHint?: string;
}
interface DiagnosticReport {
  profile: string;
  port: number;
  dshHome: string;
  checks: DiagnosticCheck[];
  passCount: number;
  failCount: number;
  warnCount: number;
  summary: string;
}
//#endregion
//#region src/repair.d.ts
/**
 * dsh-doctor repair engine: applies safe, dependency, and process repairs.
 * Every mutating action is idempotent and backs up before overwriting.
 *
 * @module @dsh-external/dsh-doctor/repair
 */
/** Repair scope: safe (files/config only), deps (+pnpm install), full (+process cleanup). */
type RepairScope = 'safe' | 'deps' | 'full';
/** One repair action result. */
interface RepairAction {
  kind: string;
  status: 'applied' | 'skipped' | 'failed' | 'info';
  detail: string;
  hint?: string;
}
/** Full repair report. */
interface RepairReport {
  profile: string;
  scope: RepairScope;
  actions: RepairAction[];
  appliedCount: number;
  failedCount: number;
  summary: string;
}
//#endregion
//#region src/index.d.ts
/** Cordis plugin name. */
declare const name = "dsh-doctor";
/** Required services: the tool registry only. */
declare const inject: string[];
/** Deployment configuration. */
interface Config {
  /** Web port checked by default. */
  defaultPort: number;
}
/** Schemastery configuration validated by the Loader. */
declare const Config: z<Config>;
/**
 * Register the dsh_doctor and dsh_doctor_fix tools.
 * @param ctx - registrant context.
 */
declare function apply(ctx: Context): void;
//#endregion
export { Config, DOCTOR_FIX_TOOL_NAME, DOCTOR_TOOL_NAME, type DiagnosticCheck, type DiagnosticReport, type RepairAction, type RepairReport, type RepairScope, apply, inject, name };