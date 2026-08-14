/**
 * dsh-doctor runtime service: lives INSIDE the running DSH process.
 *
 * Demonstrates the "spatial composability" half of the paradigm by wiring
 * into Cordis's runtime primitives:
 *   - ctx.provide()   → exposes a stable `dsh-doctor` service (diagnose /
 *                       repair / rollback) to other plugins and the agent.
 *   - ctx.on()        → reactive coeffects: watches fiber lifecycle and reacts
 *                       when a plugin fails or a dependency disappears.
 *   - ctx.effect()    → reversible effects: every resource this service owns
 *                       is wrapped in a disposer, so unloading dsh-doctor
 *                       tears it all down with no leftovers.
 *
 * @module @jorinyang/dsh-doctor/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import { runDiagnostic } from './diagnose.ts'
import { runRepair, type RepairScope } from './repair.ts'
import { listJournals, rollbackJournal, type RollbackResult } from './journal.ts'

/** Custom events emitted by the doctor (reactive coeffects surface). */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'dsh-doctor/fiber-failed'(name: string, state: number): void
    'dsh-doctor/fiber-recovered'(name: string): void
  }
}

export interface DoctorConfig {
  defaultPort: number
}

/** Fiber lifecycle states (cordis FiberState enum, numeric values). */
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

/** A failure observation recorded by the reactive watcher. */
export interface FiberFailure {
  fiberName: string
  at: string
  state: number
}

/** Public API exposed as the `dsh-doctor` service. */
export interface DoctorService {
  /** Read-only live diagnostic. */
  diagnose(profile?: string, port?: number): ReturnType<typeof runDiagnostic>
  /** Repair with journaled reversible effects. */
  repair(profile?: string, port?: number, scope?: RepairScope): ReturnType<typeof runRepair>
  /** Roll back a repair journal (LIFO); defaults to the most recent. */
  rollback(id?: string): RollbackResult | null
  /** List persisted repair journals. */
  journals(): ReturnType<typeof listJournals>
  /** Reactive observations: plugin failures seen since this service loaded. */
  failures(): FiberFailure[]
}

/**
 * Install the runtime service on a Cordis context.
 * All resources are owned by the fiber via ctx.effect, so they auto-dispose
 * when dsh-doctor unloads (reversible effects).
 */
export function installRuntime(ctx: Context, config: DoctorConfig): void {
  const failures: FiberFailure[] = []

  // Reversible effect: the whole runtime surface is one labeled effect.
  // On unload, Cordis runs the returned disposer in reverse order.
  ctx.effect(() => {
    // ── Service: provide the stable dsh-doctor API ─────────
    const api: DoctorService = {
      diagnose: (profile, port) => runDiagnostic(profile?.trim() || 'web', port ?? config.defaultPort),
      repair: (profile, port, scope) => runRepair(profile?.trim() || 'web', port ?? config.defaultPort, scope ?? 'safe'),
      rollback: (id) => {
        if (id) return rollbackJournal(id)
        const all = listJournals()
        return all.length > 0 ? rollbackJournal(all[0].id) : null
      },
      journals: () => listJournals(),
      failures: () => failures.slice(),
    }

    // ctx.provide registers the service; it unregisters on disposer.
    const disposeService = ctx.provide('dsh-doctor', api)

    // ── Reactive coeffects: watch fiber lifecycle ──────────
    // When a plugin fiber fails, record it and emit a reactive event so
    // other plugins can respond without polling.
    const offStatus = ctx.on('internal/status', (fiber: any, oldState: any) => {
      if (fiber.state === FIBER_FAILED) {
        failures.push({
          fiberName: fiber.name ?? 'unknown',
          at: new Date().toISOString(),
          state: fiber.state,
        })
        ctx.logger('dsh-doctor').warn('plugin fiber entered FAILED: ' + fiber.name)
        ctx.emit('dsh-doctor/fiber-failed', fiber.name, fiber.state)
      }
      if (fiber.state === FIBER_ACTIVE && oldState === FIBER_FAILED) {
        ctx.logger('dsh-doctor').info('plugin fiber recovered: ' + fiber.name)
        ctx.emit('dsh-doctor/fiber-recovered', fiber.name)
      }
    })

    // ── Disposer: reverse teardown (LIFO) ──────────────────
    return () => {
      offStatus()
      disposeService()
      failures.length = 0
    }
  }, 'dsh-doctor-runtime')
}