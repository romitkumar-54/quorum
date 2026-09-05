/**
 * Every interviewer has to be able to earn a turn.
 *
 * `classify` used to answer three questions with two tests: impact language, or
 * algorithm language, or — for everything else — `communication`. Since
 * `communication` is Behavioural's competency and the lead competency carries
 * the largest single term in a bid, ordinary speech handed Behavioural the
 * floor over and over and the other two never had grounds to speak.
 *
 * Each interviewer now has its own vocabulary, the strongest signal wins, and a
 * sentence that points nowhere names nobody at all.
 */

import { describe, expect, it } from 'vitest'
import { RuleAnalyzer } from '@/core/brief/analyzer'
import { InterviewSession } from '@/core/session'
import { EMPTY_BRIEF, type AgentId, type Competency, type TranscriptEvent } from '@/core/contracts'

const fixed = { decisionLatency: () => 50, holdBeforeRecheck: () => 1600 }

function said(text: string): TranscriptEvent {
  return { id: 'e1', speaker: 'candidate', text, tStart: 0, tEnd: 1000, final: true }
}

async function leadFor(text: string): Promise<Competency | undefined> {
  const { lead } = await new RuleAnalyzer().analyze(said(text), EMPTY_BRIEF)
  return lead
}

/** Who the coordinator actually gives the floor to, on a fresh session. */
async function floorFor(text: string): Promise<AgentId | null> {
  const session = new InterviewSession({ mode: 'coordinated', ...fixed })
  const step = await session.candidateSays(text, 1000)
  return step.decisions[0].grantedTo
}

const TECHNICAL = 'I replaced the linear scan with a hash map so lookups are constant time.'
const IMPACT = 'It cut checkout time for our customers and conversion went up by 4 percent.'
const PEOPLE = 'My manager disagreed with me so I explained the trade-off to the team.'
const BIOGRAPHY = 'I studied computer science at university and then joined a small startup.'

describe('a sentence goes to the interviewer whose territory it is in', () => {
  it('sends a claim about how it was built to Technical', async () => {
    expect(await leadFor(TECHNICAL)).toBe('algorithms')
  })

  it('sends a claim about who it helped to Product', async () => {
    expect(await leadFor(IMPACT)).toBe('impact')
  })

  it('sends a claim about working with people to Behavioural', async () => {
    expect(await leadFor(PEOPLE)).toBe('communication')
  })

  it('names nobody when the sentence is only biography', async () => {
    // This is the fix. It used to answer `communication`, which was worth the
    // full relevance weight to Behavioural on a sentence nobody asked about.
    expect(await leadFor(BIOGRAPHY)).toBeUndefined()
  })

  it('weighs the signals rather than trusting whichever test ran first', async () => {
    // Three engineering signals against one people signal.
    expect(await leadFor('I refactored the database schema and the team saw it.')).toBe('algorithms')
    // …and the other way round.
    expect(await leadFor('The team disagreed, so I explained the deploy to my manager.')).toBe(
      'communication',
    )
  })

  it('still reads a performance claim about users as an impact claim', async () => {
    // The older behaviour, deliberately kept: impact language wearing a
    // performance costume is an impact claim, so ties go to Product.
    expect(await leadFor('It made things a lot faster for users.')).toBe('impact')
  })
})

describe('the floor follows the subject', () => {
  it('gives Technical the floor on a technical answer', async () => {
    expect(await floorFor(TECHNICAL)).toBe('technical')
  })

  it('gives Product the floor on an impact answer', async () => {
    expect(await floorFor(IMPACT)).toBe('product')
  })

  it('gives Behavioural the floor on an answer about people', async () => {
    expect(await floorFor(PEOPLE)).toBe('behavioural')
  })
})

describe('a real conversation reaches all three interviewers', () => {
  it('lets each of them speak because they have something to say', async () => {
    const session = new InterviewSession({ mode: 'coordinated', ...fixed })
    const conversation = [
      TECHNICAL,
      IMPACT,
      PEOPLE,
      'I also added an index to the orders query to cut latency.',
      'Retention improved for the users on the new flow.',
      'I learned a lot from that mistake and gave the team feedback.',
    ]

    const heard: AgentId[] = []
    for (const [i, line] of conversation.entries()) {
      const step = await session.candidateSays(line, 1000 + i * 5000)
      for (const utterance of step.utterances) heard.push(utterance.speaker as AgentId)
    }

    expect(new Set(heard), `only ${[...new Set(heard)].join(', ')} spoke: ${heard.join(' → ')}`).toEqual(
      new Set<AgentId>(['technical', 'product', 'behavioural']),
    )
  })
})
