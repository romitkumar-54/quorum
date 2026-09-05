/**
 * The analyst — the first of the three calls a candidate turn makes.
 *
 * It reads what was just said against the brief and returns what changed:
 * claims worth remembering, flags worth challenging, and a judgement about
 * whether the candidate is still answering the question at all.
 *
 * Everything it returns is treated as outside data. The model is asked for a
 * narrow JSON shape and anything outside that shape is dropped rather than
 * trusted — an unrecognised flag kind reaching the coordinator once turned
 * every bid into NaN. On any failure the rule-based analyser takes over, so a
 * dead key degrades the brief rather than ending the interview.
 */

import {
  COMPETENCIES,
  FLAG_KINDS,
  type Brief,
  type Claim,
  type Competency,
  type Evidence,
  type Flag,
  type FlagKind,
  type TranscriptEvent,
} from '@/core/contracts'
import type { AnalysisResult, Analyzer } from '@/core/brief/analyzer'

export interface LlmAnalystOptions {
  fallback: Analyzer
  endpoint?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** What the candidate's turn was, as a whole. Drives the guardrails. */
type Classification = 'on_topic' | 'evasive' | 'off_topic' | 'question_to_panel'

interface RawClaim {
  text?: unknown
  competency?: unknown
  specific?: unknown
}

interface RawFlag {
  kind?: unknown
  competency?: unknown
  note?: unknown
  quotes?: unknown
}

interface RawAnalysis {
  classification?: unknown
  claims?: unknown
  flags?: unknown
}

let seq = 0
const nextId = (prefix: string) => `${prefix}-llm-${(++seq).toString(36)}`

const isCompetency = (v: unknown): v is Competency => COMPETENCIES.includes(v as Competency)
const isFlagKind = (v: unknown): v is FlagKind => FLAG_KINDS.includes(v as FlagKind)

export class LlmAnalyst implements Analyzer {
  private readonly fallback: Analyzer
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor({
    fallback,
    endpoint = '/api/interviewer',
    timeoutMs = 6000,
    fetchImpl = fetch,
  }: LlmAnalystOptions) {
    this.fallback = fallback
    this.endpoint = endpoint
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
  }

  async analyze(event: TranscriptEvent, brief: Brief): Promise<AnalysisResult> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('analyst timed out'))
      }, this.timeoutMs)
    })

    try {
      const raw = await Promise.race([this.request(event, brief, controller.signal), budget])
      return this.shape(raw, event, brief)
    } catch {
      return this.fallback.analyze(event, brief)
    } finally {
      clearTimeout(timer)
    }
  }

  private async request(event: TranscriptEvent, brief: Brief, signal: AbortSignal): Promise<RawAnalysis> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: buildAnalystMessages(event, brief) }),
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const body = (await res.json()) as { text?: string }
    if (!body.text) throw new Error('the route returned nothing')
    return JSON.parse(unfence(body.text)) as RawAnalysis
  }

  /** Outside data in, contract-shaped values out. Anything else is discarded. */
  private shape(raw: RawAnalysis, event: TranscriptEvent, brief: Brief): AnalysisResult {
    const claims: Claim[] = (Array.isArray(raw.claims) ? (raw.claims as RawClaim[]) : [])
      .filter((c) => typeof c.text === 'string' && c.text.trim() && isCompetency(c.competency))
      .map((c) => ({
        id: nextId('cl'),
        text: String(c.text).trim(),
        sourceEventId: event.id,
        tStart: event.tStart,
        competency: c.competency as Competency,
        specific: c.specific === true,
      }))

    const flags: Flag[] = (Array.isArray(raw.flags) ? (raw.flags as RawFlag[]) : [])
      .filter((f) => isFlagKind(f.kind) && isCompetency(f.competency))
      .map((f) => ({
        id: nextId('fl'),
        kind: f.kind as FlagKind,
        competency: f.competency as Competency,
        evidence: this.evidenceFor(f.quotes, event, brief),
        note: typeof f.note === 'string' ? f.note : 'raised by the analyst',
        raisedAtTurn: brief.turn,
        addressed: false,
      }))

    // The classification is the guardrail, so it has to survive a model that
    // labelled the turn correctly and then forgot to raise the matching flag.
    const classification = raw.classification as Classification
    const missing =
      (classification === 'off_topic' || classification === 'question_to_panel') &&
      !flags.some((f) => f.kind === 'off_topic')

    if (missing) {
      flags.push({
        id: nextId('fl'),
        kind: 'off_topic',
        competency: 'communication',
        evidence: [{ eventId: event.id, t: event.tStart, quote: event.text }],
        note:
          classification === 'question_to_panel'
            ? 'The candidate is interviewing the panel.'
            : 'The candidate has left the subject of the interview.',
        raisedAtTurn: brief.turn,
        addressed: false,
      })
    }

    return { claims, flags }
  }

  /**
   * Quotes become evidence. A quote from an earlier turn is matched back to the
   * claim that carried it, so a contradiction still cites both moments rather
   * than stamping everything with the time the contradiction was noticed.
   */
  private evidenceFor(quotes: unknown, event: TranscriptEvent, brief: Brief): Evidence[] {
    const list = Array.isArray(quotes) ? quotes.filter((q): q is string => typeof q === 'string') : []
    if (list.length === 0) return [{ eventId: event.id, t: event.tStart, quote: event.text }]

    return list.map((quote) => {
      const earlier = brief.claims.find((c) => c.text.includes(quote) || quote.includes(c.text))
      return earlier
        ? { eventId: earlier.sourceEventId, t: earlier.tStart, quote }
        : { eventId: event.id, t: event.tStart, quote }
    })
  }
}

/** Models like to gift-wrap JSON. Take it out of the box. */
function unfence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced ? fenced[1] : text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : body
}

function buildAnalystMessages(event: TranscriptEvent, brief: Brief) {
  const known = brief.claims.length
    ? brief.claims.map((c) => `- [${c.competency}] ${c.text}`).join('\n')
    : '- nothing yet'

  return [
    {
      role: 'system' as const,
      content: [
        'You are the note-taker for a technical interview panel. You never speak to the candidate.',
        'You read one answer and report what changed, as JSON and nothing else.',
        '',
        'Schema:',
        '{"classification":"on_topic|evasive|off_topic|question_to_panel",',
        ' "claims":[{"text":string,"competency":"algorithms|impact|communication","specific":boolean}],',
        ' "flags":[{"kind":"vague|contradiction|unchallenged_impact|evasion|off_topic",',
        '           "competency":"algorithms|impact|communication","note":string,"quotes":[string]}]}',
        '',
        'Rules:',
        '- "specific" is true only when the claim names a number, a unit, or a named technique.',
        '- "vague" is a claim that measures nothing. "unchallenged_impact" is impact asserted without a number.',
        '- "contradiction" needs two quotes: the earlier statement first, then the one that breaks it.',
        '- "evasion" is a direct question answered around rather than answered.',
        '- "off_topic" is leaving the subject of the interview, or turning a question back on the panel.',
        '- Quote the candidate exactly. Never invent a quote.',
        '- An ordinary, honest answer produces no flags. Do not manufacture them.',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: [
        'ALREADY IN THE BRIEF',
        known,
        '',
        'THE CANDIDATE JUST SAID:',
        `"${event.text}"`,
        '',
        'Report what changed. JSON only.',
      ].join('\n'),
    },
  ]
}
