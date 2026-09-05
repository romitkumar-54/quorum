import { describe, expect, it } from 'vitest'
import { InterviewSession } from '@/core/session'
import type { AnalysisResult, Analyzer } from '@/core/brief'
import type { AgentId, Competency, FlagKind } from '@/core/contracts'
import type { FloorPick, FloorPicker } from '@/agents/floor'

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

/** A stand-in for the model's floor decision. */
function picks(agent: AgentId | null, reason = 'because I said so'): FloorPicker {
  return { async pick(): Promise<FloorPick> { return { agent, reason } } }
}

const SAID = [
  'I used a hash map so lookups are O(1).',
  'It made things a lot faster for users.',
  'We shipped it to everyone on day one.',
  'We rolled it out to 5% first, to be safe.',
]

async function run(floor: FloorPicker, mode: 'coordinated' | 'naive' = 'coordinated', turns = SAID.length) {
  const session = new InterviewSession({ mode, floor, ...fixed })
  const granted: (AgentId | null)[] = []
  for (let i = 0; i < turns; i++) {
    const step = await session.candidateSays(SAID[i % SAID.length], (i + 1) * 20_000)
    granted.push(step.decisions[0].grantedTo)
  }
  return granted
}

describe('the model picks, the code still decides what is allowed', () => {
  it('grants the floor to the agent the model named', async () => {
    const granted = await run(picks('product'), 'coordinated', 1)
    expect(granted[0]).toBe('product')
  })

  it('ignores a name that is not an interviewer', async () => {
    const granted = await run(picks('the-ceo' as AgentId), 'coordinated', 1)
    expect(['technical', 'product', 'behavioural']).toContain(granted[0])
  })

  it('refuses to let one interviewer hold the floor three turns running', async () => {
    const granted = await run(picks('product'), 'coordinated', 4)
    expect(granted.slice(0, 2)).toEqual(['product', 'product'])
    expect(granted[2]).not.toBe('product')
  })

  it('ignores the pick in naive mode, where colliding is the point', async () => {
    const session = new InterviewSession({ mode: 'naive', floor: picks('product'), ...fixed })
    const step = await session.candidateSays(SAID[0], 20_000)
    expect(step.decisions[0].kind).toBe('collision')
  })

  it('falls back to the deterministic coordinator when the model abstains', async () => {
    const granted = await run(picks(null), 'coordinated', 1)
    expect(granted[0]).toBeTruthy()
  })
})
