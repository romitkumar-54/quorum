/**
 * LANE C — The shared brief
 *
 * One object, built live from the timestamped transcript, read by every agent
 * before it speaks and rendered at the end as the assessment. Six of the eleven
 * track requirements are this object rather than six separate features.
 */

import {
  AGENTS,
  COMPETENCIES,
  EMPTY_BRIEF,
  type AgentId,
  type Brief,
  type Claim,
  type Competency,
  type Evidence,
  type Flag,
  type TranscriptEvent,
} from '@/core/contracts'
import { RuleAnalyzer, type Analyzer } from '@/core/brief/analyzer'

export * from '@/core/brief/analyzer'

const DIFFICULTY_MIN = 1
const DIFFICULTY_MAX = 5
const SCORE_MIN = 1
const SCORE_MAX = 5
/** Every competency starts mid-band and moves only on evidence. */
const SCORE_BASE = 3

export class BriefBuilder {
  private brief: Brief

  constructor(private analyzer: Analyzer = new RuleAnalyzer()) {
    this.brief = structuredClone(EMPTY_BRIEF)
  }

  current(): Brief {
    return this.brief
  }

  /**
   * Fold one utterance into the brief. Returns what *this* utterance produced:
   * the claims decide which interviewer picks the thread up, and the flags are
   * what the coordinator bids on.
   */
  async ingest(event: TranscriptEvent): Promise<{ brief: Brief; newClaims: Claim[]; newFlags: Flag[] }> {
    const { claims, flags } = await this.analyzer.analyze(event, this.brief)

    const next: Brief = {
      turn: event.speaker === 'candidate' ? this.brief.turn + 1 : this.brief.turn,
      claims: [...this.brief.claims, ...claims],
      flags: [...this.brief.flags, ...flags],
      difficulty: this.brief.difficulty,
      scores: this.brief.scores,
    }

    // ── Requirement 7 — difficulty adjustment ────────────────────────────────
    // Difficulty tracks whether the candidate can be concrete, and nothing else.
    // Naming a technique or a number earns a harder question, even if another
    // sentence in the same breath was hand-wavy — that vagueness is handled by
    // the flag and the interviewer who challenges it, not by making the
    // questions easier. Only a turn with nothing concrete in it at all steps
    // back down. A contradiction is a consistency problem, not a level problem,
    // so it leaves difficulty alone.
    if (claims.length > 0) {
      const wasConcrete = claims.some((c) => c.specific)
      const wasHandWavy = flags.some((f) => f.kind === 'vague')
      if (wasConcrete) next.difficulty = clamp(next.difficulty + 1, DIFFICULTY_MIN, DIFFICULTY_MAX)
      else if (wasHandWavy) next.difficulty = clamp(next.difficulty - 1, DIFFICULTY_MIN, DIFFICULTY_MAX)
    }

    next.scores = score(next)
    this.brief = next
    return { brief: next, newClaims: claims, newFlags: flags }
  }

  /** Mark a flag as challenged on the floor, so nobody raises it twice. */
  markAddressed(flagIds: string[]): Brief {
    if (flagIds.length === 0) return this.brief
    const ids = new Set(flagIds)
    this.brief = {
      ...this.brief,
      flags: this.brief.flags.map((f) => (ids.has(f.id) ? { ...f, addressed: true } : f)),
    }
    return this.brief
  }

  /** Flags nobody has challenged yet — the coordinator's raw material. */
  openFlags(): Flag[] {
    return this.brief.flags.filter((f) => !f.addressed)
  }

  assessment(): Assessment {
    return assess(this.brief)
  }

  reset(): void {
    this.brief = structuredClone(EMPTY_BRIEF)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring — Requirement 10, structured final assessment
// ─────────────────────────────────────────────────────────────────────────────

function score(brief: Brief): Record<Competency, number> {
  const out = {} as Record<Competency, number>

  for (const competency of COMPETENCIES) {
    let value = SCORE_BASE

    if (competency === 'algorithms') {
      // Concrete technique named, complexity reasoned about.
      const specific = brief.claims.filter((c) => c.competency === 'algorithms' && c.specific).length
      value += Math.min(2, specific)
    }

    if (competency === 'impact') {
      // Asserted that it helped someone, never said who or by how much.
      value -= brief.flags.filter((f) => f.kind === 'unchallenged_impact').length
    }

    if (competency === 'communication') {
      value -= brief.flags.filter((f) => f.kind === 'contradiction').length
      // A contradiction resolved *towards* precision is still a correction the
      // candidate volunteered. It costs consistency but earns some credit back.
      if (hasSelfRevision(brief)) value += 1
    }

    out[competency] = clamp(value, SCORE_MIN, SCORE_MAX)
  }

  return out
}

/** Did a later claim contradict an earlier one by being *more* specific? */
function hasSelfRevision(brief: Brief): boolean {
  return brief.flags.some((f) => {
    if (f.kind !== 'contradiction' || f.evidence.length < 2) return false
    const [earlier, later] = f.evidence
    const earlierClaim = brief.claims.find((c) => c.sourceEventId === earlier.eventId)
    const laterClaim = brief.claims.find((c) => c.sourceEventId === later.eventId)
    return !!laterClaim?.specific && !earlierClaim?.specific
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Assessment — the panel is allowed to disagree
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentVerdict {
  agent: AgentId
  competency: Competency
  score: number
  verdict: string
  evidence: Evidence[]
}

export interface Assessment {
  perAgent: AgentVerdict[]
  final: number
  /** True when the panel does not agree with itself. This is the innovation beat. */
  split: boolean
  spread: number
  openFlags: Flag[]
  summary: string
}

/** A panel this far apart is reported as split rather than averaged away. */
const SPLIT_THRESHOLD = 2

export function assess(brief: Brief): Assessment {
  const perAgent: AgentVerdict[] = (Object.keys(AGENTS) as AgentId[]).map((id) => {
    const profile = AGENTS[id]
    const competency = profile.owns
    return {
      agent: id,
      competency,
      score: brief.scores[competency],
      verdict: verdictFor(competency, brief),
      evidence: evidenceFor(competency, brief),
    }
  })

  const values = perAgent.map((v) => v.score)
  const spread = Math.max(...values) - Math.min(...values)
  const split = spread >= SPLIT_THRESHOLD
  const final = Math.round(values.reduce((a, b) => a + b, 0) / values.length)

  return {
    perAgent,
    final,
    split,
    spread,
    openFlags: brief.flags.filter((f) => !f.addressed),
    summary: split
      ? `Panel split by ${spread} points. Reported as a disagreement, not an average.`
      : 'Panel agreed within one point.',
  }
}

function verdictFor(competency: Competency, brief: Brief): string {
  if (competency === 'algorithms') {
    const specific = brief.claims.filter((c) => c.competency === 'algorithms' && c.specific)
    return specific.length > 0 ? 'correct, efficient' : 'no concrete technique named'
  }

  if (competency === 'impact') {
    const unchallenged = brief.flags.filter((f) => f.kind === 'unchallenged_impact')
    return unchallenged.length > 0
      ? 'never named the user impact'
      : brief.claims.some((c) => c.competency === 'impact' && c.specific)
        ? 'impact quantified'
        : 'impact never discussed'
  }

  const contradiction = brief.flags.find((f) => f.kind === 'contradiction')
  if (contradiction) {
    const topic = brief.claims.find((c) => c.sourceEventId === contradiction.evidence[0]?.eventId)?.topic
    return `clear, but contradicted themselves on ${topic ?? 'their own account'}`
  }
  return 'consistent throughout'
}

/** Requirement 9 — every judgement links back to the moment it came from. */
function evidenceFor(competency: Competency, brief: Brief): Evidence[] {
  const fromClaims: Evidence[] = brief.claims
    .filter((c) => c.competency === competency)
    .map((c) => ({ eventId: c.sourceEventId, t: c.tStart, quote: c.text }))

  const relevantFlags: Record<Competency, Flag['kind'][]> = {
    algorithms: ['vague'],
    impact: ['unchallenged_impact'],
    communication: ['contradiction'],
  }

  const fromFlags = brief.flags
    .filter((f) => relevantFlags[competency].includes(f.kind))
    .flatMap((f) => f.evidence)

  // De-duplicate by the event each piece of evidence points at.
  const seen = new Set<string>()
  return [...fromClaims, ...fromFlags].filter((e) => {
    if (seen.has(e.eventId)) return false
    seen.add(e.eventId)
    return true
  })
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
