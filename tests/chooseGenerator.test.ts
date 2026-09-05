import { describe, expect, it } from 'vitest'
import { ScriptedGenerator } from '@/agents'
import { LlmGenerator } from '@/agents/llm'
import { chooseGenerator } from '@/agents/choose'

describe('which brain drives the panel', () => {
  it('uses the model when the route reports a key', () => {
    expect(chooseGenerator(true)).toBeInstanceOf(LlmGenerator)
  })

  it('uses the scripted panel when there is no key', () => {
    expect(chooseGenerator(false)).toBeInstanceOf(ScriptedGenerator)
  })
})
