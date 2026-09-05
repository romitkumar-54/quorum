import { beforeAll, describe, expect, it } from 'vitest'
import { InterviewSession } from '@/core/session'
import { DEMO_TRANSCRIPT } from '@/core/demo'
import { BriefBuilder } from '@/core/brief'
import { TranscriptLog } from '@/core/transcript'
import { computeMetrics, percentile } from '@/core/metrics'

const fixed = { decisionLatency: () => 50, holdBeforeRecheck: () => 1600 }

async function ingest(texts: string[]) {
  const log = new TranscriptLog()
  const builder = new BriefBuilder()
  let t = 0
  for (const text of texts) {
    t += 10_000
    await builder.ingest(log.append({ speaker: 'candidate', text, tStart: t }))
  }
  return builder
}

describe('claims and flags', () => {
  it('splits one utterance into separate claims', async () => {
    const brief = (await ingest([DEMO_TRANSCRIPT[0].text])).current()
    expect(brief.claims).toHaveLength(2)
    expect(brief.claims[0].competency).toBe('algorithms')
    expect(brief.claims[0].specific).toBe(true)
    expect(brief.claims[1].competency).toBe('impact')
    expect(brief.claims[1].specific).toBe(false)
  })

  it('flags impact asserted without a number', async () => {
    const brief = (await ingest([DEMO_TRANSCRIPT[0].text])).current()
    expect(brief.flags.map((f) => f.kind)).toContain('unchallenged_impact')
  })

  it('does not flag impact that is quantified', async () => {
    const brief = (await ingest(['It cut p95 latency for users from 400ms to 90ms.'])).current()
    expect(brief.flags.map((f) => f.kind)).not.toContain('unchallenged_impact')
  })

  it('detects the contradiction across turns, keeping both timestamps', async () => {
    const brief = (await ingest([DEMO_TRANSCRIPT[1].text, DEMO_TRANSCRIPT[2].text])).current()
    const contradiction = brief.flags.find((f) => f.kind === 'contradiction')
    expect(contradiction).toBeDefined()
    expect(contradiction!.evidence).toHaveLength(2)
    expect(contradiction!.evidence[0].t).toBeLessThan(contradiction!.evidence[1].t)
  })

  it('carries evidence back to the exact event', async () => {
    const builder = await ingest([DEMO_TRANSCRIPT[0].text])
    const flag = builder.current().flags[0]
    expect(flag.evidence[0].eventId).toBe(builder.current().claims[0].sourceEventId)
  })
})

describe('difficulty adjusts to performance', () => {
  it('rises on a specific answer', async () => {
    expect((await ingest(['I used a hash map so lookups are O(1).'])).current().difficulty).toBe(3)
  })

  it('falls on a turn with nothing concrete in it', async () => {
    expect((await ingest(['It made things a lot faster.'])).current().difficulty).toBe(1)
  })

  it('still rises when one sentence is concrete and another is hand-wavy', async () => {
    // The vagueness is Product's to challenge; it does not make the questions
    // easier for a candidate who just named a technique and a complexity.
    expect((await ingest([DEMO_TRANSCRIPT[0].text])).current().difficulty).toBe(3)
  })

  it('leaves difficulty alone for a contradiction', async () => {
    const before = (await ingest([DEMO_TRANSCRIPT[1].text])).current().difficulty
    const after = (await ingest([DEMO_TRANSCRIPT[1].text, 'We rolled it out gradually.'])).current().difficulty
    expect(after).toBe(before)
  })
})

describe('the split panel', () => {
  let assessment: ReturnType<InterviewSession['assessment']>

  beforeAll(async () => {
    const session = new InterviewSession({ mode: 'coordinated', ...fixed })
    for (const turn of DEMO_TRANSCRIPT) await session.candidateSays(turn.text, turn.at)
    assessment = session.assessment()
  })
  const by = (agent: string) => assessment.perAgent.find((v) => v.agent === agent)!

  it('scores the three interviewers differently', async () => {
    expect(by('technical').score).toBe(4)
    expect(by('product').score).toBe(2)
    expect(by('behavioural').score).toBe(3)
  })

  it('reports the disagreement rather than averaging it away', async () => {
    expect(assessment.split).toBe(true)
    expect(assessment.spread).toBe(2)
    expect(assessment.final).toBe(3)
    expect(assessment.summary).toMatch(/split/i)
  })

  it('writes verdicts that match the evidence', async () => {
    expect(by('technical').verdict).toBe('correct, efficient')
    expect(by('product').verdict).toBe('never named the user impact')
    expect(by('behavioural').verdict).toMatch(/contradicted themselves on rollout/)
  })

  it('links every verdict back to a moment in the transcript', async () => {
    for (const verdict of assessment.perAgent) {
      expect(verdict.evidence.length).toBeGreaterThan(0)
      for (const e of verdict.evidence) expect(e.t).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('metrics', () => {
  it('computes nearest-rank percentiles', async () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20)
    expect(percentile([10, 20, 30, 40], 95)).toBe(40)
    expect(percentile([], 50)).toBe(0)
  })

  it('counts an interrupt that lands after a fair hold as legitimate', async () => {
    const session = new InterviewSession({ mode: 'coordinated', ...fixed })
    for (const turn of DEMO_TRANSCRIPT) await session.candidateSays(turn.text, turn.at)
    const m = session.metrics()
    expect(m.interrupts).toBe(1)
    expect(m.falseInterrupts).toBe(0)
    expect(m.latencyP50).toBe(50)
  })

  it('counts an interrupt that cuts somebody off instantly as a false one', async () => {
    const session = new InterviewSession({
      mode: 'coordinated',
      decisionLatency: () => 50,
      holdBeforeRecheck: () => 200, // well inside MIN_HOLD_MS
    })
    for (const turn of DEMO_TRANSCRIPT) await session.candidateSays(turn.text, turn.at)
    const m = session.metrics()
    expect(m.falseInterrupts).toBe(1)
    expect(m.falseInterruptRate).toBe(1)
  })

  it('returns zeroes for an empty log', async () => {
    expect(computeMetrics([]).collisionRate).toBe(0)
    expect(computeMetrics([]).latencyP95).toBe(0)
  })
})
