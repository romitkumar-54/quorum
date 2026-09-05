import { describe, expect, it } from 'vitest'
import { InterviewSession } from '@/core/session'
import type { AnalysisResult, Analyzer } from '@/core/brief'
import type { Competency, FlagKind } from '@/core/contracts'

const fixed = { decisionLatency: () => 50, holdBeforeRecheck: () => 1600 }

/** An analyser that takes its time, the way a model call does. */
function asyncAnalyzer(kind: FlagKind, competency: Competency): Analyzer {
  return {
    async analyze(event): Promise<AnalysisResult> {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        claims: [],
        flags: [
          {
            id: `flag-${event.id}`,
            kind,
            competency,
            evidence: [{ eventId: event.id, t: event.tStart, quote: event.text }],
            note: 'raised by the async analyser',
            raisedAtTurn: 0,
            addressed: false,
          },
        ],
      }
    },
  }
}

describe('the brief is built by something allowed to take its time', () => {
  it('accepts an analyser that resolves asynchronously', async () => {
    const session = new InterviewSession({
      mode: 'coordinated',
      analyzer: asyncAnalyzer('vague', 'algorithms'),
      ...fixed,
    })

    await session.candidateSays('it got a lot faster', 1000)

    expect(session.brief.current().flags.map((f) => f.kind)).toEqual(['vague'])
  })
})

describe('wandering off is something the panel can challenge', () => {
  it('gives Behavioural the floor when the candidate goes off topic', async () => {
    const session = new InterviewSession({
      mode: 'coordinated',
      analyzer: asyncAnalyzer('off_topic', 'communication'),
      ...fixed,
    })

    const step = await session.candidateSays('I really like pineapple on pizza', 1000)

    expect(step.decisions[0].grantedTo).toBe('behavioural')
  })

  it('gives Product the floor when an impact answer dodges the question', async () => {
    const session = new InterviewSession({
      mode: 'coordinated',
      analyzer: asyncAnalyzer('evasion', 'impact'),
      ...fixed,
    })

    const step = await session.candidateSays('I would rather not go into the numbers', 1000)

    expect(step.decisions[0].grantedTo).toBe('product')
  })
})
