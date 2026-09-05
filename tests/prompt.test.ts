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

  it("puts the candidate's own last words in front of the model", async () => {
    const input = await inputWithFlag()
    const said = [...input.transcript].reverse().find((e) => e.speaker === 'candidate')
    if (!said) throw new Error('the candidate never spoke')
    const text = buildMessages(input)
      .map((m) => m.content)
      .join(' ')
    expect(text).toContain('THEY JUST SAID')
    expect(text).toContain(said.text)
  })

  it('tells the interviewer to answer what was said when nothing was flagged', async () => {
    // The old wording here said "ask the next question at this difficulty",
    // which told the model to ignore the candidate entirely. Off-script answers
    // came back with generic competency questions.
    const input = { ...(await inputWithFlag()), justifiedBy: [] }
    const text = buildMessages(input)
      .map((m) => m.content)
      .join(' ')
    expect(text).toMatch(/answer what they just said/i)
    expect(text).toMatch(/off-topic|evasive/i)
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

describe('the opening turn', () => {
  it('asks for a greeting instead of a follow-up', async () => {
    const input = { ...(await inputWithFlag()), opening: true }
    const text = buildMessages(input)
      .map((m) => m.content)
      .join(' ')
    expect(text).toMatch(/first thing the candidate hears/i)
    expect(text).not.toContain('THEY JUST SAID')
  })

  it('has the opener disclose that the panel is not human', async () => {
    const input = { ...(await inputWithFlag()), opening: true }
    const text = buildMessages(input)
      .map((m) => m.content)
      .join(' ')
    expect(text).toMatch(/not human|are AI|artificial/i)
  })
})

describe('cutting in', () => {
  it('tells the interrupting agent what it is talking over', async () => {
    const base = await inputWithFlag()
    const input = { ...base, decision: { ...base.decision, kind: 'interrupt' as const } }
    const text = buildMessages(input)
      .map((m) => m.content)
      .join(' ')

    expect(text).toMatch(/cutting in/i)
    expect(text).toMatch(/do not repeat/i)
  })

  it('says nothing about cutting in on an ordinary grant', async () => {
    const base = await inputWithFlag()
    const input = { ...base, decision: { ...base.decision, kind: 'grant' as const } }
    const text = buildMessages(input)
      .map((m) => m.content)
      .join(' ')

    expect(text).not.toMatch(/cutting in/i)
  })
})
