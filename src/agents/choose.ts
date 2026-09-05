import { ScriptedGenerator, type QuestionGenerator } from '@/agents'
import type { FloorPicker } from '@/agents/floor'
import { RuleAnalyzer, type Analyzer } from '@/core/brief/analyzer'

/** The thinking parts of a turn that still run on this side of the channel. */
export interface Brain {
  analyzer: Analyzer
  floor?: FloorPicker
  generator: QuestionGenerator
}

/**
 * Every model in this project is Agora-managed and runs inside an agent, so
 * there is no longer a choice to make here.
 *
 * What is left is deliberate rather than leftover. `RuleAnalyzer` builds the
 * brief — claims, flags, difficulty — which is what the coordinator ranks bids
 * on, and none of that involves a model. `ScriptedGenerator` is the line an
 * agent gets when Agora does not answer in time, and the one the simulated
 * transport voices when there are no credentials at all.
 *
 * `floor` is left undefined: nominating a speaker needed a model in this
 * process, and the coordinator now decides alone.
 */
export function chooseBrain(): Brain {
  return { analyzer: new RuleAnalyzer(), generator: new ScriptedGenerator() }
}

/** The deterministic panel, which is now the only one this process runs. */
export function chooseGenerator(): QuestionGenerator {
  return chooseBrain().generator
}
