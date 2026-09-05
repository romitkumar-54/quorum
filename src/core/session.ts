/**
 * THE LOOP
 *
 * One place where all four lanes meet, so the UI and the tests drive exactly the
 * same code path:
 *
 *   candidate speaks
 *     → lane A timestamps it
 *     → lane C folds it into the brief, raising claims and flags
 *     → lane B opens the floor and grants it to exactly one agent
 *     → that agent speaks, for the reason it was granted the floor
 *     → lane B re-checks mid-turn: does somebody else have grounds to cut in?
 */

import {
  type AgentId,
  type Brief,
  type ChannelMode,
  type Competency,
  type Flag,
  type FloorDecision,
  type TranscriptEvent,
} from '@/core/contracts'
import { BriefBuilder } from '@/core/brief'
import type { Analyzer } from '@/core/brief/analyzer'
import { Coordinator, DEFAULT_CONFIG, type CoordinatorConfig } from '@/core/coordinator'
import { computeMetrics, type Metrics } from '@/core/metrics'
import { SessionClock, TranscriptLog, estimateDuration } from '@/core/transcript'
import { ScriptedGenerator, type QuestionGenerator } from '@/agents'
import type { FloorPicker } from '@/agents/floor'
import type { Assessment } from '@/core/brief'

export interface SessionStep {
  candidateEvent: TranscriptEvent
  brief: Brief
  /** In order: the grant, then an interrupt if one was justified. */
  decisions: FloorDecision[]
  /** What the agents actually said, in order. */
  utterances: TranscriptEvent[]
}

export interface SessionOptions {
  mode?: ChannelMode
  analyzer?: Analyzer
  generator?: QuestionGenerator
  /** Names who should take the floor. A preference — the coordinator still decides. */
  floor?: FloorPicker
  config?: CoordinatorConfig
  /**
   * How long the coordinator takes to decide once silence is detected, in ms.
   * Real in the browser; fixed in tests so latency assertions are deterministic.
   */
  decisionLatency?: () => number
  /** How long an agent speaks before the coordinator re-checks for interrupts. */
  holdBeforeRecheck?: () => number
}

/** Comfortably above MIN_HOLD_MS, so a justified interrupt is not a false one. */
const DEFAULT_HOLD_MS = 1600

export class InterviewSession {
  readonly transcript: TranscriptLog
  readonly brief: BriefBuilder
  readonly coordinator: Coordinator

  private clock = new SessionClock()
  private generator: QuestionGenerator
  private floor?: FloorPicker
  private decisionLatency: () => number
  private holdBeforeRecheck: () => number
  /** Utterances that were cut off rather than finished. */
  private yielded = new Set<string>()

  constructor(private options: SessionOptions = {}) {
    this.transcript = new TranscriptLog(this.clock)
    this.brief = new BriefBuilder(options.analyzer)
    this.coordinator = new Coordinator(options.mode ?? 'coordinated', options.config ?? DEFAULT_CONFIG)
    this.generator = options.generator ?? new ScriptedGenerator()
    this.floor = options.floor
    // 40–90 ms of deliberation by default: fast enough to feel instant, honest
    // enough that the reported p50 is a real number.
    this.decisionLatency = options.decisionLatency ?? (() => 40 + Math.random() * 50)
    this.holdBeforeRecheck = options.holdBeforeRecheck ?? (() => DEFAULT_HOLD_MS)
  }

  get mode(): ChannelMode {
    return this.coordinator.mode
  }

  /**
   * Drive one candidate turn all the way through the panel.
   * `at` fixes the utterance start time; otherwise the session clock is used.
   */
  async candidateSays(text: string, at?: number): Promise<SessionStep> {
    const candidateEvent = this.transcript.append({ speaker: 'candidate', text, tStart: at })
    const { brief, newClaims } = await this.brief.ingest(candidateEvent)

    const leadCompetency: Competency | undefined = newClaims[0]?.competency
    const tSilenceDetected = candidateEvent.tEnd
    const decisions: FloorDecision[] = []
    const utterances: TranscriptEvent[] = []

    // The model nominates; the coordinator decides whether that is allowed.
    const nomination = this.floor
      ? await this.floor.pick({
          brief,
          transcript: this.transcript.all(),
          recentSpeakers: this.recentSpeakers(),
        })
      : null

    const grant = this.coordinator.openFloor(
      {
        brief,
        leadCompetency,
        tSilenceDetected,
        tNow: tSilenceDetected + this.decisionLatency(),
      },
      nomination?.agent ?? null,
      nomination?.reason,
    )
    decisions.push(grant)

    // ── Naive mode: everyone who bid is now talking over everyone else ────────
    if (grant.kind === 'collision' && grant.collidedWith) {
      // Nothing lands when three people speak at once, so the flags they were
      // each reacting to stay open — and the panel collides again next turn.
      //
      // The lines are written in parallel because three sequential model calls
      // would put the panel a full turn behind. They are recorded afterwards,
      // in bid order, so the transcript never depends on who answered first.
      const lines = await Promise.all(
        grant.collidedWith.map((agent) => {
          const backing = grant.bids.find((b) => b.agent === agent)?.backedBy ?? []
          return this.compose(agent, grant, backing, false)
        }),
      )
      for (const [index, agent] of grant.collidedWith.entries()) {
        utterances.push(this.append(agent, lines[index], grant.tDecision))
      }
      return { candidateEvent, brief: this.brief.current(), decisions, utterances }
    }

    if (!grant.grantedTo) {
      return { candidateEvent, brief: this.brief.current(), decisions, utterances }
    }

    const holder = await this.speak(grant.grantedTo, grant, grant.tDecision, this.coordinator.justification())
    utterances.push(holder)

    // ── Mid-turn: has somebody else got grounds to cut in? ───────────────────
    const tRecheck = grant.tDecision + this.holdBeforeRecheck()
    const interrupt = this.coordinator.considerInterrupt({
      brief: this.brief.current(),
      leadCompetency,
      tSilenceDetected,
      tNow: tRecheck,
    })

    if (interrupt?.grantedTo) {
      // The holder was cut off mid-sentence. Its utterance ends where the
      // interrupt landed, which is what the transcript should show.
      holder.tEnd = tRecheck
      this.yielded.add(holder.id)
      decisions.push(interrupt)
      utterances.push(await this.speak(interrupt.grantedTo, interrupt, tRecheck, this.coordinator.justification()))
    }

    this.coordinator.release()
    return { candidateEvent, brief: this.brief.current(), decisions, utterances }
  }

  metrics(): Metrics {
    return computeMetrics(this.coordinator.log())
  }

  /** Who has held the floor recently, oldest first. Context for the coordinator. */
  private recentSpeakers(): AgentId[] {
    return this.transcript
      .all()
      .filter((e) => e.speaker !== 'candidate')
      .slice(-4)
      .map((e) => e.speaker as AgentId)
  }

  /** Ids of utterances that ended because somebody cut in. */
  yieldedEventIds(): ReadonlySet<string> {
    return this.yielded
  }

  assessment(): Assessment {
    return this.brief.assessment()
  }

  setMode(mode: ChannelMode): void {
    this.coordinator.mode = mode
  }

  /**
   * Swap the brain. Used once at startup when the key probe answers, and by the
   * rehearsed demo to force the deterministic panel for its duration.
   */
  setGenerator(generator: QuestionGenerator): void {
    this.generator = generator
  }

  reset(mode: ChannelMode = this.coordinator.mode): void {
    this.transcript.clear()
    this.brief.reset()
    this.coordinator.reset(mode)
    this.yielded.clear()
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * An agent takes the floor. The flags it was granted the floor for are marked
   * addressed first, so no two agents challenge the same thing — unless nothing
   * was actually heard, which is what `addressFlags: false` is for.
   */
  private async compose(
    agent: AgentId,
    decision: FloorDecision,
    flagIds: string[],
    addressFlags = true,
  ): Promise<string> {
    const justifiedBy = this.flagsById(flagIds)
    if (addressFlags) this.brief.markAddressed(justifiedBy.map((f) => f.id))

    return this.generator.next({
      agent,
      brief: this.brief.current(),
      decision,
      justifiedBy,
      transcript: this.transcript.all(),
    })
  }

  /** Record a line. Synchronous, so transcript order never follows resolution order. */
  private append(agent: AgentId, text: string, at: number): TranscriptEvent {
    return this.transcript.append({
      speaker: agent,
      text,
      tStart: at,
      tEnd: at + estimateDuration(text),
    })
  }

  private async speak(
    agent: AgentId,
    decision: FloorDecision,
    at: number,
    flagIds: string[],
    addressFlags = true,
  ): Promise<TranscriptEvent> {
    return this.append(agent, await this.compose(agent, decision, flagIds, addressFlags), at)
  }

  /**
   * Resolve flag ids, preserving the order the coordinator ranked them in —
   * most urgent first — so the agent speaks to the flag it actually won on.
   */
  private flagsById(ids: string[]): Flag[] {
    if (ids.length === 0) return []
    const byId = new Map(this.brief.current().flags.map((f) => [f.id, f]))
    return ids.map((id) => byId.get(id)).filter((f): f is Flag => f !== undefined)
  }
}
