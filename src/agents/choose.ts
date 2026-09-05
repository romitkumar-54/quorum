import { ScriptedGenerator, type QuestionGenerator } from '@/agents'
import { LlmGenerator } from '@/agents/llm'
import { LlmAnalyst } from '@/agents/analyst'
import { LlmFloor, type FloorPicker } from '@/agents/floor'
import { RuleAnalyzer, type Analyzer } from '@/core/brief/analyzer'

/** The three thinking parts of a turn, chosen together. */
export interface Brain {
  analyzer: Analyzer
  floor?: FloorPicker
  generator: QuestionGenerator
}

/**
 * With a key, every stage is a model call and every stage falls back to the
 * deterministic part it replaced. Without one the whole panel is deterministic,
 * which is a working interview — just a less perceptive one.
 */
export function chooseBrain(configured: boolean): Brain {
  if (!configured) {
    return { analyzer: new RuleAnalyzer(), generator: new ScriptedGenerator() }
  }

  return {
    analyzer: new LlmAnalyst({ fallback: new RuleAnalyzer() }),
    floor: new LlmFloor(),
    generator: new LlmGenerator({ fallback: new ScriptedGenerator() }),
  }
}

/** The model when a key exists, the deterministic panel when it does not. */
export function chooseGenerator(configured: boolean): QuestionGenerator {
  return chooseBrain(configured).generator
}
