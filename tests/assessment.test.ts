import { describe, it, expect } from 'vitest'
import { BriefBuilder } from '@/core/brief'
import { TranscriptLog } from '@/core/transcript'

async function review(answers: string[]) {
  const brief = new BriefBuilder()
  const log = new TranscriptLog()
  for (const text of answers) await brief.ingest(log.append({speaker: 'candidate', text}))
  return brief.assessment()
}

describe('evidence-based assessment', () => {
  it('does not award a default score to an empty interview or a biography', async () => {
    for (const answers of [[], ['I studied computer science at university.']]) {
      const result = await review(answers)
      expect(result.final).toBeNull()
      expect(result.perAgent.every(row => row.score === null)).toBe(true)
    }
  })
  it('distinguishes a named technique from explained and tested engineering work', async () => {
    const weak = await review(['I used a hash map.'])
    const strong = await review(['I used a hash map instead of a linear scan because lookup latency was too high, and I benchmarked the algorithm with a million requests to verify the improvement from 400ms to 20ms.'])
    expect(strong.perAgent[0].score!).toBeGreaterThan(weak.perAgent[0].score!)
    expect(weak.perAgent[0].verdict).not.toContain('correct, efficient')
  })
  it('rewards measured customer impact compared with unsupported assertions', async () => {
    const weak = await review(['Customers had a better experience.'])
    const strong = await review(['Customer conversion improved from 2 percent to 4 percent compared with the control because we removed an unnecessary checkout step for customers during the experiment.'])
    expect(strong.perAgent[1].score!).toBeGreaterThan(weak.perAgent[1].score!)
  })
  it('evaluates actions and reflection in behavioural answers', async () => {
    const weak = await review(['My team is great.'])
    const strong = await review(['I discussed the deadline with my manager and explained the trade-off because the team needed more time, then we agreed a smaller scope and learned from the feedback.'])
    expect(strong.perAgent[2].score!).toBeGreaterThan(weak.perAgent[2].score!)
  })
  it('does not increase a score by repeating an identical answer', async () => {
    const answer = 'I used a hash map for the algorithm.'
    expect((await review([answer, answer, answer])).perAgent[0].score).toBe((await review([answer])).perAgent[0].score)
  })
  it('keeps untested competencies out of the overall score and cites real answers', async () => {
    const result = await review(['I used a hash map.'])
    expect(result.final).toBeNull()
    expect(result.perAgent[0].evidence[0].quote).toBe('I used a hash map.')
    expect(result.perAgent[1].score).toBeNull()
  })
})
