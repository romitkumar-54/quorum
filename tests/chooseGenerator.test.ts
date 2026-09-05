import { describe, expect, it } from 'vitest'
import { ScriptedGenerator } from '@/agents'
import { chooseBrain, chooseGenerator } from '@/agents/choose'
import { RuleAnalyzer } from '@/core/brief/analyzer'

describe('what still thinks on this side of the channel', () => {
  it('builds the brief with the rule analyser', () => {
    expect(chooseBrain().analyzer).toBeInstanceOf(RuleAnalyzer)
  })

  it('keeps the deterministic generator, which is the fallback and the simulator', () => {
    expect(chooseGenerator()).toBeInstanceOf(ScriptedGenerator)
  })

  it('nominates nobody, because the coordinator decides the floor alone', () => {
    expect(chooseBrain().floor).toBeUndefined()
  })
})
