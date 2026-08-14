import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/dsh-tools";
import { Context } from "@deepseek-ai/cordis";
//#region src/tool.d.ts
declare const DOCTOR_TOOL_NAME = "dsh_doctor";
declare const DOCTOR_FIX_TOOL_NAME = "dsh_doctor_fix";
declare const DOCTOR_ROLLBACK_TOOL_NAME = "dsh_doctor_rollback";
//#endregion
//#region src/diagnose.d.ts
/**
 * dsh-doctor diagnosis engine: read-only checks returning a structured report.
 * All checks are read-only; the tool returns fix hints rather than mutating state.
 *
 * @module @jorinyang/dsh-doctor/diagnose
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
declare function runDiagnostic(profile: string, port: number): Promise<DiagnosticReport>;
//#endregion
//#region src/repair.d.ts
/**
 * dsh-doctor repair engine: applies safe, dependency, and process repairs.
 * Every mutating action is idempotent and records a reversible effect into
 * a journal, so the whole run can be rolled back (LIFO) afterwards.
 *
 * @module @jorinyang/dsh-doctor/repair
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
  /** Persisted journal id; pass to dsh_doctor_rollback / dsh-doctor rollback to undo. */
  journalId?: string;
}
/** Run the repair. All actions are idempotent; reversible ones are journaled. */
declare function runRepair(profile: string, port: number, scope: RepairScope): Promise<RepairReport>;
//#endregion
//#region src/journal.d.ts
/**
 * dsh-doctor journal: reversible-effect log with persistent rollback.
 *
 * Implements the "time composability" half of the Spatiotemporal
 * Composability paradigm: every mutation records a serializable undo
 * operation; rollback replays them in reverse (LIFO) to restore the
 * environment to its pre-repair state.
 *
 * Undo operations are DATA (not closures) so they survive process exit
 * and can be replayed by the standalone CLI, by the agent tools, or by
 * the runtime service.
 *
 * @module @jorinyang/dsh-doctor/journal
 */
/** One serializable undo operation. */
type UndoOp = {
  type: 'restore-file';
  detail: string;
  path: string;
  backupPath: string;
} | {
  type: 'delete-file';
  detail: string;
  path: string;
} | {
  type: 'remove-dir';
  detail: string;
  path: string;
} | {
  type: 'manual';
  detail: string;
};
/** One journal entry: what was done + how to reverse it. */
interface JournalEntry {
  kind: string;
  detail: string;
  undo: UndoOp;
}
/** A persisted journal. */
interface Journal {
  id: string;
  createdAt: string;
  profile: string;
  scope: string;
  entries: JournalEntry[];
}
/** Result of one rollback. */
interface RollbackResult {
  journalId: string;
  undoneCount: number;
  failedCount: number;
  manualCount: number;
  steps: {
    kind: string;
    detail: string;
    status: 'undone' | 'failed' | 'manual';
  }[];
  summary: string;
}
/**
 * Collects reversible effects during a repair run.
 * Each mutate records its undo op; backups are stored inside this
 * journal's directory so rollback stays self-contained.
 */
declare class JournalCollector {
  readonly id: string;
  readonly createdAt: string;
  readonly profile: string;
  readonly scope: string;
  readonly entries: JournalEntry[];
  private backupCounter;
  private dir;
  constructor(profile: string, scope: string);
  private ensureDir;
  /** Record a reversible file overwrite (save original, write new). */
  overwriteFile(path: string, newContent: string, kind: string, detail: string): void;
  /** Record creating a new file (undo = delete it). */
  createFile(path: string, content: string, kind: string, detail: string): void;
  /** Record creating a directory (undo = remove it, best-effort if empty). */
  createDir(path: string, kind: string, detail: string): void;
  /** Record a non-reversible operation (system boundary: needs manual compensation). */
  manual(kind: string, detail: string): void;
  /** Persist this journal to disk; returns the journal file path. */
  persist(): string | null;
}
/** List all persisted journals, newest first. */
declare function listJournals(): Journal[];
/**
 * Roll back one journal: replay undo ops in reverse (LIFO).
 * Files that no longer have their backup are reported as manual.
 */
declare function rollbackJournal(id: string): RollbackResult | null;
//#endregion
//#region src/runtime.d.ts
/** Custom events emitted by the doctor (reactive coeffects surface). */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'dsh-doctor/fiber-failed'(name: string, state: number): void;
    'dsh-doctor/fiber-recovered'(name: string): void;
  }
}
interface DoctorConfig {
  defaultPort: number;
}
/** A failure observation recorded by the reactive watcher. */
interface FiberFailure {
  fiberName: string;
  at: string;
  state: number;
}
/** Public API exposed as the `dsh-doctor` service. */
interface DoctorService {
  /** Read-only live diagnostic. */
  diagnose(profile?: string, port?: number): ReturnType<typeof runDiagnostic>;
  /** Repair with journaled reversible effects. */
  repair(profile?: string, port?: number, scope?: RepairScope): ReturnType<typeof runRepair>;
  /** Roll back a repair journal (LIFO); defaults to the most recent. */
  rollback(id?: string): RollbackResult | null;
  /** List persisted repair journals. */
  journals(): ReturnType<typeof listJournals>;
  /** Reactive observations: plugin failures seen since this service loaded. */
  failures(): FiberFailure[];
}
/**
 * Install the runtime service on a Cordis context.
 * All resources are owned by the fiber via ctx.effect, so they auto-dispose
 * when dsh-doctor unloads (reversible effects).
 */
declare function installRuntime(ctx: Context, config: DoctorConfig): void;
//#endregion
//#region src/index.d.ts
/** Cordis plugin name. */
declare const name = "dsh-doctor";
/** Required services: the tool registry only (runtime service uses ctx.provide). */
declare const inject: string[];
/** Deployment configuration. */
interface Config {
  /** Web port checked by default. */
  defaultPort: number;
}
/** Schemastery configuration validated by the Loader. */
declare const Config: z<Config>;
/**
 * Register the dsh_doctor / dsh_doctor_fix / dsh_doctor_rollback tools and
 * install the runtime service on the Cordis context.
 * @param ctx - registrant context.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, DOCTOR_FIX_TOOL_NAME, DOCTOR_ROLLBACK_TOOL_NAME, DOCTOR_TOOL_NAME, type DiagnosticCheck, type DiagnosticReport, type DoctorService, type FiberFailure, type Journal, JournalCollector, type JournalEntry, type RepairAction, type RepairReport, type RepairScope, type RollbackResult, type UndoOp, apply, inject, installRuntime, listJournals, name, rollbackJournal, runDiagnostic, runRepair };