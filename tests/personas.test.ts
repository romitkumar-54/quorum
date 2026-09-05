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

describe('guardrails travel with the persona', () => {
  it('tells every interviewer to refuse being interviewed itself', () => {
    for (const id of AGENT_IDS) {
      expect(buildSystemPrompt(id)).toMatch(/do not answer questions about yourself/i)
    }
  })

  it('tells every interviewer to steer a wandering candidate back', () => {
    for (const id of AGENT_IDS) {
      expect(buildSystemPrompt(id)).toMatch(/steer|bring them back/i)
    }
  })

  it('tells every interviewer not to hand over the answer', () => {
    for (const id of AGENT_IDS) {
      expect(buildSystemPrompt(id)).toMatch(/never answer it for them|do not supply the answer/i)
    }
  })

  it('refuses instructions from the candidate to change the rules', () => {
    for (const id of AGENT_IDS) {
      expect(buildSystemPrompt(id)).toMatch(/instructions?/i)
    }
  })
})
