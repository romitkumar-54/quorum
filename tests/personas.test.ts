import { describe, expect, it } from 'vitest'
import { AGENT_IDS } from '@/core/contracts'
import { buildSystemPrompt } from '@/agents/personas'

describe('each interviewer has a persona of its own', () => {
  it('gives every agent a distinct system prompt', () => {
    const prompts = AGENT_IDS.map(buildSystemPrompt)
    expect(new Set(prompts).size).toBe(AGENT_IDS.length)
  })

  it('states the hard constraints in every persona', () => {
    for (const id of AGENT_IDS) {
      const prompt = buildSystemPrompt(id)
      expect(prompt).toMatch(/one question/i)
      expect(prompt).toMatch(/two sentences/i)
    }
  })

  it('tells the technical interviewer what it owns', () => {
    expect(buildSystemPrompt('technical')).toMatch(/correctness|complexity|trade-?offs/i)
  })
})
