import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/dsh-tools";
import { Context } from "@deepseek-ai/cordis";
//#region src/tool.d.ts
declare const DOCTOR_TOOL_NAME = "dsh_doctor";
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
 * Register the dsh_doctor tool.
 * @param ctx - registrant context.
 */
declare function apply(ctx: Context): void;
//#endregion
export { Config, DOCTOR_TOOL_NAME, type DiagnosticCheck, type DiagnosticReport, apply, inject, name };