/**
 * The coordinator's judgement — the second of the three calls a turn makes.
 *
 * It reads the brief and names who should take the floor and why. It does not
 * grant anything: it returns a preference, and `Coordinator` decides whether
 * that preference is allowed. That split is deliberate. The model brings
 * judgement about substance — Product should take this because the candidate
 * dodged the impact question — while the invariant that exactly one
 * interviewer speaks stays in code, where it can be proved rather than hoped.
 *
 * Abstaining is always safe. A null pick hands the turn to the deterministic
 * coordinator, and so does every failure path.
 */

import { AGENTS, AGENT_IDS, type AgentId, type Brief, type TranscriptEvent } from '@/core/contracts'

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

export interface LlmFloorOptions {
  endpoint?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** How much conversation the coordinator sees. It needs the shape, not the detail. */
const WINDOW = 6

export class LlmFloor implements FloorPicker {
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor({ endpoint = '/api/interviewer', timeoutMs = 5000, fetchImpl = fetch }: LlmFloorOptions = {}) {
    this.endpoint = endpoint
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
  }

  async pick(input: FloorInput): Promise<FloorPick> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('floor decision timed out'))
      }, this.timeoutMs)
    })

    try {
      return await Promise.race([this.request(input, controller.signal), budget])
    } catch {
      // Abstain. The deterministic coordinator is a perfectly good answer.
      return { agent: null, reason: 'The coordinator did not answer in time.' }
    } finally {
      clearTimeout(timer)
    }
  }

  private async request(input: FloorInput, signal: AbortSignal): Promise<FloorPick> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: buildFloorMessages(input) }),
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const body = (await res.json()) as { text?: string }
    if (!body.text) throw new Error('the route returned nothing')

    const parsed = JSON.parse(unfence(body.text)) as { agent?: unknown; reason?: unknown }
    const agent = AGENT_IDS.includes(parsed.agent as AgentId) ? (parsed.agent as AgentId) : null
    return {
      agent,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'No reason given.',
    }
  }
}

function unfence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced ? fenced[1] : text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : body
}

function buildFloorMessages({ brief, transcript, recentSpeakers }: FloorInput) {
  const roster = AGENT_IDS.map((id) => `- ${id}: ${AGENTS[id].role} Owns "${AGENTS[id].owns}".`).join('\n')

  const open = brief.flags.filter((f) => !f.addressed)
  const flags = open.length
    ? open.map((f) => `- ${f.kind} (${f.competency}): ${f.note}`).join('\n')
    : '- none open'

  const recent = transcript
    .slice(-WINDOW)
    .map((e) => `${e.speaker}: ${e.text}`)
    .join('\n')

  return [
    {
      role: 'system' as const,
      content: [
        'You chair a three-person interview panel. You never speak to the candidate.',
        'After each answer you decide which interviewer should take the floor next.',
        '',
        'Answer as JSON and nothing else: {"agent":"technical|product|behavioural","reason":string}',
        '',
        'How to choose:',
        '- An open flag in an interviewer’s own area is the strongest reason to give them the floor.',
        '- Otherwise give it to whoever owns what the candidate just talked about.',
        '- Keep the panel moving. Do not let one interviewer run the whole interview.',
        '- If the candidate has left the subject or is questioning the panel, behavioural handles it.',
        '- The reason is one short sentence, and it is shown on screen. Write it for a reader.',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: [
        'THE PANEL',
        roster,
        '',
        'OPEN FLAGS',
        flags,
        '',
        `RECENTLY SPOKE: ${recentSpeakers.length ? recentSpeakers.join(', ') : 'nobody yet'}`,
        `DIFFICULTY: ${brief.difficulty}`,
        '',
        'CONVERSATION',
        recent,
        '',
        'Who takes the floor? JSON only.',
      ].join('\n'),
    },
  ]
}
