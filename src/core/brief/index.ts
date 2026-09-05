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
  async ingest(
    event: TranscriptEvent,
  ): Promise<{ brief: Brief; newClaims: Claim[]; newFlags: Flag[]; lead?: Competency }> {
    const { claims, flags, lead } = await this.analyzer.analyze(event, this.brief)

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
    return { brief: next, newClaims: claims, newFlags: flags, lead }
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
    const claims = relevantClaims(brief, competency)
    if (!claims.length) { out[competency] = 0; continue }
    // Score answers, not keyword counts. Repeating a technique or breaking an
    // answer into many sentences cannot accumulate points.
    const answers = new Map<string, string[]>()
    for (const claim of claims) answers.set(claim.sourceEventId, [...(answers.get(claim.sourceEventId) ?? []), claim.text])
    const unique = [...new Set([...answers.values()].map(parts => parts.join(' ').toLowerCase()))]
    const values = unique.map(text => rubric(competency, text))
    out[competency] = clamp(Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10, SCORE_MIN, SCORE_MAX)
  }

  return out
}

function relevantClaims(brief: Brief, competency: Competency): Claim[] {
  return brief.claims.filter(c => c.competency === competency && c.relevant !== false)
}

/** An explicit evidence rubric, not a judgement of correctness or hiring fitness. */
function rubric(competency: Competency, text: string): number {
  if (/\b(?:don't know|do not know|no idea|cannot answer)\b/.test(text)) return 1
  const reasoning = /\b(?:because|therefore|so that|trade.?off|instead|whereas|compared|however|to avoid|so )\b/.test(text)
  const measured = /\d+(?:\.\d+)?\s*(?:%|percent|ms|seconds?|users?|requests?|revenue|dollars?)/.test(text)
  const detail = text.split(/\s+/).length >= 18
  if (competency === 'algorithms') {
    const method = /hash|cache|index|binary|queue|graph|heap|complexity|o\(|constant time|database|algorithm/.test(text)
    const validation = /\b(?:tested|tests|benchmark|profil(?:ed|ing)|measured|edge case|load test)\b/.test(text)
    return 2 + Number(method && detail) + Number(reasoning) + Number(validation && (measured || detail))
  }
  if (competency === 'impact') {
    const comparison = /\b(?:from|baseline|before|after|control|experiment|a\/b|compared)\b/.test(text)
    return 2 + Number(measured) + Number(reasoning && detail) + Number(measured && comparison)
  }
  const action = /\b(?:explained|listened|asked|discussed|agreed|resolved|negotiated|shared|documented|presented)\b/.test(text)
  const reflection = /\b(?:learned|learnt|next time|feedback|realised|realized|changed|result|resolved)\b/.test(text)
  return 2 + Number(action && detail) + Number(reasoning) + Number(reflection && detail)
}

// ─────────────────────────────────────────────────────────────────────────────
// Assessment — the panel is allowed to disagree
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentVerdict {
  agent: AgentId
  competency: Competency
  score: number | null
  verdict: string
  evidence: Evidence[]
}

export interface Assessment {
  perAgent: AgentVerdict[]
  final: number | null
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
      score: relevantClaims(brief, competency).length ? brief.scores[competency] : null,
      verdict: verdictFor(competency, brief),
      evidence: evidenceFor(competency, brief),
    }
  })

  const values = perAgent.map((v) => v.score).filter((v): v is number => v !== null)
  const spread = values.length ? Math.round((Math.max(...values) - Math.min(...values)) * 10) / 10 : 0
  const split = spread >= SPLIT_THRESHOLD
  const final = values.length === COMPETENCIES.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : null

  return {
    perAgent,
    final,
    split,
    spread,
    openFlags: brief.flags.filter((f) => !f.addressed),
    summary: `Provisional evidence review of ${brief.turn} answer${brief.turn === 1 ? '' : 's'}; ${values.length} of 3 areas assessed. Scores reflect specificity, reasoning and supporting detail in your answers. This rules-based rubric does not verify technical correctness. ${values.length < 3 ? 'More evidence is needed before an overall score can be reported.' : split ? `Evidence scores differ by ${spread} points across areas.` : 'Review the supporting quotes and gaps below.'}`,
  }
}

function verdictFor(competency: Competency, brief: Brief): string {
  const claims = relevantClaims(brief, competency)
  if (!claims.length) return 'Not assessed — no relevant answer captured.'
  const count = new Set(claims.map(c => c.sourceEventId)).size
  const guidance = {
    algorithms: 'Explain the approach, trade-offs, and how you tested it. Naming a technique alone does not establish correctness.',
    impact: 'Identify who benefited, give a before/after measurement, and explain how you attributed the result.',
    communication: 'Describe your own action, why you took it, the outcome, and what you learned.',
  }
  return `${count} relevant answer${count === 1 ? '' : 's'} reviewed; evidence score ${brief.scores[competency]}/5. ${guidance[competency]}`
}

/** Requirement 9 — every judgement links back to the moment it came from. */
function evidenceFor(competency: Competency, brief: Brief): Evidence[] {
  const fromClaims: Evidence[] = brief.claims
    .filter((c) => c.competency === competency && c.relevant !== false)
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
