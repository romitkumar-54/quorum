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

import { AGENTS, type AnswerContext, type Brief, type Claim, type Competency, type Flag, type TranscriptEvent } from '@/core/contracts'

export interface AnalysisResult {
  claims: Claim[]
  flags: Flag[]
  /**
   * Which interviewer the candidate has just handed something to.
   *
   * **Undefined when the turn pointed nowhere** — "I studied computer science
   * at university" is biography, not a claim on anyone's territory. That is the
   * honest answer, and it matters: the coordinator gives the owner of the lead
   * a large relevance bonus, so naming one on a sentence that earned nobody's
   * attention is what let a single interviewer run an entire interview. With no
   * lead, fairness decides and the floor moves.
   */
  lead?: Competency
}

export interface Analyzer {
  analyze(event: TranscriptEvent, brief: Brief, context?: AnswerContext): Promise<AnalysisResult>
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

/**
 * The three vocabularies, one per interviewer.
 *
 * These decide who the candidate has just given something to talk about, so
 * they are matched by weight rather than by order: the sentence belongs to
 * whichever territory it points at hardest. All three carry `g` because what
 * matters is how many signals a sentence carries, not merely that it carries
 * one. They are only ever used with `String.match`, never `.test`, so the
 * global flag cannot leave a stale `lastIndex` behind.
 */

/** Language about the people the work affected. Product's territory. */
const IMPACT_LANGUAGE =
  /\b(users?|customers?|clients?|people|business|revenue|retention|adoption|conversion|engagement|churn|satisfaction|signups?|growth|impact|experience|for everyone)\b/gi

/** Language about how the work was built. Technical's territory. */
const ALGORITHM_LANGUAGE =
  /\b(look-?ups?|scan(?:ning)?|complexity|algorithms?|data structures?|implement(?:ed|ation)?|quer(?:y|ies)|latency|throughput|performance|back-?end|front-?end|databases?|schemas?|migrations?|apis?|endpoints?|servers?|services?|refactor(?:ed|ing)?|bugs?|deploy(?:ed|ment)?|architecture|concurrency|race condition|memory|threads?|pipeline|load)\b/gi

/**
 * Language about working with other people. Behavioural's territory.
 *
 * This vocabulary is the point of the whole change. `communication` used to be
 * the value returned when nothing else matched, which handed Behavioural the
 * full relevance weight on almost every ordinary sentence and left the other
 * two interviewers with nothing to bid on. Behavioural now has to earn a turn
 * on the same terms as everybody else.
 */
const COMMUNICATION_LANGUAGE =
  /\b(teams?|teammates?|colleagues?|managers?|mentor(?:ed|ing)?|stakeholders?|disagree(?:d|ment|ments)?|conflicts?|argued?|convince[ds]?|persuade[ds]?|explain(?:ed|ing)?|present(?:ed|ing|ation)?|communicat(?:e|ed|ing|ion)|feedback|pushback|deadlines?|pressure|blame[ds]?|apolog(?:y|ised|ized)|learn(?:ed|t|ing)?|taught|mistakes?|failures?|struggled?|collaborat(?:e|ed|ing|ion)|negotiat(?:e|ed|ing|ion)|escalat(?:e|ed|ing|ion)|onboard(?:ed|ing)?|culture|morale|standup|pair(?:ed|ing)?)\b/gi

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
    match: /\b(on my own|by myself|entirely alone|sole (?:author|developer)|nobody (?:else )?helped)\b/i,
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
  async analyze(event: TranscriptEvent, brief: Brief, context: AnswerContext = {}): Promise<AnalysisResult> {
    // Only the candidate makes claims. Interviewer speech is not evidence.
    if (event.speaker !== 'candidate' || !event.final) {
      return { claims: [], flags: [] }
    }

    const claims: Claim[] = []
    const flags: Flag[] = []
    const question = context.question
    const questionArea = question && question.speaker !== 'candidate' ? AGENTS[question.speaker].owns : undefined
    const behavior = detectBehavior(event.text)
    if (behavior) {
      flags.push({
        id: nextId('flag'), kind: behavior, competency: behavior === 'off_topic' ? 'communication' : questionArea ?? 'communication',
        evidence: [{ eventId: event.id, t: event.tStart, quote: event.text }],
        note: behavior === 'off_topic' ? 'The answer takes an explicit detour away from the interview; redirect to the pending question.' : 'The candidate explicitly avoids the question or attempts to change the interview rules; redirect without assuming intent.',
        raisedAtTurn: brief.turn + 1, addressed: false,
      })
    }
    /** The first sentence that actually pointed somewhere sets the lead. */
    let lead: Competency | undefined

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
      const classified = classify(sentence)
      const contextual = !classified.pointed && questionArea !== undefined && isContextualAnswer(sentence, question?.text ?? '')
      const competency = contextual ? questionArea! : classified.competency
      const pointed = !behavior && (classified.pointed || contextual)
      if (pointed && !lead) lead = competency
      const { topic, stance } = behavior ? {} : detectTopic(sentence)

      const claim: Claim = {
        id: nextId('claim'),
        text: sentence,
        sourceEventId: event.id,
        tStart: event.tStart,
        competency,
        topic,
        stance,
        specific,
        relevant: pointed,
      }
      claims.push(claim)

      const evidence = [{ eventId: event.id, t: event.tStart, quote: sentence }]

      // ── Requirement 8a — vague answers ────────────────────────────────────
      // Sounds like a result, measures nothing.
      if (!behavior && !specific && VAGUE_INTENSIFIER.test(sentence) && /\b(?:made|improved|faster|better|optimized|optimised|efficient|reduced|increased)\b/i.test(sentence)) {
        flags.push({
          id: nextId('flag'),
          kind: 'vague',
          competency,
          evidence,
          note: `No measurement behind "${firstMatch(sentence, VAGUE_INTENSIFIER)}".`,
          raisedAtTurn: brief.turn + 1,
          addressed: false,
        })
      }

      // ── The Product interviewer's whole reason to exist ────────────────────
      // Impact asserted, never quantified.
      if (pointed && competency === 'impact' && !QUANTITY.test(sentence) && /\b(?:improv\w*|increas\w*|reduc\w*|boost\w*|helped|better|faster|grew|saved)\b/i.test(sentence) && !/\b(?:no|not|never|didn't|did not|don't know)\b/i.test(sentence)) {
        flags.push({
          id: nextId('flag'),
          kind: 'unchallenged_impact',
          competency,
          evidence,
          note: 'Claims user impact without naming who benefited or by how much.',
          raisedAtTurn: brief.turn + 1,
          addressed: false,
        })
      }

      // ── Requirement 8b — contradictory answers ────────────────────────────
      // Cross-check against everything already known, including earlier
      // sentences of this same utterance.
      if (topic && stance) {
        const conflict = known.find((c) => c.topic === topic && c.stance && c.stance !== stance && !separateScope(c.text, sentence))
        if (conflict) {
          flags.push({
            id: nextId('flag'),
            kind: 'contradiction',
            competency,
            evidence: [
              { eventId: conflict.sourceEventId, t: conflict.tStart, quote: conflict.text },
              ...evidence,
            ],
            note: `Possible discrepancy on ${topic}: "${conflict.stance}" earlier, "${stance}" now. Ask whether these describe the same work and stage.`,
            raisedAtTurn: brief.turn + 1,
            addressed: false,
          })
        }
      }

      known = [...known, claim]
    }

    return { claims, flags, lead }
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

/** How many signals of one vocabulary a sentence carries. */
function weigh(text: string, vocabulary: RegExp): number {
  return text.match(vocabulary)?.length ?? 0
}

/**
 * Whose territory this sentence is in, and whether it is in anyone's.
 *
 * Weighed rather than ordered: a sentence goes to whichever interviewer it
 * points at hardest, so "I rewrote the lookup so the team could ship faster"
 * is not silently filed under whichever test happened to run first.
 *
 * `pointed: false` means no vocabulary matched at all. The claim is still
 * recorded — it is something the candidate said — but nobody is handed a
 * relevance bonus for it. Treating "nothing matched" as `communication` is the
 * bug this replaces: it made Behavioural the owner of all ordinary speech.
 */
function classify(text: string): { competency: Competency; pointed: boolean } {
  const weights: Record<Competency, number> = {
    impact: weigh(text, IMPACT_LANGUAGE),
    algorithms: weigh(text, ALGORITHM_LANGUAGE) + (TECHNIQUE.test(text) ? 1 : 0),
    communication: weigh(text, COMMUNICATION_LANGUAGE),
  }

  // Ties are broken in this order. Impact first keeps the older reading of "it
  // made things a lot faster for users" — impact language wearing a
  // performance costume is still an impact claim. Communication is last
  // precisely because it used to take everything by default.
  const order: Competency[] = ['impact', 'algorithms', 'communication']
  const best = order.reduce((winner, c) => (weights[c] > weights[winner] ? c : winner), order[0])

  if (weights[best] === 0) return { competency: 'communication', pointed: false }
  return { competency: best, pointed: true }
}

function detectTopic(text: string): { topic?: string; stance?: string } {
  if (/\b(?:no (?:unit |integration )?tests?|(?:didn't|did not) (?:(?:have time to |write |run )?(?:unit |integration )?)test\w*|skipped (?:the )?tests?)\b/i.test(text)) return { topic: 'testing', stance: 'untested' }
  if (/\b(?:not|never|didn't|did not)\b/i.test(text)) return {}
  for (const rule of TOPIC_RULES) {
    if (rule.match.test(text)) return { topic: rule.topic, stance: rule.stance }
  }
  return {}
}

/** High-confidence redirects only: silence, uncertainty and accent are not misconduct. */
export function detectBehavior(text: string): 'off_topic' | 'evasion' | null {
  const normalized = text.toLowerCase().replace(/[’‘]/g, "'")
  if (/\b(?:ignore|forget|override) (?:all |your |the |previous )*(?:instructions|rules|prompt)|\b(?:give|award) me (?:full marks|five|5|a perfect score)|\b(?:won't|will not|refuse to) answer|\b(?:skip|avoid) (?:this|that|the) question|\bnone of your business\b/.test(normalized)) return 'evasion'
  if (/\b(?:tell me (?:a joke|a story)|what(?:'s| is) (?:your name|the weather)|are you (?:an? )?(?:ai|robot)|who (?:built|made|created) you|let'?s talk about (?:football|cricket|movies|food|politics)|forget the interview)\b/.test(normalized)) return 'off_topic'
  // An obvious unrelated subject, with no work-related framing. A food-delivery
  // project or a story about teamwork in sport must remain a legitimate answer.
  if (/\b(?:pizza|biryani|cricket|football|horoscope|celebrity|movie|weather|girlfriend|boyfriend)\b/.test(normalized) && !/\b(?:project|built|work|team|customer|user|app|service|business|developed|designed|learned|example)\b/.test(normalized)) return 'off_topic'
  return null
}

function isContextualAnswer(text: string, question: string): boolean {
  if (/\b(?:don't know|do not know|no idea|not sure|cannot answer|can't remember|don't remember)\b/i.test(text)) return true
  if (QUANTITY.test(text) || /\b(?:because|instead|therefore|i (?:chose|checked|asked|listened|decided|tried|changed)|we (?:chose|checked|agreed))\b/i.test(text)) return true
  const terms = question.toLowerCase().match(/\b[a-z]{5,}\b/g) ?? []
  return terms.filter(t => !['about', 'which', 'would', 'could', 'question'].includes(t)).some(t => text.toLowerCase().includes(t))
}

function separateScope(earlier: string, later: string): boolean {
  return /\b(?:another|different|previous|earlier|next) (?:project|company|release|version)|\b(?:afterwards|subsequently|later|eventually|initially|before|after|then)\b/i.test(earlier + ' ' + later)
}

function firstMatch(text: string, re: RegExp): string {
  return text.match(re)?.[0] ?? ''
}
