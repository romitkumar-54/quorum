/**
 * QUORUM — FROZEN CONTRACTS
 * =========================
 *
 * These are the three data shapes the whole project agrees on. They were frozen
 * before any logic was written, so that all four lanes can build in parallel
 * against fakes of each other:
 *
 *   Lane A (Realtime)   emits TranscriptEvent  ──▶  Lane C
 *   Lane C (Brief)      owns  Brief            ──▶  Lanes B and D
 *   Lane B (Coordinator) emits FloorDecision   ──▶  Lanes A and D
 *   Lane D (Surface)    renders all three
 *
 * Nothing outside this file may redefine these shapes.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/** The three AI interviewers. Each joins the RTC channel with its own agent ID. */
export type AgentId = 'technical' | 'product' | 'behavioural'

export const AGENT_IDS: readonly AgentId[] = ['technical', 'product', 'behavioural']

/** Anyone who can produce audio in the channel. */
export type Speaker = 'candidate' | AgentId

/** What the panel scores the candidate on. One competency per interviewer. */
export type Competency = 'algorithms' | 'impact' | 'communication'

export const COMPETENCIES: readonly Competency[] = ['algorithms', 'impact', 'communication']

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 1 — TranscriptEvent   (Lane A emits → Lane C consumes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One utterance, captured with start and end timestamps.
 *
 * Timestamps are captured on the *very first* event, before anything reads
 * them. Requirement 9 (evidence-linked feedback) is cheap when the timestamps
 * are already there and brutal to retrofit when they are not.
 */
export interface TranscriptEvent {
  id: string
  speaker: Speaker
  text: string
  /** ms since session start */
  tStart: number
  /** ms since session start */
  tEnd: number
  /** false while speech recognition is still revising this utterance */
  final: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 2 — Brief   (Lane C owns → Lanes B and D read)
// ─────────────────────────────────────────────────────────────────────────────

/** A point back into the transcript, so every judgement can be traced to a moment. */
export interface Evidence {
  eventId: string
  /** ms since session start — the moment this was said */
  t: number
  quote: string
}

/** Something the candidate asserted, attributed to a competency. */
export interface Claim {
  id: string
  text: string
  sourceEventId: string
  tStart: number
  competency: Competency
  /**
   * Normalised stance on a topic, used for contradiction detection.
   * Two claims sharing a `topic` but disagreeing on `stance` contradict.
   */
  topic?: string
  stance?: string
  /** Did the candidate back this with a number, a unit, or a named technique? */
  specific: boolean
}

export type FlagKind =
  /** Claim with no measurable backing — "a lot faster", "much better". */
  | 'vague'
  /** Two claims that cannot both be true. */
  | 'contradiction'
  /** Candidate asserted user impact without ever quantifying it. */
  | 'unchallenged_impact'

export interface Flag {
  id: string
  kind: FlagKind
  /**
   * The area this flag falls in, taken from the claim that raised it. An
   * interviewer only challenges flags in its own area — so a hand-wavy answer
   * about customer impact belongs to Product, not to the engineer who was
   * perfectly satisfied by the algorithm.
   */
  competency: Competency
  evidence: Evidence[]
  note: string
  raisedAtTurn: number
  /** Set once an interviewer has actually challenged it on the floor. */
  addressed: boolean
}

/**
 * The one shared object. Built live from the transcript, read by every agent
 * before it speaks, and rendered at the end as the assessment.
 *
 * Six of the eleven track requirements fall out of this object:
 *   3 shared context · 4 dynamic follow-ups · 7 difficulty · 8 vague/contradictory
 *   9 evidence-linked feedback · 10 structured assessment
 */
export interface Brief {
  turn: number
  claims: Claim[]
  flags: Flag[]
  /** 1..5 — raised by specific answers, lowered by vague ones. */
  difficulty: number
  scores: Record<Competency, number>
}

export const EMPTY_BRIEF: Brief = {
  turn: 0,
  claims: [],
  flags: [],
  difficulty: 2,
  scores: { algorithms: 0, impact: 0, communication: 0 },
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 3 — FloorDecision   (Lane B emits → Lanes A and D consume)
// ─────────────────────────────────────────────────────────────────────────────

export type DecisionKind =
  /** Floor granted to exactly one agent after the candidate stopped speaking. */
  | 'grant'
  /**
   * An agent took the floor from another mid-turn, for a reason from the brief.
   * The agent that stood down is named in `yieldedBy`.
   */
  | 'interrupt'
  /** Nobody had anything worth saying. The floor stays with the candidate. */
  | 'hold'
  /** Two or more agents spoke at once. Only possible with no coordinator. */
  | 'collision'

/** One agent's request for the floor, with the reason it thinks it should speak. */
export interface Bid {
  agent: AgentId
  /** 0 = nothing to say. Higher wins. */
  score: number
  rationale: string
  /** Flags this bid is backed by. An empty list means the bid is fairness-only. */
  backedBy: string[]
}

export interface FloorDecision {
  id: string
  kind: DecisionKind
  grantedTo: AgentId | null
  /** Human-readable, rendered on screen. The judge sees *why* this agent spoke. */
  reason: string
  bids: Bid[]
  /** ms since session start */
  tDecision: number
  /** silence detected → floor granted. This is the number we report as p50/p95. */
  latencyMs: number
  turn: number
  /** For collisions: everyone who spoke at the same instant. */
  collidedWith?: AgentId[]
  /** For interrupts: who was cut off. */
  yieldedBy?: AgentId
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel configuration — the Agora semantics that matter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `naive` reproduces what happens with no coordinator: every agent subscribes to
 * the whole channel, all three hear the candidate stop at the same instant, and
 * all three speak. `coordinated` is the same channel with a coordinator.
 */
export type ChannelMode = 'naive' | 'coordinated'

export interface ChannelConfig {
  channelName: string
  /**
   * Agora's per-agent audio subscription. `'*'` means "hear everyone", which is
   * exactly what makes all three agents fire on the same silence.
   */
  remoteRtcUids: '*' | AgentId[]
  mode: ChannelMode
}

export const DEFAULT_CHANNEL: ChannelConfig = {
  channelName: 'interview-01',
  remoteRtcUids: '*',
  mode: 'coordinated',
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent profiles — role, voice and what each one cares about
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentProfile {
  id: AgentId
  displayName: string
  role: string
  /** The competency this interviewer scores. */
  owns: Competency
  /** Flag kinds this interviewer considers its business to challenge. */
  cares: FlagKind[]
  /** Tie-break weight when two agents bid the same. */
  priority: number
  /** Tailwind colour token used consistently across the UI. */
  accent: string
  /** Hints for picking a distinct Web Speech voice. */
  voice: { pitch: number; rate: number; prefer: string[] }
}

export const AGENTS: Record<AgentId, AgentProfile> = {
  technical: {
    id: 'technical',
    displayName: 'Technical',
    role: 'Senior engineer. Probes correctness, complexity and trade-offs.',
    owns: 'algorithms',
    cares: ['vague'],
    priority: 2,
    accent: '#4ea1ff',
    voice: { pitch: 0.85, rate: 1.02, prefer: ['Google UK English Male', 'Daniel', 'Microsoft Guy'] },
  },
  product: {
    id: 'product',
    displayName: 'Product',
    role: 'Product manager. Asks who the work helped and by how much.',
    owns: 'impact',
    cares: ['unchallenged_impact', 'vague'],
    priority: 3,
    accent: '#ff5f56',
    voice: { pitch: 1.15, rate: 1.0, prefer: ['Google US English', 'Samantha', 'Microsoft Aria'] },
  },
  behavioural: {
    id: 'behavioural',
    displayName: 'Behavioural',
    role: 'Hiring manager. Tests consistency and how the candidate holds up under push.',
    owns: 'communication',
    cares: ['contradiction'],
    priority: 1,
    accent: '#f0b429',
    voice: { pitch: 1.0, rate: 0.94, prefer: ['Google UK English Female', 'Karen', 'Microsoft Sonia'] },
  },
}
