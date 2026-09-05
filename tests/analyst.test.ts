import { describe, expect, it, vi } from 'vitest'
import { LlmAnalyst } from '@/agents/analyst'
import { RuleAnalyzer } from '@/core/brief'
import { TranscriptLog } from '@/core/transcript'
import { EMPTY_BRIEF } from '@/core/contracts'

const said = (text: string) => new TranscriptLog().append({ speaker: 'candidate', text, tStart: 1000 })

/** The route answers with `{ text }`; the analyst has to find JSON inside it. */
const routeSays = (payload: unknown) =>
  new Response(JSON.stringify({ text: typeof payload === 'string' ? payload : JSON.stringify(payload) }), {
    status: 200,
  })

const analyst = (fetchImpl: typeof fetch) =>
  new LlmAnalyst({ fallback: new RuleAnalyzer(), fetchImpl, endpoint: 'http://x/api/interviewer' })

describe('the analyst reads a turn into the brief', () => {
  it('maps claims and flags out of a well-formed answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      routeSays({
        classification: 'on_topic',
        claims: [{ text: 'used a hash map', competency: 'algorithms', specific: true }],
        flags: [
          { kind: 'vague', competency: 'impact', note: 'no number given', quotes: ['a lot faster'] },
        ],
      }),
    )

    const result = await analyst(fetchImpl).analyze(said('I used a hash map, it got a lot faster'), EMPTY_BRIEF)

    expect(result.claims).toHaveLength(1)
    expect(result.claims[0].competency).toBe('algorithms')
    expect(result.flags).toHaveLength(1)
    expect(result.flags[0].kind).toBe('vague')
    expect(result.flags[0].evidence[0].quote).toBe('a lot faster')
  })

  it('survives the model wrapping its JSON in a markdown fence', async () => {
    const fenced = '```json\n{"classification":"on_topic","claims":[],"flags":[]}\n```'
    const fetchImpl = vi.fn().mockResolvedValue(routeSays(fenced))

    const result = await analyst(fetchImpl).analyze(said('anything'), EMPTY_BRIEF)

    expect(result.claims).toEqual([])
    expect(result.flags).toEqual([])
  })

  it('drops entries the contract does not allow rather than trusting them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      routeSays({
        classification: 'on_topic',
        claims: [{ text: 'ok', competency: 'not_a_competency', specific: true }],
        flags: [
          { kind: 'made_up_kind', competency: 'impact', note: 'x', quotes: ['y'] },
          { kind: 'evasion', competency: 'impact', note: 'dodged', quotes: ['rather not say'] },
        ],
      }),
    )

    const result = await analyst(fetchImpl).analyze(said('rather not say'), EMPTY_BRIEF)

    expect(result.claims).toHaveLength(0)
    expect(result.flags).toHaveLength(1)
    expect(result.flags[0].kind).toBe('evasion')
  })

  it('falls back to the rule analyser when the call fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'))
    const event = said('It cut p95 latency for users from 400ms to 90ms.')

    const live = await analyst(fetchImpl).analyze(event, EMPTY_BRIEF)
    const rules = await new RuleAnalyzer().analyze(event, EMPTY_BRIEF)

    expect(live.claims.map((c) => c.text)).toEqual(rules.claims.map((c) => c.text))
  })

  it('falls back when the model returns something that is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(routeSays('I think the candidate did well!'))
    const event = said('I used a hash map so lookups are O(1).')

    const live = await analyst(fetchImpl).analyze(event, EMPTY_BRIEF)
    const rules = await new RuleAnalyzer().analyze(event, EMPTY_BRIEF)

    expect(live.claims.map((c) => c.text)).toEqual(rules.claims.map((c) => c.text))
  })
})
