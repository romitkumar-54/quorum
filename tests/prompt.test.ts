import { describe, expect, it } from 'vitest'
import { InterviewSession } from '@/core/session'
import { DEMO_TRANSCRIPT } from '@/core/demo'
import { TRANSCRIPT_WINDOW, buildMessages } from '@/agents/prompt'
import type { GenerationInput } from '@/agents'

const fixed = { decisionLatency: () => 50, holdBeforeRecheck: () => 1600 }

/** Run the demo far enough that an agent takes the floor on a real flag. */
async function inputWithFlag(): Promise<GenerationInput> {
  let captured: GenerationInput | undefined
  const spy = {
    async next(input: GenerationInput) {
      if (!captured && input.justifiedBy.length > 0) captured = input
      return 'noted'
    },
  }

  const session = new InterviewSession({ mode: 'coordinated', generator: spy, ...fixed })
  for (const turn of DEMO_TRANSCRIPT) await session.candidateSays(turn.text, turn.at)
  if (!captured) throw new Error('the demo produced no justified grant')
  return captured
}

/** The RECENT CONVERSATION block, on its own. */
function recentBlock(text: string): string {
  return text.split('RECENT CONVERSATION')[1].split('YOU HAVE THE FLOOR BECAUSE:')[0]
}

describe('the prompt carries the reason the floor was granted', () => {
  it('names the flag the agent won the floor on', async () => {
    const input = await inputWithFlag()
    const text = buildMessages(input)
      .map((m) => m.content)
      .join('\n')
    expect(text).toContain(input.justifiedBy[0].kind)
  })

  it('quotes the evidence behind that flag', async () => {
    const input = await inputWithFlag()
    const quote = input.justifiedBy[0].evidence[0]?.quote
    if (!quote) throw new Error('the flag carried no evidence')
    const text = buildMessages(input)
      .map((m) => m.content)
      .join('\n')
    expect(text).toContain(quote)
  })

  it('opens with the agent persona as a system message', async () => {
    const input = await inputWithFlag()
    const messages = buildMessages(input)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toMatch(/one question/i)
  })

  it('includes the difficulty so the ladder still climbs', async () => {
    const input = await inputWithFlag()
    const text = buildMessages(input)
      .map((m) => m.content)
      .join('\n')
    expect(text).toContain(`Difficulty: ${input.brief.difficulty}`)
  })

  it('sends no more than the last few turns of conversation', async () => {
    const input = await inputWithFlag()
    const text = buildMessages(input)
      .map((m) => m.content)
      .join('\n')
    const recent = recentBlock(text)

    // Counted by timestamp prefix rather than by line, so an utterance
    // containing a newline cannot inflate the count.
    const turns = recent.split('\n').filter((line) => line.trimStart().startsWith('['))
    expect(turns).toHaveLength(Math.min(TRANSCRIPT_WINDOW, input.transcript.length))
    expect(recent).toContain(input.transcript[input.transcript.length - 1].text)
  })
})
