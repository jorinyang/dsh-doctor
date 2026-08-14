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

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, rmdirSync, copyFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One serializable undo operation. */
export type UndoOp =
  | { type: 'restore-file'; detail: string; path: string; backupPath: string }
  | { type: 'delete-file'; detail: string; path: string }
  | { type: 'remove-dir'; detail: string; path: string }
  | { type: 'manual'; detail: string }

/** One journal entry: what was done + how to reverse it. */
export interface JournalEntry {
  kind: string
  detail: string
  undo: UndoOp
}

/** A persisted journal. */
export interface Journal {
  id: string
  createdAt: string
  profile: string
  scope: string
  entries: JournalEntry[]
}

/** Result of one rollback. */
export interface RollbackResult {
  journalId: string
  undoneCount: number
  failedCount: number
  manualCount: number
  steps: { kind: string; detail: string; status: 'undone' | 'failed' | 'manual' }[]
  summary: string
}

function resolveDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Journal storage root: $DSH_HOME/dsh-doctor/journal */
export function journalRoot(): string {
  return join(resolveDshHome(), 'dsh-doctor', 'journal')
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Collects reversible effects during a repair run.
 * Each mutate records its undo op; backups are stored inside this
 * journal's directory so rollback stays self-contained.
 */
export class JournalCollector {
  readonly id: string
  readonly createdAt: string
  readonly profile: string
  readonly scope: string
  readonly entries: JournalEntry[] = []
  private backupCounter = 0
  private dir: string | null = null

  constructor(profile: string, scope: string) {
    this.id = 'doctor-' + timestamp()
    this.createdAt = new Date().toISOString()
    this.profile = profile
    this.scope = scope
  }

  private ensureDir(): string {
    if (this.dir === null) {
      this.dir = join(journalRoot(), this.id)
      mkdirSync(join(this.dir, 'backups'), { recursive: true })
    }
    return this.dir
  }

  /** Record a reversible file overwrite (save original, write new). */
  overwriteFile(path: string, newContent: string, kind: string, detail: string): void {
    const dir = this.ensureDir()
    const backupPath = join(dir, 'backups', 'backup-' + (this.backupCounter++))
    copyFileSync(path, backupPath)
    writeFileSync(path, newContent)
    this.entries.push({
      kind,
      detail,
      undo: { type: 'restore-file', detail: 'restore ' + path, path, backupPath },
    })
  }

  /** Record creating a new file (undo = delete it). */
  createFile(path: string, content: string, kind: string, detail: string): void {
    writeFileSync(path, content)
    this.entries.push({
      kind,
      detail,
      undo: { type: 'delete-file', detail: 'delete ' + path, path },
    })
  }

  /** Record creating a directory (undo = remove it, best-effort if empty). */
  createDir(path: string, kind: string, detail: string): void {
    mkdirSync(path, { recursive: true })
    this.entries.push({
      kind,
      detail,
      undo: { type: 'remove-dir', detail: 'remove ' + path + ' (if empty)', path },
    })
  }

  /** Record a non-reversible operation (system boundary: needs manual compensation). */
  manual(kind: string, detail: string): void {
    this.entries.push({
      kind,
      detail,
      undo: { type: 'manual', detail },
    })
  }

  /** Persist this journal to disk; returns the journal file path. */
  persist(): string | null {
    if (this.entries.length === 0) return null
    const dir = this.ensureDir()
    const journal: Journal = {
      id: this.id,
      createdAt: this.createdAt,
      profile: this.profile,
      scope: this.scope,
      entries: this.entries,
    }
    const file = join(dir, 'journal.json')
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(journal, null, 2))
    renameSync(tmp, file)
    return file
  }
}

/** List all persisted journals, newest first. */
export function listJournals(): Journal[] {
  const root = journalRoot()
  if (!existsSync(root)) return []
  const out: Journal[] = []
  for (const entry of readdirSync(root)) {
    const file = join(root, entry, 'journal.json')
    if (existsSync(file)) {
      try {
        out.push(JSON.parse(readFileSync(file, 'utf8')) as Journal)
      } catch {
        // skip corrupted journals
      }
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return out
}

/** Load one journal by id (or full path). */
export function loadJournal(id: string): Journal | null {
  // Accept full path or bare id.
  const file = id.endsWith('journal.json')
    ? id
    : join(journalRoot(), id, 'journal.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Journal
  } catch {
    return null
  }
}

/** Execute one undo operation. */
function applyUndo(op: UndoOp): 'undone' | 'manual' {
  switch (op.type) {
    case 'restore-file': {
      if (existsSync(op.backupPath)) {
        copyFileSync(op.backupPath, op.path)
        return 'undone'
      }
      return 'manual'
    }
    case 'delete-file': {
      if (existsSync(op.path)) {
        rmSync(op.path, { force: true })
      }
      return 'undone'
    }
    case 'remove-dir': {
      if (!existsSync(op.path)) return 'undone'
      try {
        // only remove if empty (never nuke a populated dir we did not own)
        if (readdirSync(op.path).length === 0) {
          rmdirSync(op.path)
          return 'undone'
        }
        // dir was repopulated since creation; needs manual attention
        return 'manual'
      } catch {
        return 'manual'
      }
    }
    case 'manual': {
      return 'manual'
    }
  }
}

/**
 * Roll back one journal: replay undo ops in reverse (LIFO).
 * Files that no longer have their backup are reported as manual.
 */
export function rollbackJournal(id: string): RollbackResult | null {
  const journal = loadJournal(id)
  if (journal === null) return null

  const steps: RollbackResult['steps'] = []
  let undoneCount = 0
  let failedCount = 0
  let manualCount = 0

  // LIFO: reverse registration order.
  for (let i = journal.entries.length - 1; i >= 0; i--) {
    const entry = journal.entries[i]
    try {
      const result = applyUndo(entry.undo)
      if (result === 'undone') {
        steps.push({ kind: entry.kind, detail: entry.detail, status: 'undone' })
        undoneCount++
      } else {
        steps.push({ kind: entry.kind, detail: entry.detail, status: 'manual' })
        manualCount++
      }
    } catch {
      steps.push({ kind: entry.kind, detail: entry.detail, status: 'failed' })
      failedCount++
    }
  }

  // Clean up the journal directory if fully replayed (keep backups if manual remained).
  const dir = join(journalRoot(), journal.id)
  if (manualCount === 0 && failedCount === 0 && existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }

  const summary = failedCount === 0
    ? 'Rollback complete' + (manualCount > 0 ? ' (' + manualCount + ' step(s) need manual compensation)' : '') + '.'
    : failedCount + ' rollback step(s) failed; review the log.'

  return { journalId: journal.id, undoneCount, failedCount, manualCount, steps, summary }
}

export { resolveDshHome }