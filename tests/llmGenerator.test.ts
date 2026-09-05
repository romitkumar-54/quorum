import { describe, expect, it, vi } from 'vitest'
import { InterviewSession } from '@/core/session'
import { DEMO_TRANSCRIPT } from '@/core/demo'
import { ScriptedGenerator, type GenerationInput } from '@/agents'
import { LlmGenerator } from '@/agents/llm'

const fixed = { decisionLatency: () => 50, holdBeforeRecheck: () => 1600 }

async function anyInput(): Promise<GenerationInput> {
  let captured: GenerationInput | undefined
  const spy = {
    async next(input: GenerationInput) {
      captured ??= input
      return 'noted'
    },
  }

  const session = new InterviewSession({ mode: 'coordinated', generator: spy, ...fixed })
  await session.candidateSays(DEMO_TRANSCRIPT[0].text, DEMO_TRANSCRIPT[0].at)
  if (!captured) throw new Error('no generation happened')
  return captured
}

const ok = (text: string) => new Response(JSON.stringify({ text }), { status: 200 })

describe('the LLM generator, and what happens when it fails', () => {
  it('returns the line the route produced', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok('What breaks at ten million keys?'))
    const gen = new LlmGenerator({ fallback: new ScriptedGenerator(), fetchImpl })
    expect(await gen.next(await anyInput())).toBe('What breaks at ten million keys?')
  })

  it('falls back to the scripted line when the route errors', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const input = await anyInput()
    const scripted = new ScriptedGenerator()
    const gen = new LlmGenerator({ fallback: scripted, fetchImpl })
    expect(await gen.next(input)).toBe(await scripted.next(input))
  })

  it('falls back when the route is slower than the budget', async () => {
    // This fetch ignores the abort signal, the way a wedged transport would.
    // The budget must be enforced here, not delegated to the request.
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(ok('too late')), 200)))
    const input = await anyInput()
    const scripted = new ScriptedGenerator()
    const gen = new LlmGenerator({ fallback: scripted, timeoutMs: 20, fetchImpl })
    expect(await gen.next(input)).toBe(await scripted.next(input))
  })

  it('never throws, whatever the route returns', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))
    const gen = new LlmGenerator({ fallback: new ScriptedGenerator(), fetchImpl })
    await expect(gen.next(await anyInput())).resolves.toBeTypeOf('string')
  })
})
