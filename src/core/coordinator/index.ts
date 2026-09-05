/**
 * LANE B — The coordinator
 *
 * Three agents sit in one RTC channel with `remote_rtc_uids: "*"`, so all three
 * hear the candidate stop at the same instant. Without something deciding, all
 * three speak. This module is that something.
 *
 * It does three things:
 *   1. detects that the floor is open (candidate silence),
 *   2. collects a bid from every agent, scored off the shared brief,
 *   3. grants the floor to exactly one of them, and logs why.
 *
 * Plus the harder case: an agent already holding the floor is cut off when a
 * higher-urgency flag belongs to somebody else. That is the interrupt path, and
 * it is the beat the demo is built around.
 *
 * INVARIANT: at most one agent holds the floor at any instant. Asserted in tests.
 */

import {
  AGENTS,
  AGENT_IDS,
  type AgentId,
  type Bid,
  type Brief,
  type ChannelMode,
  type Competency,
  type FloorDecision,
  type Flag,
  type FlagKind,
} from '@/core/contracts'

export interface CoordinatorConfig {
  /** How long the candidate must be quiet before the floor is considered open. */
  silenceThresholdMs: number
  /** An agent below this has nothing worth saying. */
  minBidToSpeak: number
  /** Open-flag urgency at or above this justifies cutting somebody off. */
  interruptThreshold: number
  /** Weight on "this agent has not spoken in a while". */
  fairnessWeight: number
  /** Cap on the fairness bonus, so politeness never outranks substance. */
  fairnessCap: number
}

export const DEFAULT_CONFIG: CoordinatorConfig = {
  silenceThresholdMs: 600,
  minBidToSpeak: 1,
  interruptThreshold: 4,
  fairnessWeight: 0.5,
  fairnessCap: 2,
}

/** How badly each kind of open flag needs somebody to challenge it. */
const FLAG_URGENCY: Record<FlagKind, number> = {
  unchallenged_impact: 5,
  contradiction: 5,
  // Dodging a direct question is as telling as contradicting yourself, and
  // leaving the interview entirely has to be answered before anything else.
  evasion: 5,
  off_topic: 6,
  vague: 2,
}

/**
 * Urgency of a kind the table has not heard of.
 *
 * The analyst is validated, but a flag kind arriving from a model is still
 * outside data. Without this, one unknown kind turned every bid into NaN and
 * the floor went to an arbitrary agent — silently, because NaN sorts without
 * complaining.
 */
const UNKNOWN_URGENCY = 3
const urgencyOf = (kind: FlagKind): number => FLAG_URGENCY[kind] ?? UNKNOWN_URGENCY

/**
 * Weight on "the candidate just said something in my area". This is deliberately
 * the largest term at grant time: the panel follows the conversation rather than
 * jumping straight to whoever is most annoyed.
 */
const RELEVANCE_WEIGHT = 4
/** Every agent always has a next question ready at the current difficulty. */
const BASELINE = 1
/**
 * Flags matter at grant time too, but less than relevance — otherwise the panel
 * would never let a topic finish. At interrupt time they are read at full weight.
 */
const FLAG_WEIGHT_AT_GRANT = 0.4

export interface TurnContext {
  brief: Brief
  /**
   * The competency of the first claim in the candidate's most recent turn — what
   * they actually opened with. Drives which interviewer picks the thread up.
   */
  leadCompetency?: Competency
  /** ms since session start, when the candidate went quiet. */
  tSilenceDetected: number
  /** ms since session start, now. */
  tNow: number
}

let seq = 0
const nextId = () => `dec-${(++seq).toString(36)}`

/** Reset id counters. Tests only. */
export function __resetDecisionIds(): void {
  seq = 0
}

export class Coordinator {
  private floorHolder: AgentId | null = null
  private turnLastSpoke: Record<AgentId, number> = { technical: -1, product: -1, behavioural: -1 }
  private decisions: FloorDecision[] = []
  /** Flags each grant/interrupt was justified by, so we can mark them addressed. */
  private lastJustification: string[] = []

  constructor(
    public mode: ChannelMode = 'coordinated',
    private config: CoordinatorConfig = DEFAULT_CONFIG,
  ) {}

  holder(): AgentId | null {
    return this.floorHolder
  }

  log(): readonly FloorDecision[] {
    return this.decisions
  }

  /** Flag ids the most recent decision was backed by. */
  justification(): string[] {
    return this.lastJustification
  }

  /**
   * The candidate stopped speaking. In `coordinated` mode exactly one agent gets
   * the floor. In `naive` mode every agent with something to say speaks — which
   * is the collision this whole project exists to prevent.
   */
  openFloor(ctx: TurnContext): FloorDecision {
    const bids = this.collectBids(ctx, FLAG_WEIGHT_AT_GRANT)
    const eligible = bids.filter((b) => b.score >= this.config.minBidToSpeak)
    const latencyMs = Math.max(0, ctx.tNow - ctx.tSilenceDetected)

    // ── Naive mode: nothing decides, so everyone who wants the floor takes it ──
    if (this.mode === 'naive') {
      if (eligible.length > 1) {
        const speakers = eligible.map((b) => b.agent)
        this.floorHolder = null // nobody actually holds it — they are talking over each other
        for (const a of speakers) this.turnLastSpoke[a] = ctx.brief.turn
        // Nothing was cleanly challenged, so no flag is considered addressed.
        // The flags stay open, and the panel collides again next turn.
        this.lastJustification = []
        return this.record({
          kind: 'collision',
          grantedTo: null,
          reason: `remote_rtc_uids: "*" and no coordinator — ${speakers.length} agents detected the same silence and spoke at once.`,
          bids,
          tDecision: ctx.tNow,
          latencyMs,
          turn: ctx.brief.turn,
          collidedWith: speakers,
        })
      }
      // Only one agent wanted it: naive mode happens to be fine this turn.
      const solo = eligible[0]
      if (!solo) return this.recordSilence(ctx, bids, latencyMs)
      this.floorHolder = solo.agent
      this.turnLastSpoke[solo.agent] = ctx.brief.turn
      this.lastJustification = solo.backedBy
      return this.record({
        kind: 'grant',
        grantedTo: solo.agent,
        reason: `Only ${AGENTS[solo.agent].displayName} bid this turn.`,
        bids,
        tDecision: ctx.tNow,
        latencyMs,
        turn: ctx.brief.turn,
      })
    }

    // ── Coordinated mode: exactly one winner ─────────────────────────────────
    if (eligible.length === 0) return this.recordSilence(ctx, bids, latencyMs)

    const winner = pickWinner(eligible)
    this.floorHolder = winner.agent
    this.turnLastSpoke[winner.agent] = ctx.brief.turn
    this.lastJustification = winner.backedBy

    return this.record({
      kind: 'grant',
      grantedTo: winner.agent,
      reason: winner.rationale,
      bids,
      tDecision: ctx.tNow,
      latencyMs,
      turn: ctx.brief.turn,
    })
  }

  /**
   * Called while an agent is mid-turn. If an open flag belonging to a *different*
   * agent is urgent enough, that agent cuts in and the holder yields.
   *
   * Returns null when nobody has grounds to interrupt — which is most of the time,
   * and is what keeps the false-interrupt rate low.
   */
  considerInterrupt(ctx: TurnContext): FloorDecision | null {
    if (this.mode !== 'coordinated' || !this.floorHolder) return null

    const holder = this.floorHolder
    const bids = this.collectBids(ctx, 1) // flags read at full weight mid-turn
    const challengers = bids.filter(
      (b) => b.agent !== holder && b.backedBy.length > 0 && b.score >= this.config.interruptThreshold,
    )
    if (challengers.length === 0) return null

    const winner = pickWinner(challengers)
    this.floorHolder = winner.agent
    this.turnLastSpoke[winner.agent] = ctx.brief.turn
    this.lastJustification = winner.backedBy

    return this.record({
      kind: 'interrupt',
      grantedTo: winner.agent,
      reason: `${AGENTS[winner.agent].displayName} cut in over ${AGENTS[holder].displayName}: ${winner.rationale}`,
      bids,
      tDecision: ctx.tNow,
      latencyMs: Math.max(0, ctx.tNow - ctx.tSilenceDetected),
      turn: ctx.brief.turn,
      yieldedBy: holder,
    })
  }

  /** The agent finished speaking and gave the floor back. */
  release(): void {
    this.floorHolder = null
  }

  reset(mode: ChannelMode = this.mode): void {
    this.mode = mode
    this.floorHolder = null
    this.turnLastSpoke = { technical: -1, product: -1, behavioural: -1 }
    this.decisions = []
    this.lastJustification = []
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Every agent scores itself against the shared brief. The rationale string is
   * built here, so what the screen shows is literally why the agent bid.
   */
  private collectBids(ctx: TurnContext, flagWeight: number): Bid[] {
    const open = ctx.brief.flags.filter((f) => !f.addressed)

    return AGENT_IDS.map((id) => {
      const profile = AGENTS[id]
      // An interviewer challenges flags of a kind it cares about *in its own
      // area*. A hand-wavy answer about customer impact is Product's business,
      // not the engineer's — the engineer was satisfied by the algorithm. This
      // is what makes the panel behave like a panel rather than a queue.
      // Most urgent first, so the flag that justifies the bid is also the one
      // the agent actually speaks to.
      const mine = open
        .filter((f) => profile.cares.includes(f.kind) && f.competency === profile.owns)
        .sort((a, b) => urgencyOf(b.kind) - urgencyOf(a.kind))
      const urgency = mine.reduce((sum, f) => sum + urgencyOf(f.kind), 0) * flagWeight
      const relevant = ctx.leadCompetency === profile.owns
      const relevance = relevant ? RELEVANCE_WEIGHT : 0
      const idleTurns = ctx.brief.turn - this.turnLastSpoke[id]
      const fairness = Math.min(this.config.fairnessCap, Math.max(0, idleTurns - 1) * this.config.fairnessWeight)

      const score = BASELINE + relevance + urgency + fairness + profile.priority * 0.01

      return {
        agent: id,
        score: round2(score),
        rationale: buildRationale(profile.displayName, relevant, mine, ctx.brief.difficulty),
        backedBy: mine.map((f) => f.id),
      }
    })
  }

  private recordSilence(ctx: TurnContext, bids: Bid[], latencyMs: number): FloorDecision {
    this.floorHolder = null
    this.lastJustification = []
    return this.record({
      kind: 'hold',
      grantedTo: null,
      reason: 'No agent had anything worth saying. Floor stays with the candidate.',
      bids,
      tDecision: ctx.tNow,
      latencyMs,
      turn: ctx.brief.turn,
    })
  }

  private record(d: Omit<FloorDecision, 'id'>): FloorDecision {
    const decision: FloorDecision = { id: nextId(), ...d }
    this.decisions.push(decision)
    return decision
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/** Highest score wins; ties break on the agent's standing priority. */
function pickWinner(bids: Bid[]): Bid {
  return [...bids].sort((a, b) => b.score - a.score || AGENTS[b.agent].priority - AGENTS[a.agent].priority)[0]
}

function buildRationale(name: string, relevant: boolean, flags: Flag[], difficulty: number): string {
  if (flags.length > 0) {
    const f = flags[0]
    const reason: Record<FlagKind, string> = {
      unchallenged_impact: 'impact claimed but never quantified',
      contradiction: 'the account contradicts itself',
      evasion: 'the question was answered around, not answered',
      off_topic: 'the candidate has left the interview',
      vague: 'the answer measures nothing',
    }
    return `${name} has an open flag — ${reason[f.kind] ?? 'something is unresolved'}.`
  }
  if (relevant) return `${name} owns what the candidate just raised.`
  return `${name} has a level-${difficulty} follow-up ready.`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
