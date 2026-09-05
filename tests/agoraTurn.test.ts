/**
 * The grant, when the agents carry their own model.
 *
 * On Agora the coordinator does not write the line — it hands one agent the
 * candidate's answer with `think` and that agent's own managed model writes and
 * says the reply. So the transcript cannot be built from what this process
 * composed; it has to be read back out of the transport.
 *
 * These tests drive that branch through a transport shaped like Agora's,
 * without an App ID or a single billable second.
 */

import { describe, expect, it } from 'vitest'
import { InterviewSession } from '@/core/session'
import type { AgentId, ChannelConfig, Competency, FlagKind } from '@/core/contracts'
import type { AnalysisResult, Analyzer } from '@/core/brief'
import type { FloorPick, FloorPicker } from '@/agents/floor'
import type { AgentJoinSpec, Transport, TransportStatus, TransportUtterance } from '@/transport/types'

/** Poll fast and give up fast; nothing here is waiting on a real network. */
const fast = {
  decisionLatency: () => 50,
  holdBeforeRecheck: () => 1600,
  linePollMs: 1,
  lineTimeoutMs: 60,
  // Nothing here is actually spoken, so there is no speech to wait out.
  speechDuration: () => 0,
}

/** Force the floor, so these tests are about the line and not about the choice. */
function picks(agent: AgentId): FloorPicker {
  return {
    async pick(): Promise<FloorPick> {
      return { agent, reason: 'the test said so' }
    },
  }
}

/** Raise one flag per competency, so all three interviewers want the floor. */
function everyoneBids(): Analyzer {
  const spread: [FlagKind, Competency][] = [
    ['vague', 'algorithms'],
    ['unchallenged_impact', 'impact'],
    ['contradiction', 'communication'],
  ]
  return {
    async analyze(event): Promise<AnalysisResult> {
      return {
        claims: [],
        flags: spread.map(([kind, competency], i) => ({
          id: `flag-${event.id}-${i}`,
          kind,
          competency,
          evidence: [{ eventId: event.id, t: event.tStart, quote: event.text }],
          note: 'raised so every interviewer has grounds',
          raisedAtTurn: 0,
          addressed: false,
        })),
      }
    },
  }
}

/**
 * A transport shaped like Agora's: `think` makes the agent write a line, and
 * the only way to learn that line is to read its history back.
 */
class FakeAgora implements Transport {
  readonly name = 'Fake Agora'
  readonly implementation = 'agora' as const
  readonly generatesOwnLines = true

  readonly spoken: { agent: AgentId; text: string }[] = []
  readonly thought: { agent: AgentId; text: string }[] = []
  interrupts = 0
  /** What Agora would say about these agents if asked. */
  state: string | null = 'RUNNING'

  private log = new Map<AgentId, TransportUtterance[]>()

  /** What each agent will say, in order, each time it is thought at. */
  constructor(private replies: Partial<Record<AgentId, string[]>> = {}) {}

  /** A line the agent said without being asked. This is what naive mode does. */
  seed(agent: AgentId, text: string): void {
    const seen = this.log.get(agent) ?? []
    seen.push({ turnId: seen.length + 1, text })
    this.log.set(agent, seen)
  }

  status(): TransportStatus {
    return { connected: true, implementation: 'agora', channelName: 'test', joinedAgents: [] }
  }

  async join(_config: ChannelConfig, _agents: AgentJoinSpec[]): Promise<TransportStatus> {
    return this.status()
  }

  async think(agent: AgentId, text: string): Promise<void> {
    this.thought.push({ agent, text })
    const reply = this.replies[agent]?.shift()
    if (reply === undefined) return // this agent never answers — the timeout path
    this.seed(agent, reply)
  }

  async speak(agent: AgentId, text: string): Promise<void> {
    this.spoken.push({ agent, text })
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1
  }

  async history(agent: AgentId): Promise<TransportUtterance[]> {
    return [...(this.log.get(agent) ?? [])]
  }

  async agentState(_agent: AgentId): Promise<string | null> {
    return this.state
  }

  async leave(): Promise<void> {}
}

describe('the floor is granted with think, not with a script', () => {
  it('puts the agent’s own words in the transcript', async () => {
    const transport = new FakeAgora({ technical: ['How do you invalidate that cache?'] })
    const session = new InterviewSession({
      mode: 'coordinated',
      transport,
      floor: picks('technical'),
      ...fast,
    })

    const step = await session.candidateSays('I put Redis in front of checkout.', 1000)

    expect(step.utterances.map((u) => u.text)).toEqual(['How do you invalidate that cache?'])
    expect(transport.thought).toEqual([{ agent: 'technical', text: 'I put Redis in front of checkout.' }])
  })

  it('hands the agent the candidate’s answer, not a composed question', async () => {
    const transport = new FakeAgora({ product: ['Faster for whom?'] })
    const session = new InterviewSession({
      mode: 'coordinated',
      transport,
      floor: picks('product'),
      ...fast,
    })

    await session.candidateSays('It made things a lot faster.', 1000)

    expect(transport.thought[0].text).toBe('It made things a lot faster.')
    // Nothing was said by us: the agent said it.
    expect(transport.spoken).toEqual([])
  })

  it('never speaks the line twice', async () => {
    const transport = new FakeAgora({ technical: ['One question only.'] })
    const session = new InterviewSession({
      mode: 'coordinated',
      transport,
      floor: picks('technical'),
      ...fast,
    })

    await session.candidateSays('I used a hash map so lookups are O(1).', 1000)

    expect(transport.spoken).toHaveLength(0)
    expect(transport.thought).toHaveLength(1)
  })

  it('does not mistake last turn’s line for this turn’s', async () => {
    const transport = new FakeAgora({ technical: ['First question.', 'Second question.'] })
    const session = new InterviewSession({
      mode: 'coordinated',
      transport,
      floor: picks('technical'),
      ...fast,
    })

    const one = await session.candidateSays('I used a hash map.', 1000)
    const two = await session.candidateSays('It was about forty milliseconds.', 5000)

    expect(one.utterances[0].text).toBe('First question.')
    expect(two.utterances[0].text).toBe('Second question.')
  })
})

describe('an agent that says nothing does not leave the interview silent', () => {
  it('falls back to the deterministic line, and actually says it', async () => {
    const transport = new FakeAgora({}) // no agent ever replies
    const session = new InterviewSession({
      mode: 'coordinated',
      transport,
      floor: picks('technical'),
      ...fast,
    })

    const step = await session.candidateSays('I used a hash map so lookups are O(1).', 1000)
    const line = step.utterances[0].text

    expect(line.length).toBeGreaterThan(0)
    // The words on screen are the words that went to the channel — a transcript
    // showing a sentence nobody said would be worse than a duller question.
    expect(transport.spoken).toEqual([{ agent: 'technical', text: line }])
  })
})

describe('the opening line is spoken, never thought', () => {
  it('discloses the panel is AI through speak, so the words cannot drift', async () => {
    const transport = new FakeAgora({ behavioural: ['I would never say this.'] })
    const session = new InterviewSession({ mode: 'coordinated', transport, ...fast })

    const step = await session.open()

    expect(transport.thought).toEqual([])
    expect(transport.spoken).toHaveLength(1)
    expect(transport.spoken[0].text).toBe(step.utterances[0].text)
  })
})

describe('a real collision is read back, not invented', () => {
  it('shows what each agent actually said when all three fired at once', async () => {
    const transport = new FakeAgora()
    // Naive mode: nothing here asked them to speak. They heard the candidate.
    transport.seed('technical', 'Which data structure was that?')
    transport.seed('product', 'How much faster, in numbers?')
    transport.seed('behavioural', 'Who disagreed with you about it?')

    const session = new InterviewSession({
      mode: 'naive',
      transport,
      analyzer: everyoneBids(),
      ...fast,
    })

    const step = await session.candidateSays('It made things a lot faster.', 1000)

    expect(step.decisions[0].kind).toBe('collision')
    expect(step.utterances.map((u) => u.text).sort()).toEqual([
      'How much faster, in numbers?',
      'Which data structure was that?',
      'Who disagreed with you about it?',
    ])
    // Nothing here started them and nothing here could have stopped them.
    expect(transport.thought).toEqual([])
    expect(transport.spoken).toEqual([])
  })

  it('does not replay the previous collision on the next turn', async () => {
    const transport = new FakeAgora()
    transport.seed('technical', 'Turn one, technical.')
    transport.seed('product', 'Turn one, product.')
    transport.seed('behavioural', 'Turn one, behavioural.')

    const session = new InterviewSession({
      mode: 'naive',
      transport,
      analyzer: everyoneBids(),
      ...fast,
    })

    await session.candidateSays('It made things a lot faster.', 1000)

    transport.seed('technical', 'Turn two, technical.')
    transport.seed('product', 'Turn two, product.')
    transport.seed('behavioural', 'Turn two, behavioural.')

    const second = await session.candidateSays('About forty milliseconds.', 5000)

    for (const utterance of second.utterances) {
      expect(utterance.text).toContain('Turn two')
    }
  })
})

describe('an interviewer that dies mid-turn is not a silent interview', () => {
  it('says so on screen instead of going quiet', async () => {
    const transport = new FakeAgora({}) // never replies
    transport.state = 'FAILED'
    const notices: string[] = []

    const session = new InterviewSession({
      mode: 'coordinated',
      transport,
      floor: picks('technical'),
      onNotice: (message) => notices.push(message),
      ...fast,
      healthCheckAfterMs: 0,
      lineTimeoutMs: 500,
    })

    await session.candidateSays('I used a hash map so lookups are O(1).', 1000)

    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/technical/)
    expect(notices[0]).toMatch(/FAILED/)
  })

  it('stops waiting on a dead agent rather than sitting out the whole timeout', async () => {
    const transport = new FakeAgora({})
    transport.state = 'FAILED'

    const session = new InterviewSession({
      mode: 'coordinated',
      transport,
      floor: picks('product'),
      ...fast,
      healthCheckAfterMs: 0,
      lineTimeoutMs: 10_000, // would be a ten second silence if nothing noticed
    })

    const started = Date.now()
    await session.candidateSays('It made things a lot faster.', 1000)

    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('keeps waiting while the agent is merely slow', async () => {
    const transport = new FakeAgora({ technical: ['Worth the wait.'] })
    transport.state = 'RUNNING'
    const notices: string[] = []

    const session = new InterviewSession({
      mode: 'coordinated',
      transport,
      floor: picks('technical'),
      onNotice: (message) => notices.push(message),
      ...fast,
      healthCheckAfterMs: 0,
    })

    const step = await session.candidateSays('I used a hash map.', 1000)

    expect(step.utterances[0].text).toBe('Worth the wait.')
    expect(notices).toEqual([])
  })
})

describe('the simulator is left exactly as it was', () => {
  it('composes and lets the caller do the speaking when lines are not self-written', async () => {
    const session = new InterviewSession({ mode: 'coordinated', floor: picks('technical'), ...fast })

    const step = await session.candidateSays('It made things a lot faster.', 1000)

    // No transport at all: the session still produces a line, as it always has.
    expect(step.utterances[0].text.length).toBeGreaterThan(0)
    expect(step.utterances[0].speaker).toBe('technical')
  })
})

describe('transcript and cancellation regressions', () => {
  it('recognizes a new turn when history has rolled over without growing', async () => {
    const transport = new FakeAgora({ technical: ['New question'] })
    transport.seed('technical', 'Old question')
    const original = transport.history.bind(transport)
    transport.history = async agent => (await original(agent)).slice(-1)
    const session = new InterviewSession({transport, floor: picks('technical'), ...fast})
    const result = await session.candidateSays('I used a hash map.')
    expect(result.utterances[0].text).toBe('New question')
  })
  it('publishes the candidate transcript before waiting for an interviewer', async () => {
    const transport = new FakeAgora({technical: ['New question']})
    const snapshots: string[][] = []
    const session = new InterviewSession({transport, floor: picks('technical'), ...fast,
      onTranscript: () => snapshots.push(session.transcript.all().map(e => e.text)),
    })
    await session.candidateSays('I used a hash map.')
    expect(snapshots[0]).toEqual(['I used a hash map.'])
    expect(snapshots.at(-1)).toContain('New question')
  })
  it('does not speak a late fallback after the user ends an interview', async () => {
    const transport = new FakeAgora({})
    const session = new InterviewSession({transport, floor: picks('technical'), ...fast})
    transport.think = async () => session.cancel()
    await expect(session.candidateSays('I used a hash map.')).rejects.toThrow('Interview ended')
    expect(transport.spoken).toHaveLength(0)
    expect(session.transcript.all()).toHaveLength(1)
  })
  it('waits for actual audio completion before handing the microphone back', async () => {
    const transport = new FakeAgora({technical: ['New question']})
    let completed = false
    const session = new InterviewSession({transport, floor: picks('technical'), ...fast,
      waitForAudio: async () => { completed = true },
    })
    await session.candidateSays('I used a hash map.')
    expect(completed).toBe(true)
  })
})
