/**
 * MEASUREMENT
 *
 * No hackathon voice demo is ever measured. These four numbers are computed
 * from the coordinator's own decision log during a real run, and they are what
 * separates "our panel coordinates" from a claim on a slide.
 */

import type { FloorDecision } from '@/core/contracts'

/**
 * An agent that gets cut off before this has had no chance to make its point,
 * so an interrupt inside this window counts against us as a false interrupt.
 */
export const MIN_HOLD_MS = 1200

export interface Metrics {
  /** Candidate turns the panel responded to. */
  turns: number
  grants: number
  interrupts: number
  /** Two or more agents speaking at once. Only reachable with no coordinator. */
  collisions: number
  collisionRate: number
  /** Interrupts that cut the holder off mid-thought. */
  falseInterrupts: number
  falseInterruptRate: number
  /** Silence detected → floor granted, in ms. */
  latencyP50: number
  latencyP95: number
  latencySamples: number
}

export const EMPTY_METRICS: Metrics = {
  turns: 0,
  grants: 0,
  interrupts: 0,
  collisions: 0,
  collisionRate: 0,
  falseInterrupts: 0,
  falseInterruptRate: 0,
  latencyP50: 0,
  latencyP95: 0,
  latencySamples: 0,
}

export function computeMetrics(decisions: readonly FloorDecision[]): Metrics {
  const turns = new Set(decisions.map((d) => d.turn)).size
  const grants = decisions.filter((d) => d.kind === 'grant').length
  const interrupts = decisions.filter((d) => d.kind === 'interrupt').length
  const collisions = decisions.filter((d) => d.kind === 'collision').length

  // An interrupt is "false" when it landed before the previous speaker had time
  // to finish a thought.
  let falseInterrupts = 0
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i]
    if (d.kind !== 'interrupt') continue
    const previousFloor = findPrevious(decisions, i)
    if (previousFloor && d.tDecision - previousFloor.tDecision < MIN_HOLD_MS) falseInterrupts++
  }

  const latencies = decisions
    .filter((d) => d.kind === 'grant' || d.kind === 'interrupt' || d.kind === 'collision')
    .map((d) => d.latencyMs)

  return {
    turns,
    grants,
    interrupts,
    collisions,
    collisionRate: turns === 0 ? 0 : round3(collisions / turns),
    falseInterrupts,
    falseInterruptRate: interrupts === 0 ? 0 : round3(falseInterrupts / interrupts),
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    latencySamples: latencies.length,
  }
}

/** The most recent decision that actually put somebody on the floor. */
function findPrevious(decisions: readonly FloorDecision[], before: number): FloorDecision | undefined {
  for (let i = before - 1; i >= 0; i--) {
    const kind = decisions[i].kind
    if (kind === 'grant' || kind === 'interrupt') return decisions[i]
  }
  return undefined
}

/** Nearest-rank percentile. Small n, so no interpolation games. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))])
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
