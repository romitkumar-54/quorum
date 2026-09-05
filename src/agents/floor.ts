/**
 * Who should take the floor.
 *
 * A `FloorPicker` returns a preference. It never grants anything: `Coordinator`
 * decides whether that preference is allowed, and that split is the reason the
 * "exactly one interviewer speaks" invariant can be proved rather than hoped
 * for.
 *
 * Nothing implements this today. The picker that did ran a model in this
 * process against an external endpoint, and every model in the project is now
 * Agora-managed and runs inside an agent — so the nomination went with the
 * endpoint and the coordinator decides alone. The LLM did not leave the
 * project; it moved from the decision to the words.
 *
 * The seam stays because the split it describes is still the design, and
 * because `InterviewSession` accepts a picker when one exists. See the
 * 2026-09-06 entry in docs/DECISIONS.md.
 */

import type { AgentId, Brief, TranscriptEvent } from '@/core/contracts'

export interface FloorPick {
  /** Who should speak, or null to let the deterministic coordinator decide. */
  agent: AgentId | null
  reason: string
}

export interface FloorInput {
  brief: Brief
  transcript: readonly TranscriptEvent[]
  /** Who spoke on the last few turns, oldest first. Used to keep the panel moving. */
  recentSpeakers: readonly AgentId[]
}

export interface FloorPicker {
  pick(input: FloorInput): Promise<FloorPick>
}
