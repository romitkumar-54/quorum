/**
 * LANE C — Analysis rules
 *
 * Turns a raw utterance into claims and flags. The rules here are deterministic
 * on purpose: they run with no API key, they are fast enough to sit in the live
 * loop, and every flag they raise carries the evidence that produced it.
 *
 * `Analyzer` is the seam. `RuleAnalyzer` is today's implementation; an
 * LLM-backed one implements the same interface and swaps in without touching
 * the coordinator, the transport or the UI.
 */

import type { Brief, Claim, Competency, Flag, TranscriptEvent } from '@/core/contracts'

export interface AnalysisResult {
  claims: Claim[]
  flags: Flag[]
}

export interface Analyzer {
  analyze(event: TranscriptEvent, brief: Brief): AnalysisResult
}

// ─────────────────────────────────────────────────────────────────────────────
// Signals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Named techniques and complexity notation — evidence the answer is concrete.
 * Complexity notation is matched separately because `O(1)` ends in `)`, and a
 * trailing `\b` after a non-word character can never match.
 */
const TECHNIQUE =
  /\b(?:hash\s?maps?|hash\s?tables?|dictionary|binary search|b-?tree|index(?:ed|ing|es)?|caches?|cached|memo(?:ised|ized)|queue|heap|graph|linear scan|constant time)\b|\bo\(\s*[^)]{1,16}\)/i

/**
 * A number with a unit, or a bare percentage — the shape of a measured claim.
 * `%` carries no trailing `\b` for the same reason as above.
 */
const QUANTITY =
  /\b\d+(?:\.\d+)?\s*(?:%|(?:percent|ms|milliseconds?|seconds?|secs?|x|times|k|m|users?|requests?|rps|qps)\b)/i

/** Intensifiers that sound like a result but measure nothing. */
const VAGUE_INTENSIFIER =
  /\b(a lot|lots|much|way|far|pretty|really|quite|significantly|substantially|considerably|massively|hugely|better|faster|quicker|smoother|improved|optimi[sz]ed|more efficient)\b/i

/** Language about people the work affected. */
const IMPACT_LANGUAGE =
  /\b(users?|customers?|clients?|people|business|revenue|retention|adoption|conversion|experience|for everyone)\b/i

/** Language about how the work was built. */
const ALGORITHM_LANGUAGE =
  /\b(look-?ups?|scan(?:ning)?|complexity|algorithm|data structure|implement(?:ed|ation)?|query|queries|latency|throughput|performance)\b/i

/**
 * Topics where two answers can contradict each other. A claim is tagged with a
 * topic and a normalised stance; two claims on one topic with different stances
 * cannot both be true.
 */
const TOPIC_RULES: { topic: string; stance: string; match: RegExp }[] = [
  {
    topic: 'rollout',
    stance: 'full',
    match: /\b(everyone|all (?:the )?users|all customers|100\s*%|day one|straight to (?:prod|production)|whole user base|big bang)\b/i,
  },
  {
    topic: 'rollout',
    stance: 'staged',
    match: /\b(\d+(?:\.\d+)?\s*%\s*(?:first|of|to)|canary|gradual(?:ly)?|staged|phased|pilot|ramp(?:ed)? up|behind a (?:flag|toggle)|feature flag)\b/i,
  },
  {
    topic: 'ownership',
    stance: 'solo',
    match: /\b(i (?:built|wrote|designed|shipped|did)|on my own|by myself|alone)\b/i,
  },
  {
    topic: 'ownership',
    stance: 'team',
    match: /\b(we (?:built|wrote|designed|shipped|did)|the team|together|my team)\b/i,
  },
  {
    topic: 'testing',
    stance: 'tested',
    match: /\b(unit tests?|integration tests?|test coverage|we tested|load test)\b/i,
  },
  {
    topic: 'testing',
    stance: 'untested',
    match: /\b(no tests?|didn'?t (?:have time to )?test|skipped (?:the )?tests?|manually verified only)\b/i,
  },
]

let seq = 0
const nextId = (prefix: string) => `${prefix}-${(++seq).toString(36)}`

/** Reset id counters. Tests only. */
export function __resetAnalyzerIds(): void {
  seq = 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule analyzer
// ─────────────────────────────────────────────────────────────────────────────

export class RuleAnalyzer implements Analyzer {
  analyze(event: TranscriptEvent, brief: Brief): AnalysisResult {
    // Only the candidate makes claims. Interviewer speech is not evidence.
    if (event.speaker !== 'candidate' || !event.final) {
      return { claims: [], flags: [] }
    }

    const claims: Claim[] = []
    const flags: Flag[] = []

    // One utterance can carry several claims — "I used a hash map, so lookups
    // are O(1). It made things a lot faster for users." is a solid technical
    // claim followed by an unquantified impact claim, and the panel needs to
    // see them as two separate things.
    //
    // `known` grows as we go, so a candidate can contradict themselves inside a
    // single breath and still get caught.
    let known: Claim[] = brief.claims

    for (const sentence of splitSentences(event.text)) {
      const specific = TECHNIQUE.test(sentence) || QUANTITY.test(sentence)
      const competency = classify(sentence)
      const { topic, stance } = detectTopic(sentence)

      const claim: Claim = {
        id: nextId('claim'),
        text: sentence,
        sourceEventId: event.id,
        tStart: event.tStart,
        competency,
        topic,
        stance,
        specific,
      }
      claims.push(claim)

      const evidence = [{ eventId: event.id, t: event.tStart, quote: sentence }]

      // ── Requirement 8a — vague answers ────────────────────────────────────
      // Sounds like a result, measures nothing.
      if (!specific && VAGUE_INTENSIFIER.test(sentence)) {
        flags.push({
          id: nextId('flag'),
          kind: 'vague',
          competency,
          evidence,
          note: `No measurement behind "${firstMatch(sentence, VAGUE_INTENSIFIER)}".`,
          raisedAtTurn: brief.turn,
          addressed: false,
        })
      }

      // ── The Product interviewer's whole reason to exist ────────────────────
      // Impact asserted, never quantified.
      if (competency === 'impact' && !specific) {
        flags.push({
          id: nextId('flag'),
          kind: 'unchallenged_impact',
          competency,
          evidence,
          note: 'Claims user impact without naming who benefited or by how much.',
          raisedAtTurn: brief.turn,
          addressed: false,
        })
      }

      // ── Requirement 8b — contradictory answers ────────────────────────────
      // Cross-check against everything already known, including earlier
      // sentences of this same utterance.
      if (topic && stance) {
        const conflict = known.find((c) => c.topic === topic && c.stance && c.stance !== stance)
        if (conflict) {
          flags.push({
            id: nextId('flag'),
            kind: 'contradiction',
            competency,
            evidence: [
              { eventId: conflict.sourceEventId, t: conflict.tStart, quote: conflict.text },
              ...evidence,
            ],
            note: `On ${topic}: "${conflict.stance}" earlier, "${stance}" now. Both cannot be true.`,
            raisedAtTurn: brief.turn,
            addressed: false,
          })
        }
      }

      known = [...known, claim]
    }

    return { claims, flags }
  }
}

/**
 * Split an utterance into sentences. Speech recognition rarely supplies
 * punctuation reliably, so a clause joined by " and then " or " but " counts as
 * a boundary too.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\s+(?:and then|but then)\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function classify(text: string): Competency {
  const impact = IMPACT_LANGUAGE.test(text)
  const algorithmic = ALGORITHM_LANGUAGE.test(text) || TECHNIQUE.test(text)

  // "It made things a lot faster for users" is impact language wearing a
  // performance costume — impact wins, because that is the claim being made.
  if (impact) return 'impact'
  if (algorithmic) return 'algorithms'
  return 'communication'
}

function detectTopic(text: string): { topic?: string; stance?: string } {
  for (const rule of TOPIC_RULES) {
    if (rule.match.test(text)) return { topic: rule.topic, stance: rule.stance }
  }
  return {}
}

function firstMatch(text: string, re: RegExp): string {
  return text.match(re)?.[0] ?? ''
}
