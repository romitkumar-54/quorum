/**
 * One interviewer must not run the whole interview.
 *
 * This is the failure that showed up the first time a person actually talked to
 * the panel: Behavioural answered every single turn and the other two never
 * spoke. Two things caused it together.
 *
 * `RuleAnalyzer.classify` returns `communication` for any sentence that matches
 * neither the impact nor the algorithm vocabulary — which is most ordinary
 * speech — and `communication` is Behavioural's competency, worth the full
 * relevance weight. And the anti-monologue cap sat inside `honour`, which only
 * ever ran on a *model's* nomination; once the nominator was retired, nothing
 * checked it at all.
 *
 * These tests use plain conversational answers, because that is what a real
 * candidate says and what the keyword rules have nothing to say about.
 */

import { describe, expect, it } from 'vitest'
import { InterviewSession } from '@/core/session'
import type { AgentId } from '@/core/contracts'

const fixed = { decisionLatency: () => 50, holdBeforeRecheck: () => 1600 }

/** Ordinary answers. No metrics, no data structures, nothing to classify. */
const SMALL_TALK = [
  'I studied computer science at university.',
  'After that I joined a small startup in Pune.',
  'I mostly looked after the back end there.',
  'My manager taught me a great deal about shipping.',
  'Then I moved somewhere rather larger.',
  'That is roughly where I am today.',
]

async function speakers(mode: 'coordinated' | 'naive' = 'coordinated'): Promise<AgentId[]> {
  const session = new InterviewSession({ mode, ...fixed })
  const heard: AgentId[] = []

  for (const [i, line] of SMALL_TALK.entries()) {
    const step = await session.candidateSays(line, 1000 + i * 4000)
    for (const utterance of step.utterances) heard.push(utterance.speaker as AgentId)
  }
  return heard
}

describe('the floor moves around the panel', () => {
  it('never lets one interviewer hold three turns running', async () => {
    const heard = await speakers()

    let run = 1
    for (let i = 1; i < heard.length; i++) {
      run = heard[i] === heard[i - 1] ? run + 1 : 1
      expect(run, `${heard[i]} spoke ${run} turns running: ${heard.join(' → ')}`).toBeLessThanOrEqual(2)
    }
  })

  it('gives more than one interviewer a turn over six ordinary answers', async () => {
    const heard = await speakers()

    expect(new Set(heard).size, `only ${heard.join(', ')} ever spoke`).toBeGreaterThan(1)
  })

  it('still grants the floor to exactly one agent per turn', async () => {
    const session = new InterviewSession({ mode: 'coordinated', ...fixed })

    for (const [i, line] of SMALL_TALK.entries()) {
      const step = await session.candidateSays(line, 1000 + i * 4000)
      const grant = step.decisions[0]
      expect(grant.kind).not.toBe('collision')
      if (grant.kind === 'grant') expect(grant.grantedTo).not.toBeNull()
    }
  })
})

describe('the panel opens by saying hello', () => {
  it('greets, discloses that it is AI, and asks something answerable', async () => {
    const session = new InterviewSession({ mode: 'coordinated', ...fixed })

    const step = await session.open()
    const line = step.utterances[0].text

    expect(line).toMatch(/hello/i)
    // Requirement 11. This is the sentence the whole disclosure rests on.
    expect(line).toMatch(/\bAI\b/)
    expect(line).toMatch(/three of us/i)
    // Agora's speak caps at 512 bytes.
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(512)
  })
})
